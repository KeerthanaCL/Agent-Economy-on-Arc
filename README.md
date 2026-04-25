# Agent Research Desk

> A multi-agent research **marketplace** where two LLMs from different providers compete to sell synthesis to a third LLM, all paying each other in USDC on Arc testnet. Includes a live trust-decay demonstration: an intentionally misbehaving analyst loses business to its honest competitor as the buyer's reputation system catches the cheating in real time. Built for the *Agentic Economy on Arc* hackathon (April 2026).

> **Tracks targeted:** Per-API Monetization Engine + **Agent-to-Agent Payment Loop**
> **Partner challenges:** Gemini (Google) + AI/ML API (unified gateway)
> **Stack:** Arc L1 (chain `5042002`) · USDC · Circle Gateway Nanopayments (x402) · Node/Express · TypeScript · Streamlit · Python

---

## Table of contents

1. [The problem this solves](#the-problem-this-solves)
2. [The thesis](#the-thesis)
3. [Architecture](#architecture)
4. [Each service explained](#each-service-explained)
5. [What one user question looks like](#what-one-user-question-looks-like-step-by-step)
6. [The marketplace picker (math + behaviour)](#the-marketplace-picker-math--observed-behaviour)
7. [The adversarial demo](#the-adversarial-demo-proving-trust-catches-cheating)
8. [Budget guardrails](#budget-guardrails)
9. [Trust scoring rules](#trust-scoring-rules)
10. [Hackathon compliance checklist](#hackathon-compliance-checklist)
11. [File layout](#file-layout)
12. [Setup (≈20 minutes)](#setup-20-minutes)
13. [Demos to run](#demos-to-run)
14. [Streamlit prompts](#streamlit-prompts-suggested)
15. [Useful commands](#useful-commands)
16. [Production evolution](#production-evolution-what-wed-ship-next)
17. [Glossary](#glossary)
18. [Feedback](#feedback)

---

## The problem this solves

Today, software components — APIs, AI agents, automated bots — cannot exchange value with each other in real time at the *unit of work* (one request, one millisecond of compute, one prediction, one synthesis). Card networks impose a $0.30 minimum fee. PayPal demands KYC and a merchant account. Crypto L1s charge $2–10 in gas per transfer. As a result, every machine-to-machine business model collapses into either: (a) a monthly subscription with batched access, or (b) a single trusted custodial intermediary holding everyone's money.

Both are wrong for autonomous agents. An autonomous agent answering a single user question may need to consult five APIs from five different providers it has never paid before. It cannot sign up for five subscriptions. It cannot pre-approve five custodians. It cannot wait for KYC. **It just needs to pay $0.005 here, $0.020 there, settle in two seconds, and move on.**

That's what Arc + Circle Nanopayments + x402 unlocks. This project is a working demonstration that, given those primitives, you can build something even more ambitious: not just per-call APIs, but a *market* of competing service providers where buyers route around bad actors using on-chain reputation, all in real time, all sub-cent.

## The thesis

A real agent economy needs three primitives:

1. **Sub-cent settlement** so per-call pricing is viable.
2. **Programmable identity** so any wallet can be a merchant.
3. **Trust signals** so buyers can route around bad actors without a referee.

Why Arc + Nanopayments uniquely deliver all three:

| Rail | Floor per $0.001 API call | Programmable identity? | Programmable trust? |
|---|---|---|---|
| Stripe (cards) | $0.30 + 2.9% | No — KYC required | Centralized chargebacks |
| PayPal micropayments | $0.05 + 5% | No — account required | Centralized disputes |
| Ethereum L1 gas | $2–$10 per tx | Yes (EOA) | DIY onchain |
| Arbitrum / Base L2 | $0.001–$0.01 | Yes (EOA) | DIY onchain |
| **Arc + Circle Nanopayments (x402)** | **gas-free, off-chain batched** | **Yes (any EOA)** | **Buyer-defined off-chain (this project) or onchain (future)** |

Sub-cent USDC nanopayments turn buyers into market participants instead of subscribers. They can shop, switch, and punish — exactly like humans do in mature markets, but at machine speed.

## Architecture

Five independent services compose into a 4-tier marketplace.

```
                            ┌──────────────────┐
                            │ Streamlit UI     │
                            │ (Python, :8501)  │
                            └────────┬─────────┘
                                     │ POST /ask  +  GET /trust
                                     ▼
                ┌─────────────────────────────────────────────────┐
                │ Research agent  (Node, :9000)                   │
                │   LLM: gpt-4o-mini (OpenAI) via AI/ML API       │
                │   - Per-question spending budget ($0.05 cap)    │
                │   - Sanity-check + persistent trust scoring     │
                │   - Marketplace picker: argmax(trust / price)   │
                └────┬─────────────────────────────────────────┬──┘
                     │ $0.020 (gemini)                  $0.030 │ (premium)
                     ▼                                         ▼
           ┌──────────────────┐                       ┌──────────────────┐
           │ Analyst A        │                       │ Analyst B        │
           │ (Node, :8001)    │                       │ (Node, :8002)    │
           │ "gemini" tier    │                       │ "premium" tier   │
           │ LLM: gemini-2.5  │                       │ LLM: gpt-4o-mini │
           │ via AI/ML API    │                       │ via AI/ML API    │
           │ ⚠️ BAD_RATE=0.4  │                       │ BAD_RATE=0.0     │
           └────────┬─────────┘                       └─────────┬────────┘
                    │                                           │
                    └──────────────────┬────────────────────────┘
                                       │ $0.001 / $0.002 / $0.005 per call
                                       ▼
                              ┌──────────────────┐
                              │ Paid APIs        │
                              │ (Node, :8000)    │
                              │ /price    $0.001 │
                              │ /sentiment $.002 │
                              │ /news     $0.005 │
                              └──────────────────┘
```

Every payment settles on Arc via Circle's x402 facilitator at `https://gateway-api-testnet.circle.com`. Each agent holds its own programmable USDC balance (via `@circle-fin/x402-batching`'s `GatewayClient`), signs an EIP-3009 payment authorization against the GatewayWallet contract, and Circle batches them on-chain. **No intermediary, no card network, no merchant onboarding.**

## Each service explained

### Tier 0: Paid APIs (`server-ts/`, port 8000)
Three mock data endpoints, each gated by Circle's x402 middleware. The endpoints are intentionally simple so the demo focuses on payment economics, not data fidelity:

| Endpoint | Price | Returns |
|---|---|---|
| `GET /price?ticker=ETH` | $0.001 | `{ ticker, price_usd, ts }` (mock random walk around a base) |
| `GET /sentiment?topic=BTC` | $0.002 | `{ topic, score, label, ts }` (random in [-1, 1]) |
| `GET /news?query=USDC&limit=3` | $0.005 | `{ query, items[], ts }` (synthesized headlines) |

Each route is registered with its own merchant address via `createGatewayMiddleware({ sellerAddress, networks: ["eip155:5042002"], facilitatorUrl })`. When an unpaid request hits a route, the middleware emits HTTP 402 with payment requirements in a `PAYMENT-REQUIRED` response header (Circle's slight deviation from the generic x402 spec — see FEEDBACK.md). The buyer signs an EIP-712 typed-data message authorising the transfer, retries with the signed payload in `payment-signature`, the middleware verifies and settles with Circle's facilitator, and the route handler runs. End-to-end ~1–2 s per call.

### Tier 1: Analyst marketplace (`analyst-ts/` :8001 + `analyst2-ts/` :8002)
Two services with **identical interfaces** but different prices, models, and reliability profiles:

| | Analyst A — "gemini" tier | Analyst B — "premium" tier |
|---|---|---|
| Port | 8001 | 8002 |
| Price | $0.020 per `/synthesis` | $0.030 per `/synthesis` |
| LLM | `google/gemini-2.5-flash` (via AI/ML API) | `gpt-4o-mini` (via AI/ML API) |
| Behaviour | 40% chance of misbehaving (returns junk, skips downstream) | Always honest |
| Output style | 2-3 sentence note + rating | 4-5 sentence detailed note + rating |

Both services are simultaneously **sellers** (they expose `/synthesis` gated by Circle's middleware) **and buyers** (they hit the Tier 0 paid APIs via Circle's `GatewayClient`). They share the agent's wallet for the buyer role to keep the demo simple — production would give each a separate wallet.

When Analyst A "misbehaves" (40% of calls), it:
1. **Still collects the $0.02 payment** (the x402 handshake completes before the route handler runs).
2. **Skips the $0.008 in downstream API calls** — pure profit on garbage.
3. **Returns `{ report: "N/A", citations: null }`** — both fields fail the buyer's sanity rules.

This is what an actual adversarial provider in a marketplace would do. The point of the demo is to show that the buyer's trust system catches it.

### Tier 2: Research agent (`agent-ts/`, port 9000)
The customer-facing agent. It exposes `POST /ask { question }` and returns `{ answer, toolCalls, spend }`.

It is, simultaneously:
- An **LLM agent** with tool calling (gpt-4o-mini via AI/ML API).
- A **buyer** that pays per tool call with `GatewayClient`.
- A **market participant** that maintains its own trust scores per provider and routes by `argmax(trust_score / price)`.
- A **financial steward** that enforces a `MAX_SPEND_USD` budget per question and refuses tool calls that would exceed it.

Available tools (declared as OpenAI-style function schemas):
- `get_price(ticker)` — calls `/price`, $0.001
- `get_sentiment(topic)` — calls `/sentiment`, $0.002
- `get_news(query, limit?)` — calls `/news`, $0.005
- `get_deep_analysis(ticker)` — picks an analyst, pays $0.020 or $0.030

Also exposes utility endpoints: `GET /health`, `GET /trust` (current trust store), `GET /analysts` (current marketplace state with prices and trust).

### Tier 3: Streamlit UI (`app.py`, port 8501)
The human entry point. Pure presentation — all economic logic lives in the Node services. Reads `tx_log.jsonl` and `trust.json` directly so it can show shared state without re-querying the agent.

Layout:
- **Left column**: chat. Each assistant reply gets a spend-progress bar (with red ⚠️ if budget exhausted) and a tool-call expander showing the raw function calls + results (including `_market.picked` for analyst calls and `_misbehaving: true` when caught).
- **Right column**: live tx log + trust scores + totals. Each tx line shows a 🟢/🟡/🔴 trust badge per endpoint, the provider tag (`→ gemini` or `→ premium`), and a clickable Arc explorer link.

## What one user question looks like (step by step)

User asks in Streamlit: *"Give me a full analyst report on ETH with a rating."*

1. **Streamlit** POSTs `{ question: "..." }` to `http://localhost:9000/ask`.
2. **Research agent** sends the question + system instruction + 4 tool schemas to AI/ML API (`gpt-4o-mini`).
3. **gpt-4o-mini** decides this is a deep-analysis request and returns a `tool_calls: [{ name: "get_deep_analysis", arguments: { ticker: "ETH" } }]`.
4. **Research agent** invokes the marketplace picker: it loads `trust.json`, computes `score = trust / (price × 1000)` for each analyst, sorts, and picks the highest. With both at trust 100, gemini wins ($0.020 < $0.030 → higher score).
5. **Research agent** calls `gateway.pay("http://localhost:8001/synthesis?ticker=ETH")`. The `GatewayClient`:
   - Fires the GET, gets HTTP 402 + `PAYMENT-REQUIRED` header.
   - Decodes the requirements (amount $0.020, payTo Analyst A's wallet, EIP-712 domain `GatewayWalletBatched`, verifyingContract Circle's wallet).
   - Signs the typed data with the agent's local EOA key.
   - Retries with `payment-signature: <base64-payload>`.
6. **Analyst A's middleware** receives the retry, calls Circle's facilitator `/v1/x402/verify`, then `/v1/x402/settle`. Settlement returns a transaction ID. The route handler runs.
7. **Analyst A** decides whether to misbehave (40% RNG check). If yes: returns garbage + skips step 8. If no: continues.
8. **Analyst A** uses its own `GatewayClient` instance (sharing the same wallet) to pay all three Tier 0 APIs in parallel: `/price`, `/sentiment`, `/news`. Each is its own x402 handshake — three separate Arc settlements happen here.
9. **Analyst A** prompts gemini-2.5-flash via AI/ML API with the three datasets, gets back a 2-sentence note + rating, returns `{ ticker, report, model, citations, ... }` to the research agent.
10. **Research agent** runs sanity checks on the response: `report` must be ≥10 chars; `citations` must be a non-null object. If violation → trust score for `/synthesis@gemini` drops by 10 in `trust.json`.
11. **Research agent** appends a tx log entry with `caller: "research"`, `path: "/synthesis"`, `provider: "gemini"`, `tx_hash: <Circle settlement ID>`, `amount_atomic: 20000`, etc.
12. **Research agent** sends the analyst's response back to gpt-4o-mini, which composes the final user-facing answer citing specific numbers and the BULLISH/NEUTRAL/BEARISH rating.
13. **Research agent** returns `{ answer, toolCalls, spend: { total_usd: 0.020, budget_usd: 0.05, pct: 40, exhausted: false } }` to Streamlit.
14. **Streamlit** renders the answer, a 40% spend progress bar, and the tool-call expander. The right panel auto-refreshes from `tx_log.jsonl` to show all 4 settlements: 1 from research → analyst, plus 3 from analyst → base APIs.

**Total: 4 sub-cent settlements, 2 LLM providers, 1 user turn, ~10 seconds.**

## The marketplace picker (math + observed behaviour)

The picker is a one-liner: `argmax(trust_score / price)`. The intuition is "trust per dollar". A 100-trust analyst at $0.030 is worse than a 60-trust analyst at $0.015 because the latter delivers more expected value per dollar spent.

With both analysts starting at trust 100:

| Analyst | Trust | Price | `trust / (price × 1000)` |
|---|---|---|---|
| gemini | 100 | $0.020 | **5.000** ← winner |
| premium | 100 | $0.030 | 3.333 |

Gemini wins consistently. After it misbehaves enough to drop to trust 60:

| Analyst | Trust | Price | `trust / (price × 1000)` |
|---|---|---|---|
| gemini | 60 | $0.020 | 3.000 |
| premium | 100 | $0.030 | **3.333** ← winner now |

The marketplace flips. From this point onwards, premium wins until either (a) it misbehaves and decays, or (b) gemini's slow `+1 per 5 calls` recovery brings it back over the threshold.

Observed in `npm run marketplace -- 20 --reset`:

```
│  1/20  │ BTC   │ gemini   │   100  │ $0.020 │ ⚠️  junk  │  4.8s
│  2/20  │ ETH   │ gemini   │    90  │ $0.020 │ ⚠️  junk  │  3.7s
│  3/20  │ SOL   │ gemini   │    80  │ $0.020 │           │ 10.9s
│  4/20  │ USDC  │ gemini   │    80  │ $0.020 │ ⚠️  junk  │  4.4s
│  5/20  │ BTC   │ gemini   │    70  │ $0.020 │ ⚠️  junk  │  8.9s
│  6/20  │ ETH   │ premium  │   100  │ $0.030 │           │ 11.7s   ← FLIPPED
│  ...   │ ...   │ premium  │   100  │ $0.030 │           │  ...
```

Five calls in, four misbehaviors caught, gemini's trust at 60, premium takes over on call 6. **Without any human intervention, without any centralized referee, just a buyer agent enforcing its own rule.**

## The adversarial demo (proving trust catches cheating)

A reputation system is only as good as the cheating it catches. To prove this one works, Analyst A is configured with `ANALYST_A_BAD_RATE=0.4`. On 40% of `/synthesis` calls, it:

1. Accepts the $0.020 payment via Circle Gateway (handshake completes before our handler runs).
2. **Skips** all three downstream paid API calls (saves $0.008).
3. Returns `{ ticker, report: "N/A", model, tier, price_usd, citations: null, _misbehaving: true }`.

The research agent's sanity check inspects every paid response:

| Endpoint | Sanity rule | Misbehaving response | Detected? |
|---|---|---|---|
| `/price` | `0.01 < price_usd < 1_000_000` | (we don't misbehave on these) | n/a |
| `/sentiment` | `score in [-1, 1]` | n/a | n/a |
| `/news` | `items` is non-empty array | n/a | n/a |
| `/synthesis` | `report.length ≥ 10` AND `citations` is non-null object | `report = "N/A"` (3 chars) AND `citations = null` | **Yes — both** |

A single violation drops the score by 10. Clean calls slowly rebuild (+1 per 5 clean calls, capped at 100). Decay is fast; recovery is slow — exactly like real-world reputation. Persisted to `trust.json`.

In the marketplace demo above, you can watch this happen in real time. The `⚠️ junk` column tags calls where `_misbehaving: true` was in the response. The trust column ticks down by 10 with each. Once trust crosses the threshold (60 in this configuration), the next call routes to the honest competitor.

This is the *demo of the year* moment: a working marketplace, a real economic incentive to cheat, a buyer agent that catches it, and a competitor that benefits — all on testnet, all in 2 minutes of wall-clock time.

## Budget guardrails

Real autonomous agents need spending limits. Without them, a poorly-prompted query could cost the operator hundreds of dollars in API fees. The research agent enforces `MAX_SPEND_USD` (default $0.050) per `/ask` call:

- Before every tool call, the agent computes `total_spent + tool_cost`.
- If that exceeds the budget, the tool call **doesn't happen**. Instead, the LLM receives a JSON error `{ error: "budget_exhausted", spent_so_far, budget }` as the tool response.
- The LLM then has the system instruction: *"If a tool response includes 'error: budget_exhausted', you MUST stop calling tools and answer with whatever data you've already collected."* This produces a graceful "here's what I covered, here's what I had to skip" answer instead of a hard failure.

The Streamlit UI surfaces this with a coloured progress bar:
- 0–80%: neutral
- ≥100%: red ⚠️ "budget exhausted — agent skipped some tools"

Try the prompt *"I want full deep analyst reports on BTC, ETH, SOL, and USDC."* with the default $0.05 budget — the agent will get through the first 2 reports (≈$0.04) and then refuse, gracefully wrapping up.

## Trust scoring rules

`trust.json` is keyed by endpoint identifier. Raw APIs use the bare path (`/price`, `/sentiment`, `/news`). Analyst providers use `/synthesis@<name>` so each one gets its own score. Each entry tracks:

```json
{
  "/synthesis@gemini": {
    "score": 60,
    "calls": 8,
    "violations": 3,
    "last_violation": "report missing or too short",
    "last_checked": "2026-04-25T01:23:45Z"
  }
}
```

| Event | Score change |
|---|---|
| Sanity check passes | none on a single call; +1 per 5 consecutive clean calls (capped at 100) |
| Sanity check fails | −10 immediately (floored at 0) |

Sanity rules per endpoint type:
- `/price`: `price_usd` must be a finite number in (0.01, 1_000_000).
- `/sentiment`: `score` must be a finite number in [-1, 1].
- `/news`: `items` must be a non-empty array.
- `/synthesis`: `report` must be a string of length ≥ 10, AND `citations` must be a non-null object.

The recovery rate (+1 per 5 clean calls) is deliberately slow — once trust is broken, it should be hard to rebuild. This mirrors human reputation dynamics and creates an asymmetric incentive: it takes ~50 honest calls to recover from one bad streak.

## Hackathon compliance checklist

| Requirement | Implementation |
|---|---|
| Real per-action pricing ≤ $0.01 | `$0.001` (price), `$0.002` (sentiment), `$0.005` (news) — all sub-cent. Analysts at `$0.020` / `$0.030` aggregate sub-cent components. |
| 50+ on-chain settlements | `npm run seed -- 60` fires 60 paid calls; tx hashes appended to `tx_log.jsonl`. The `marketplace_demo` adds another ~80 (20 user calls × 4 settlements each). |
| Margin explanation | See "Why this can only exist on Arc + Nanopayments" earlier and the Stripe-vs-Arc table. Analyst margin per call: $0.020 in − $0.008 out = $0.012 (60% margin), all sub-cent. |
| Settles on Arc | `ARC_NETWORK=eip155:5042002` confirmed on every tx. Tx hashes linkable on `https://explorer.testnet.arc.network`. |
| Uses USDC | Sole payment asset. USDC is the native gas token on Arc, so no separate gas funding needed. |
| Uses Circle Nanopayments | `@circle-fin/x402-batching` (server middleware + `GatewayClient` buyer) for every payment. Facilitator at `gateway-api-testnet.circle.com`. |
| Gemini partner challenge | `google/gemini-2.5-flash` powers Analyst A's synthesis, routed via AI/ML API. |
| AI/ML API partner challenge | All three LLM call sites (research agent + Analyst A + Analyst B) route through AI/ML API on the $10 promo credit. |
| Circle Wallets (recommended) | Circle developer-controlled wallet registered with entity secret; API key wired in `scripts/setup_wallets.py`. |

## File layout

```
server-ts/
  server.ts              Express + 3 paid endpoints + Circle x402 middleware
  package.json           Pinned deps: @circle-fin/x402-batching, @x402/core, @x402/evm, viem
  tsconfig.json          ES2022 + ESNext modules

analyst-ts/              Analyst A — "gemini" tier, port 8001
  analyst.ts             Both seller (createGatewayMiddleware) AND buyer
                         (GatewayClient). Supports BAD_RATE adversarial mode.
  env.ts                 Reads root ../.env
  package.json           Same Circle deps as server-ts

analyst2-ts/             Analyst B — "premium" tier, port 8002
  analyst.ts             Identical structure to analyst-ts, different model + price
  env.ts                 (same)
  package.json           (same)

agent-ts/                Research agent + utility scripts, port 9000
  agent.ts               AI/ML API tool-calling loop, marketplace picker,
                         budget enforcement, trust scoring with persistence
  env.ts                 Shared env loader, normalizes private key (with/without 0x)
  deposit.ts             One-off: approve + deposit USDC into Gateway
  balance.ts             Print wallet USDC + Gateway available/withdrawing
  seed.ts                Fire N raw paid calls in a loop (default 60)
  marketplace_demo.ts    Fire N deep-analysis calls, log picker decisions live
  check_tx.ts            Look up an Arc tx receipt by hash
  package.json           + @types/express, tsx for dev mode

app.py                   Streamlit UI — chat, tx log, trust scores, spend bar
requirements.txt         Streamlit + httpx + dotenv

scripts/
  setup_wallets.py       Generate agent + 3 merchant EOAs; print as .env block.
                         Optionally also tries to create a Circle Wallet.
  make_entity_secret.py  Generate 32-byte entity secret + RSA-OAEP ciphertext
                         for one-time Circle Console registration

tx_log.jsonl             Append-only JSONL settlement log (git-ignored)
trust.json               Per-endpoint trust score store (git-ignored)
.env                     Local secrets (git-ignored)
.env.example             Template — every var with explanatory comments
.gitignore               Comprehensive: secrets, runtime data, node_modules,
                         Circle recovery files, Python/Node caches
README.md                This document
FEEDBACK.md              For the $500 product feedback prize
```

## Setup (≈20 minutes)

### Prerequisites
- Python 3.12+ and Node 20+
- A Circle developer account (free): https://console.circle.com
- An AI/ML API key (free $10 credit via hackathon promo): https://aimlapi.com
- ~20 USDC on Arc testnet (faucet step below)

### 1. Clone and install dependencies
```bash
git clone <this-repo>
cd Agent_Economy_on_Arc
cp .env.example .env

# Python (Streamlit + wallet setup scripts)
python -m venv venv
.\venv\Scripts\activate                              # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt

# Four separate Node services — each has its own node_modules
cd server-ts   && npm install && cd ..
cd analyst-ts  && npm install && cd ..
cd analyst2-ts && npm install && cd ..
cd agent-ts    && npm install && cd ..
```

### 2. Fill `.env` with your keys
Open `.env` and paste:
- `AIML_API_KEY` — from https://aimlapi.com
- `CIRCLE_API_KEY` — from Circle console (full string with the `TEST_API_KEY:` prefix)
- (`GEMINI_API_KEY` is unused now but kept for flexibility)

### 3. Register a Circle entity secret (one time)
The Circle Wallets API requires a 32-byte entity secret encrypted to Circle's RSA public key, then registered in your Circle Console once. There is no UI generator — we provide one:

```bash
pip install cryptography requests python-dotenv
python scripts/make_entity_secret.py
```

The script prints two strings:
- **Ciphertext** (base64 blob, ends in `=`) → paste into Circle Console → Developer Controlled Wallets → Configurator → Entity Secret Ciphertext → click Register.
- **64-character hex** → paste into `CIRCLE_ENTITY_SECRET` in `.env`. Save a copy of the hex separately as a backup; if you lose it you must re-register.

### 4. Generate wallets
```bash
python scripts/setup_wallets.py
```

Generates an agent EOA (used for signing all payments) and three merchant EOAs (one per paid API). Prints them as a ready-to-paste `.env` block. Copy it in. Also set `MERCHANT_ANALYST_ADDRESS` and `MERCHANT_ANALYST_B_ADDRESS` (any of the existing merchant addresses works — these only receive payments and never sign).

### 5. Fund + deposit
- Go to https://faucet.circle.com → select **Arc Testnet** → paste `AGENT_ADDRESS` → request USDC. 10 USDC is plenty.
- The agent needs USDC inside Circle Gateway, not just on Arc. One-time deposit:

```bash
cd agent-ts
npm run deposit -- 2
```

This issues two on-chain transactions: first an `approve(GatewayWallet, 2 USDC)` on the Arc USDC contract, then a `deposit(2 USDC)` on the Gateway contract. Wait ~30–60 s for Circle's indexer to reflect the new balance, then `npm run balance` should show:
```
Wallet USDC:   17.99... (was 20, less the deposit + tiny gas)
Gateway total: 2.0
  available:   2.0
```

### 6. Start all five services
Open 5 terminal windows. Each one should print a `[ok] ... listening on ...` line:

```bash
# T1 — paid APIs (:8000)
cd server-ts && npm run dev

# T2 — analyst A (gemini tier, :8001) — adversarial 40% bad rate
cd analyst-ts && npm run dev

# T3 — analyst B (premium tier, :8002) — clean
cd analyst2-ts && npm run dev

# T4 — research agent (:9000) — orchestrator
cd agent-ts && npm run dev

# T5 — Streamlit UI (:8501)
.\venv\Scripts\activate
streamlit run app.py
```

The research agent's startup log will show the marketplace registry. Analyst A's startup log will warn `⚠️ BAD_RATE: 40% — this analyst misbehaves intentionally`.

## Demos to run

### Submission requirement: 50+ on-chain settlements
```bash
cd agent-ts
npm run seed -- 60
```
Fires 60 raw paid calls (no LLM, no quota concerns) in a loop. ~3 minutes. Each settles on Arc; hashes appended to `tx_log.jsonl`. Inspect them with `npm run check -- 0x<hash>` or visit `https://explorer.testnet.arc.network/tx/<hash>`.

### The headline demo: live marketplace flip
```bash
cd agent-ts
npm run marketplace -- 20 --reset
```
Runs 20 deep-analysis questions in sequence and prints a compact picker log. With `--reset`, both analysts start at trust 100. Watch the picker flip from `gemini` to `premium` around row 6–9 as gemini's trust decays from misbehaviour. **This is your demo-video money shot.**

### Streamlit interactive demo
Open http://localhost:8501 and try the prompts in the next section.

## Streamlit prompts (suggested)

Designed to exercise every feature with one question each:

| # | Prompt | What it shows |
|---|---|---|
| 1 | "Explain in one sentence how Circle Nanopayments work." | 0 settlements — agent doesn't pay when it doesn't need to. Spend bar at 0%. |
| 2 | "What's BTC trading at?" | 1 settlement (`get_price`, $0.001). Tx log gains one row. |
| 3 | "How is ETH doing today — price, sentiment, top headlines?" | 3 settlements (fan-out across raw tools). |
| 4 | "Get a deep analyst report on USDC. Tell me which analyst was used and what its trust score was." | 4 settlements; picker decision surfaces in the answer text. |
| 5 | "Get me deep analyst reports for BTC and ETH back to back." | 8 settlements; ~40% chance of catching `_misbehaving: true` in one of the tool-call expanders. |
| 6 | "I want full deep analyst reports on BTC, ETH, SOL, and USDC." | Budget exhausted — red ⚠️ badge appears, agent gracefully wraps up with partial coverage. |
| 7 | "Quick price check on BTC, then a deep analysis on ETH." | Mixes raw + analyst — different caller badges in tx log. |
| 8 | "Run the deep analyst on SOL, then on BTC, then on ETH." | Three deep analyses; if any misbehave you'll see trust drop in the right panel between calls. |

## Useful commands

| Command | Purpose |
|---|---|
| `npm run balance` (in `agent-ts/`) | Show wallet USDC + Gateway balances |
| `npm run check -- 0x<hash>` (in `agent-ts/`) | Look up an Arc tx receipt |
| `npm run deposit -- 5` (in `agent-ts/`) | Top up the Gateway balance |
| `npm run seed -- 60` (in `agent-ts/`) | Fire 60 raw paid calls (50+ tx requirement) |
| `npm run marketplace -- 20 --reset` (in `agent-ts/`) | Picker-flip demo |
| `streamlit run app.py` | UI on :8501 |
| `curl http://localhost:9000/health` | Research agent status |
| `curl http://localhost:9000/analysts` | Marketplace state (price + trust per provider) |
| `curl http://localhost:9000/trust` | Raw trust-score JSON |

## Production evolution (what we'd ship next)

These are the specific extensions we'd build to take this from a hackathon demo to a real product:

1. **Quality bonds (escrow)**. Today the misbehaving analyst keeps the $0.020 of garbage; the trust score reduces *future* revenue but doesn't claw back the bad call. A first-class "stake-on-call" primitive in Circle Gateway — refundable on success, burned on sanity-check failure — closes the loop and makes reputation economically self-enforcing. This is the most interesting unsolved problem in the agent economy today.
2. **Onchain reputation registry (ERC-8004)**. Move trust scores onchain so they're portable across projects. New buyers entering a market can read a provider's history without burning N transactions to learn it themselves.
3. **Circle Wallets `signTypedData` adapter for `x402Client`**. Today the buyer signs with a local EOA. A drop-in `CircleWalletSigner({ walletId })` would make agent custody fully managed.
4. **Dynamic pricing**. Analysts surge-price during demand spikes and discount on volume. The marketplace picker already handles this — providers just need to expose their current price via `/info` so the picker can refresh on each call.
5. **Cross-chain Gateway**. Buyer pays from any chain's USDC balance automatically. Circle Gateway's batching is already cross-chain capable; the picker just needs to factor source-chain availability into routing.
6. **Two-sided trust**. Analysts also rate the buyer (e.g. flag spam-y or impossible queries). Bidirectional reputation reduces dispute rates.
7. **Real data wiring**. Replace the mock `/price` `/sentiment` `/news` endpoints with thin facades over CoinGecko, Alternative.me, NewsAPI, etc. The economic structure carries over verbatim.

## Glossary

- **Arc** — Circle's purpose-built EVM-compatible Layer-1 where USDC is the native gas token. Chain ID `5042002` (testnet).
- **x402** — open HTTP-native payment protocol: server returns 402 with payment requirements, buyer signs and retries, gateway settles. Coinbase-led.
- **Circle Gateway** — Circle's non-custodial unified-balance product. Buyers deposit USDC once, then sign off-chain payment authorisations against their Gateway balance. Settlements are batched on-chain.
- **Circle Nanopayments** — Circle's product name for Gateway + x402 wrapped together for sub-cent payments. Gas-free for the buyer.
- **EIP-3009** — Ethereum standard for `transferWithAuthorization`: a signed authorization that lets a third party submit a transfer on the signer's behalf. Used inside Circle's payment payloads.
- **EIP-712** — Ethereum standard for typed-data signing. Circle's batched payments are EIP-712 messages whose `domain.verifyingContract` is the GatewayWallet (not USDC).
- **Facilitator** — server-side x402 verifier/settler. We use Circle's at `gateway-api-testnet.circle.com`. Coinbase runs another at `x402.org/facilitator` (Base + Solana only).
- **Sanity check** — a synchronous, type-and-range validator the buyer applies to every paid response before trusting it.
- **Trust score** — buyer-local reputation per endpoint, 0–100, decays on sanity-check failures.

## Feedback

See `FEEDBACK.md` — submitted for the $500 product feedback prize. Written from the perspective of a 24-hour solo build on Windows, including the specific friction points that cost us hours and the highest-leverage fixes Circle could ship.
