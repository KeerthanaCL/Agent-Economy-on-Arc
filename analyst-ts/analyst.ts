/**
 * Analyst Agent — a paid x402 service that itself pays downstream APIs.
 *
 * This is the agent-to-agent loop: the research agent (on :9000) pays THIS
 * agent $0.02 per /synthesis call. This agent then pays the base APIs
 * (:8000) for price + sentiment + news, and uses Gemini to synthesize a
 * one-paragraph analyst report.
 *
 *   Research agent  ──$0.02──▶  Analyst agent  ──$0.008──▶  3 base APIs
 *                                 (margin: $0.012)
 *
 * Every downstream settlement is logged with caller="analyst" so the
 * Streamlit UI shows the full 2-hop value chain.
 */
import { getAgentPrivateKey, required } from "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TX_LOG = path.resolve(__dirname, "..", "tx_log.jsonl");

const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com";
const PORT = Number(process.env.ANALYST_PORT ?? 8001);
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const MODEL = process.env.ANALYST_MODEL ?? "claude-3-5-haiku-20241022";
const AIML_BASE = "https://api.aimlapi.com/v1/chat/completions";

const MERCHANT_ANALYST = required("MERCHANT_ANALYST_ADDRESS") as `0x${string}`;
const AIML_API_KEY = required("AIML_API_KEY");

// The analyst both RECEIVES and SENDS — shares the agent's Gateway balance
// for downstream payments so we don't need a second funded wallet.
const buyer = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

// Claude via AI/ML API (OpenAI-compatible) — runs on a DIFFERENT model family
// than the research agent (Gemini), which turns the /synthesis handshake into
// a true cross-provider agent-to-agent commerce loop.
async function llmSynthesize(prompt: string): Promise<string> {
  const r = await fetch(AIML_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AIML_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`AI/ML API ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json() as any;
  return data.choices?.[0]?.message?.content ?? "(no synthesis)";
}

const gateway = createGatewayMiddleware({
  sellerAddress: MERCHANT_ANALYST,
  networks: [NETWORK],
  facilitatorUrl: FACILITATOR_URL,
});

const DOWNSTREAM_PRICES: Record<string, string> = {
  "/price": "$0.001",
  "/sentiment": "$0.002",
  "/news": "$0.005",
};

async function paidGet(pathName: string, params: Record<string, unknown>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${API_BASE}${pathName}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();
  const r = await buyer.pay(url);
  appendFileSync(TX_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    caller: "analyst",
    path: pathName,
    params,
    price: DOWNSTREAM_PRICES[pathName] ?? "",
    tx_hash: r.transaction,
    amount_atomic: r.amount.toString(),
    network: NETWORK,
    from: buyer.address,
    latency_ms: Date.now() - t0,
  }) + "\n");
  return r.data as any;
}

async function synthesize(ticker: string) {
  const [price, sent, news] = await Promise.all([
    paidGet("/price", { ticker }),
    paidGet("/sentiment", { topic: ticker }),
    paidGet("/news", { query: ticker, limit: 3 }),
  ]);

  const prompt = `You are a concise financial analyst. Given:
PRICE: ${JSON.stringify(price)}
SENTIMENT: ${JSON.stringify(sent)}
NEWS: ${JSON.stringify(news)}

Write a 2-3 sentence analyst note on ${ticker}. Be specific — cite numbers.
End with a single-word rating on its own line: BULLISH, NEUTRAL, or BEARISH.`;

  const report = await llmSynthesize(prompt);

  return {
    ticker,
    report,
    model: MODEL,
    citations: { price, sentiment: sent, news },
  };
}

const app = express();

app.get("/", (_req, res) => {
  res.json({
    service: "Analyst Agent — paid synthesis over paid APIs",
    network: NETWORK,
    merchant: MERCHANT_ANALYST,
    endpoints: { "/synthesis": "$0.02 per call (agent pays $0.008 downstream → $0.012 margin)" },
  });
});

app.get("/synthesis", gateway.require("$0.02"), async (req: Request, res: Response) => {
  const ticker = ((req.query.ticker as string) ?? "BTC").toUpperCase();
  try {
    const result = await synthesize(ticker);
    res.json({
      ...result,
      paid_by: (req as any).payment?.payer,
      settlement_tx: (req as any).payment?.transaction,
    });
  } catch (e: any) {
    console.error("[/synthesis] error:", e);
    res.status(500).json({ error: e.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[ok] Analyst listening on http://localhost:${PORT}`);
  console.log(`     Merchant wallet: ${MERCHANT_ANALYST}`);
  console.log(`     Downstream API:  ${API_BASE}`);
  console.log(`     Buyer wallet:    ${buyer.address}  (shares Gateway balance with research agent)`);
  console.log(`     LLM:             ${MODEL}  (via AI/ML API)`);
});
