# Agent Research Desk

A Gemini-powered research agent that **pays per API call in USDC on Arc testnet** via the x402 standard. One user question fans out to multiple paid micro-APIs, aggregates the results, and returns a cited answer — every tool call settles on-chain as a sub-cent USDC payment.

> **Tracks:** Per-API Monetization Engine + Agent-to-Agent Payment Loop
> **Tech:** Arc L1 (chain `5042002`), USDC, x402 / Circle Nanopayments, Gemini 2.5 Flash, Circle Wallets, Python

---

## Why this can only exist on Arc + Nanopayments

This demo ships 60+ on-chain USDC settlements for a total spend under **$0.20**. The same flow is economically impossible on traditional rails:

| Rail | Fee per $0.001 API call | Viable? |
|---|---|---|
| Stripe card payments | **$0.30 + 2.9%** fixed fee | No — 300× the item price |
| PayPal micropayments | $0.05 + 5% | No — 50× the item price |
| Ethereum L1 gas | $2–$10 in gas | No — gas dwarfs payment |
| Arbitrum / Base L2 | $0.001–$0.01 | Marginal; eats all margin |
| **Arc + Nanopayments (x402)** | **~$0 (gas-free via facilitator)** | **Yes — per-call pricing is the product** |

Sub-cent pricing isn't a curiosity — it's the only way to align an API's revenue with its *actual* unit of work (one request, one ms of compute, one scored event). Every other rail forces subscriptions or batching, which break the agent economy: an autonomous agent can't sign up for 50 SaaS subscriptions to answer one question.

## What it does

1. User asks a natural-language question (e.g. *"What's the latest on ETH — price, sentiment, and news?"*).
2. Gemini 2.5 Flash, via function calling, decides which paid endpoints to hit.
3. For each call, the agent signs an EIP-3009 USDC payment authorization, the x402 facilitator verifies and settles on Arc, and the API responds.
4. The agent aggregates tool results and returns a cited answer.
5. Every settlement is logged with its Arc transaction hash.

## Architecture

```
┌──────────────────┐   signs EIP-3009   ┌──────────────────┐
│ Streamlit UI     │ ─────────────────▶ │ x402 Facilitator │
│   └─ Gemini      │                    │ (Circle Nanopay) │
│      Agent       │ ◀─────────────────▶│                  │
└────────┬─────────┘   settle on Arc    └──────────────────┘
         │ HTTP + X-PAYMENT header
         ▼
┌──────────────────┐
│ FastAPI server   │
│  /price   $0.001 │──▶ merchant wallet 1
│  /sentiment $.002│──▶ merchant wallet 2
│  /news    $0.005 │──▶ merchant wallet 3
└──────────────────┘
```

## Setup (≈10 minutes)

### 1. Clone & install
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

### 2. Create wallets
```bash
python scripts/setup_wallets.py
```
This generates 4 EOAs (1 agent + 3 merchants) and prints the `.env` block. Paste it into `.env`.

If `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` are set in `.env`, the script also creates a Circle developer-controlled wallet on `ARC-TESTNET` to demonstrate Circle Wallets integration.

### 3. Add API keys to `.env`
- `GEMINI_API_KEY` — from https://aistudio.google.com
- `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` — from https://console.circle.com (optional but recommended)

### 4. Fund the agent wallet
Go to https://faucet.circle.com/ → Arc Testnet → paste the agent address → request USDC.
**10 USDC funds ~2,000+ API calls.**

### 5. Run

Terminal 1 — paid APIs:
```bash
uvicorn apis.server:app --reload
```

Terminal 2 — Streamlit UI:
```bash
streamlit run app.py
```

Open http://localhost:8501 and ask a question.

## Generate 50+ on-chain transactions (submission proof)

```bash
python scripts/demo_seed.py --count 60
```
This fires 60 paid calls across the three endpoints. Each hash appears in `tx_log.jsonl` and on the Arc explorer.

## Hackathon compliance

| Requirement | How we meet it |
|---|---|
| Real per-action pricing ≤ $0.01 | `$0.001`, `$0.002`, `$0.005` per call — see `apis/server.py` |
| 50+ on-chain transactions in demo | `scripts/demo_seed.py --count 60` + UI interactions |
| Margin explanation | See "Why this can only exist on Arc + Nanopayments" above |
| Settlement on Arc | `ARC_NETWORK=eip155:5042002` — confirmed in every tx hash |
| Uses USDC | Sole payment asset; USDC is native gas on Arc |
| Uses Circle Nanopayments / x402 | `x402ResourceServer` + facilitator handshake for each call |
| Gemini partner challenge | Gemini 2.5 Flash drives tool routing via function calling |
| Circle Wallets (recommended) | `scripts/setup_wallets.py` creates a dev-controlled wallet on ARC-TESTNET |

## File map

```
apis/server.py          # 3 x402-gated FastAPI endpoints
agent/x402_client.py    # Client wrapper: 402 handshake + tx logging
agent/agent.py          # Gemini agent with function calling
app.py                  # Streamlit UI (chat + live tx log)
scripts/setup_wallets.py  # Wallet generation + Circle Wallets
scripts/demo_seed.py      # Fire 50+ tx batch
tx_log.jsonl            # Append-only settlement log
```

## Production evolution (what we'd ship next)

- Swap the local EOA signer for Circle Wallets' `signTypedData` so the agent is fully custodial-safe.
- Use Circle Gateway for a unified cross-chain USDC balance (today the agent must be funded directly on Arc).
- Add per-endpoint rate-limiting and a reputation layer via ERC-8004 so an agent can choose between competing providers based on price × trust.
- Replace the mock data in the endpoints with real upstream providers, wrapping each as a priced facade — turning any existing API into a pay-per-call one.

## Feedback (for the $500 Product Feedback prize)

See `FEEDBACK.md`.
