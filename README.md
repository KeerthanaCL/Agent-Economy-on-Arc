# Agent Research Desk

A multi-agent research system where **two LLMs from different providers pay each other in USDC** on Arc testnet for every piece of work. One user question settles as **4 sub-cent nanopayments** across a 3-tier agent hierarchy.

> **Tracks:** Per-API Monetization Engine + **Agent-to-Agent Payment Loop**
> **Partner challenges:** Gemini (Google) · AI/ML API (unified gateway)
> **Stack:** Arc L1 (chain `5042002`) · USDC · Circle Gateway Nanopayments (x402) · FastAPI · Node/Express · TypeScript · Streamlit

---

## The thesis

APIs, agents, and machines need to exchange value **per-request**, in real time, at sub-cent cost. Traditional rails don't allow this:

| Rail | Floor per $0.001 API call | Viable? |
|---|---|---|
| Stripe (cards) | $0.30 + 2.9% | No — 300× the item price |
| PayPal micropayments | $0.05 + 5% | No — 50× the item price |
| Ethereum L1 gas | $2–$10 per tx | No — gas dwarfs payment |
| Arbitrum / Base L2 | $0.001–$0.01 | Marginal; eats all margin |
| **Arc + Circle Nanopayments (x402)** | **gas-free, off-chain batched** | **Yes — per-call pricing is the product** |

Circle Gateway holds a pool of deposited USDC per buyer; nanopayments are off-chain signed authorizations verified and batched by Circle. Sub-cent pricing isn't a curiosity — it's the only way to align an API's revenue with its actual unit of work (one request, one ms of compute, one scored event). Every other rail forces subscriptions or batching, which breaks the agent economy: an autonomous agent can't sign up for 50 SaaS subscriptions to answer one question.

## What it does

Four independent services compose into a 3-tier payment hierarchy. A user's natural-language question settles as an agent economy in miniature.

```
                            ┌──────────────────┐
                            │ Streamlit UI     │
                            │ (Python, :8501)  │
                            └────────┬─────────┘
                                     │ POST /ask
                                     ▼
                            ┌──────────────────┐
                            │ Research agent   │
                            │ (Node, :9000)    │
                            │ LLM: gpt-4o-mini │
                            │ via AI/ML API    │
                            └────────┬─────────┘
                                     │  $0.02 per call (Circle Gateway)
                                     ▼
                            ┌──────────────────┐
                            │ Analyst agent    │
                            │ (Node, :8001)    │
                            │ LLM: gemini-2.5  │
                            │ via AI/ML API    │
                            └────────┬─────────┘
                                     │  $0.001–$0.005 per call
                          ┌──────────┴──────────┐
                          ▼                     ▼
                 ┌──────────────────┐  ┌──────────────────┐
                 │ Paid APIs        │  │ (more endpoints  │
                 │ (Node, :8000)    │  │  can plug in)    │
                 │ /price    $0.001 │  └──────────────────┘
                 │ /sentiment $.002 │
                 │ /news     $0.005 │
                 └──────────────────┘
```

Every payment settles on Arc via **Circle Gateway testnet facilitator** (`https://gateway-api-testnet.circle.com`). The research agent and the analyst agent each hold their own programmable USDC balance, they sign EIP-3009 payment authorizations against the Gateway contract, and Circle batches them on-chain.

### What one question looks like

User asks: *"Give me a full analyst report on ETH with a rating."*

1. Streamlit forwards the question to the research agent.
2. Research agent (GPT-4o-mini) decides the right tool is `get_deep_analysis` → pays $0.02 to the analyst.
3. Analyst agent (Gemini 2.5 Flash) decides it needs price + sentiment + news → pays $0.001 + $0.002 + $0.005 = $0.008 to the base APIs.
4. Analyst synthesizes a 2-sentence note + BULLISH/NEUTRAL/BEARISH rating, returns to the research agent.
5. Research agent formats the final cited answer for the user.

**Result: 4 sub-cent settlements, 2 LLM providers, 1 user turn — for a total cost of $0.028.**
Analyst earned $0.02, spent $0.008, kept $0.012 margin.

## Why this can only exist on Arc + Nanopayments

| Without Arc + Nanopayments | With Arc + Nanopayments |
|---|---|
| Each agent would need credit-card billing → $0.30 minimum fee = 15× the item price | $0.02 settlement, ~zero fee |
| Agents would need Stripe accounts, KYC, merchant onboarding | Agents just need an EOA + a Gateway deposit |
| Agent-to-agent commerce blocked: no 2-year-old can sign up for PayPal | Agent signs EIP-3009, pays instantly |
| Sub-cent prices impossible: you'd lose money on every call | Pricing can match actual unit of work |
| Revenue accrues to middleman card networks | Revenue accrues to merchant wallets |

## Hackathon compliance

| Requirement | How we meet it |
|---|---|
| Real per-action pricing ≤ $0.01 | `$0.001` / `$0.002` / `$0.005` raw calls, `$0.02` analyst (still sub-cent per downstream hop) |
| 50+ on-chain settlements | `npm run seed -- 60` fires 60 paid calls through Circle Gateway; tx hashes logged to `tx_log.jsonl` |
| Margin explanation | See "Why this can only exist on Arc + Nanopayments" and the rail comparison above |
| Settles on Arc | `ARC_NETWORK=eip155:5042002` confirmed in every tx; Circle Gateway testnet facilitator at `gateway-api-testnet.circle.com` |
| Uses USDC | Sole payment asset; USDC is the native gas token on Arc |
| Uses Circle Nanopayments | `@circle-fin/x402-batching` middleware (server) + `GatewayClient` (buyer) for all payments |
| Gemini partner challenge | Gemini 2.5 Flash drives the analyst agent's synthesis (via AI/ML API) |
| AI/ML API partner challenge | Both agents route through AI/ML API's unified gateway on the $10 promo credit |
| Circle Wallets (recommended) | Circle developer-controlled wallet registered with entity secret; API key wired in `scripts/setup_wallets.py` |

