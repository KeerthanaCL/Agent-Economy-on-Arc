/**
 * Analyst B — the "premium" competing analyst.
 *
 * Identical structure to analyst-ts (Analyst A), but:
 *   - Listens on port 8002 (not 8001)
 *   - Runs a different LLM (ANALYST_B_MODEL, default gpt-4o-mini via AI/ML API)
 *   - Charges a different price (ANALYST_B_PRICE, default $0.030)
 *   - Is marketed as "premium, more detailed" in the /synthesis response
 *
 * The research agent picks between Analyst A and Analyst B by
 * trust_score / price on each request, creating a real reputation-gated
 * marketplace — not just a fixed vendor.
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
const PORT = Number(process.env.ANALYST_B_PORT ?? 8002);
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const MODEL = process.env.ANALYST_B_MODEL ?? "gpt-4o-mini";
const PRICE = process.env.ANALYST_B_PRICE_USD ?? "0.030";
const NAME = process.env.ANALYST_B_NAME ?? "premium";
const BAD_RATE = Number(process.env.ANALYST_B_BAD_RATE ?? "0");
const AIML_BASE = "https://api.aimlapi.com/v1/chat/completions";

const MERCHANT = required("MERCHANT_ANALYST_B_ADDRESS") as `0x${string}`;
const AIML_API_KEY = required("AIML_API_KEY");

const buyer = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

async function llmSynthesize(prompt: string): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
  });
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.log(`[${NAME} synth] retrying (attempt ${attempt + 1}/3)…`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    const r = await fetch(AIML_BASE, {
      method: "POST",
      headers: { "Authorization": `Bearer ${AIML_API_KEY}`, "Content-Type": "application/json" },
      body,
    });
    if (r.ok) {
      const data = await r.json() as any;
      return data.choices?.[0]?.message?.content ?? "(no synthesis)";
    }
    const text = await r.text().catch(() => "");
    lastErr = `AI/ML API ${r.status}: ${text.slice(0, 200)}`;
    if (r.status < 500) throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

const gateway = createGatewayMiddleware({
  sellerAddress: MERCHANT,
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
    caller: `analyst-${NAME}`,
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
    paidGet("/news", { query: ticker, limit: 5 }),   // premium: more headlines
  ]);

  const prompt = `You are a PREMIUM senior financial analyst known for thorough,
nuanced reports. Given:
PRICE: ${JSON.stringify(price)}
SENTIMENT: ${JSON.stringify(sent)}
NEWS: ${JSON.stringify(news)}

Write a detailed 4-5 sentence analyst note on ${ticker} that covers: price
level, momentum from sentiment, and the 1-2 most significant news items.
End with a single-word rating on its own line: BULLISH, NEUTRAL, or BEARISH.`;

  const report = await llmSynthesize(prompt);

  return {
    ticker,
    report,
    model: MODEL,
    tier: NAME,
    price_usd: Number(PRICE),
    citations: { price, sentiment: sent, news },
  };
}

const app = express();

app.get("/", (_req, res) => {
  res.json({
    service: `Analyst B (${NAME}) — premium synthesis`,
    network: NETWORK,
    merchant: MERCHANT,
    endpoints: { "/synthesis": `$${PRICE} per call` },
    model: MODEL,
  });
});

app.get("/synthesis", gateway.require(`$${PRICE}`), async (req: Request, res: Response) => {
  const ticker = ((req.query.ticker as string) ?? "BTC").toUpperCase();
  try {
    if (BAD_RATE > 0 && Math.random() < BAD_RATE) {
      console.log(`[/synthesis ${NAME}] ⚠️  MISBEHAVING — returning junk, skipped downstream`);
      res.json({
        ticker,
        report: "N/A",
        model: MODEL,
        tier: NAME,
        price_usd: Number(PRICE),
        citations: null,
        _misbehaving: true,
        paid_by: (req as any).payment?.payer,
        settlement_tx: (req as any).payment?.transaction,
      });
      return;
    }

    const result = await synthesize(ticker);
    res.json({
      ...result,
      paid_by: (req as any).payment?.payer,
      settlement_tx: (req as any).payment?.transaction,
    });
  } catch (e: any) {
    console.error(`[/synthesis ${NAME}] error:`, e);
    res.status(500).json({ error: e.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[ok] Analyst B (${NAME}) listening on http://localhost:${PORT}`);
  console.log(`     Price:           $${PRICE} per synthesis`);
  console.log(`     Merchant wallet: ${MERCHANT}`);
  console.log(`     Downstream API:  ${API_BASE}`);
  console.log(`     Buyer wallet:    ${buyer.address}`);
  console.log(`     LLM:             ${MODEL}  (via AI/ML API)`);
  if (BAD_RATE > 0) {
    console.log(`     ⚠️  BAD_RATE:    ${(BAD_RATE * 100).toFixed(0)}%  — this analyst misbehaves intentionally`);
  }
});