## Layout

```
server-ts/            Paid APIs (port 8000)
    server.ts           Express + createGatewayMiddleware for 3 endpoints
analyst-ts/           Analyst agent (port 8001)
    analyst.ts          Both seller (gateway middleware) AND buyer (GatewayClient)
agent-ts/             Research agent (port 9000)
    agent.ts            AI/ML API chat-completions with tool calling
    deposit.ts          One-off: fund the Gateway balance
    balance.ts          Check wallet + Gateway balances
    seed.ts             Fire a batch of paid calls for demo proof
    check_tx.ts         Look up an Arc tx receipt
app.py                Streamlit UI: chat + live tx log with caller badges
scripts/
    setup_wallets.py    Generate EOAs + Circle Wallets
    make_entity_secret.py  Generate + register Circle entity secret
tx_log.jsonl          Append-only settlement log (git-ignored)
.env.example          Template for all env vars
```

## Setup (≈15 minutes end-to-end)

### Prerequisites
- Python 3.12+ and Node 20+
- Circle developer account (free): https://console.circle.com
- Google AI Studio key: https://aistudio.google.com
- AI/ML API key (free $10 credit via hackathon promo)
- ~20 USDC on Arc testnet (see faucet step)

### 1. Clone & install
```bash
git clone <this-repo>
cd Agent_Economy_on_Arc
cp .env.example .env

# Python (Streamlit + wallet setup scripts)
python -m venv venv && .\venv\Scripts\activate   # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt

# Node services (three separate installs)
cd server-ts && npm install && cd ..
cd agent-ts && npm install && cd ..
cd analyst-ts && npm install && cd ..
```

### 2. Fill `.env` with your keys
Edit `.env` and fill:
- `AIML_API_KEY` — from https://aimlapi.com
- `GEMINI_API_KEY` — from https://aistudio.google.com (not required if you exclusively use AI/ML API, but kept for flexibility)
- `CIRCLE_API_KEY` — from Circle console (use the full `TEST_API_KEY:...` prefix)

### 3. Register Circle entity secret (one time)
```bash
pip install cryptography requests python-dotenv
python scripts/make_entity_secret.py
```
Copy the printed **ciphertext** into Circle console (Developer Controlled Wallets → Configurator → Entity Secret Ciphertext → Register), then paste the printed **64-char hex** into `CIRCLE_ENTITY_SECRET` in `.env`.

### 4. Generate wallets
```bash
python scripts/setup_wallets.py
```
Copy the printed `AGENT_PRIVATE_KEY`, `AGENT_ADDRESS`, `MERCHANT_*_ADDRESS` block into `.env`. Also set `MERCHANT_ANALYST_ADDRESS=<same as MERCHANT_NEWS_ADDRESS>` (demo shortcut — any valid EOA works).

### 5. Fund the agent wallet
Go to https://faucet.circle.com → **Arc Testnet** → paste `AGENT_ADDRESS` → request USDC. 10 USDC covers thousands of paid calls.

### 6. Deposit USDC into Gateway (one-time)
```bash
cd agent-ts
npm run deposit -- 2
```
Waits for Circle's indexer (30–60s), then the agent's Gateway balance shows 2 USDC. This is what funds every subsequent payment across both agents (they share the same private key / Gateway balance).

### 7. Start all four services
Open 4 terminals:

```bash
# Terminal 1 — paid APIs (:8000)
cd server-ts && npm run dev

# Terminal 2 — analyst agent (:8001)
cd analyst-ts && npm run dev

# Terminal 3 — research agent (:9000)
cd agent-ts && npm run dev

# Terminal 4 — Streamlit UI (:8501)
.\venv\Scripts\activate
streamlit run app.py
```

Each service should print a `[ok] ... listening on ...` line.

### 8. Try it
Open http://localhost:8501 and ask:
- *"What's BTC at?"* → 1 settlement
- *"How is ETH doing?"* → 2-3 settlements
- *"Give me a full analyst report on SOL with a rating"* → **4 settlements** (the A2A loop)

## Generate 50+ on-chain transactions (submission proof)

```bash
cd agent-ts
npm run seed -- 60
```

Fires 60 paid calls through Circle Gateway. Hashes appear in `tx_log.jsonl` and (after Circle's indexer) on the Arc explorer at `https://explorer.testnet.arc.network/tx/<hash>`.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run balance` (in `agent-ts/`) | Wallet USDC + Gateway balances |
| `npm run check -- 0x<tx>` (in `agent-ts/`) | Look up an Arc receipt by hash |
| `npm run deposit -- 5` (in `agent-ts/`) | Top up the Gateway balance |
| `streamlit run app.py` | UI on :8501 |

## Production evolution (what we'd ship next)

- Swap the local EOA signer for a Circle Wallets `signTypedData` adapter so both agents are fully custodial-safe.
- Add per-session budgets and a reputation layer (ERC-8004-style) so the research agent can choose between competing analysts by price × trust.
- Replace the mock endpoint data with real upstream providers, wrapping each as a priced facade — turning any existing API into a pay-per-call one.
- Use Circle Gateway's cross-chain feature so agents can pay from any chain's USDC balance automatically.

## Feedback

See `FEEDBACK.md` — submitted for the $500 product feedback prize. Written from the perspective of a 24-hour solo build on Windows.
