/**
 * Paid micro-APIs gated by Circle Nanopayments (x402) on Arc testnet.
 *
 *   GET /price      $0.001 — mock market price for a ticker
 *   GET /sentiment  $0.002 — mock sentiment score for a topic
 *   GET /news       $0.005 — mock news headlines for a query
 *
 * Each call is priced in USDC and settles on Arc via Circle's
 * x402-batching facilitator. A single user question in the agent typically
 * fans out to 3–5 paid calls; seed script fires 60 for demo proof.
 */
import * as dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Circle's x402-batching middleware uses CAIP-2 network identifiers
// (e.g. "eip155:5042002" for Arc Testnet). The default facilitator URL
// points at mainnet — we MUST override it for testnet.
const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com";
const PORT = Number(process.env.PORT ?? 8000);

const MERCHANT_PRICE = required("MERCHANT_PRICE_ADDRESS");
const MERCHANT_SENTIMENT = required("MERCHANT_SENTIMENT_ADDRESS");
const MERCHANT_NEWS = required("MERCHANT_NEWS_ADDRESS");

function required(k: string): `0x${string}` {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v as `0x${string}`;
}

const app = express();

// One gateway per merchant wallet — each endpoint collects to its own seller.
const gwPrice = createGatewayMiddleware({ sellerAddress: MERCHANT_PRICE, networks: [NETWORK], facilitatorUrl: FACILITATOR_URL });
const gwSentiment = createGatewayMiddleware({ sellerAddress: MERCHANT_SENTIMENT, networks: [NETWORK], facilitatorUrl: FACILITATOR_URL });
const gwNews = createGatewayMiddleware({ sellerAddress: MERCHANT_NEWS, networks: [NETWORK], facilitatorUrl: FACILITATOR_URL });


app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Agent Research Desk — Paid APIs",
    network: NETWORK,
    endpoints: {
      "/price": "$0.001 per call",
      "/sentiment": "$0.002 per call",
      "/news": "$0.005 per call",
    },
  });
});

app.get("/price", gwPrice.require("$0.001"), (req: Request, res: Response) => {
  const ticker = ((req.query.ticker as string) ?? "BTC").toUpperCase();
  const base = ({ BTC: 68000, ETH: 3400, SOL: 180, USDC: 1 } as Record<string, number>)[ticker] ?? 100;
  res.json({
    ticker,
    price_usd: Number((base * (0.98 + Math.random() * 0.04)).toFixed(2)),
    ts: new Date().toISOString(),
    paid_by: (req as any).payment?.payer,
  });
});

app.get("/sentiment", gwSentiment.require("$0.002"), (req: Request, res: Response) => {
  const topic = (req.query.topic as string) ?? "unknown";
  const score = Number((Math.random() * 2 - 1).toFixed(3));
  const label = score > 0.2 ? "bullish" : score < -0.2 ? "bearish" : "neutral";
  res.json({ topic, score, label, ts: new Date().toISOString(), paid_by: (req as any).payment?.payer });
});

app.get("/news", gwNews.require("$0.005"), (req: Request, res: Response) => {
  const query = (req.query.query as string) ?? "markets";
  const limit = Math.min(5, Math.max(1, Number(req.query.limit ?? 3)));
  const pool = [
    `${query}: market analysts revise outlook after Q1 data`,
    `Institutional inflows into ${query} hit 12-week high`,
    `${query}: regulators signal clearer guidance coming`,
    `On-chain activity for ${query} up 8% week-over-week`,
    `${query} adoption accelerates among mid-market firms`,
  ];
  const items = pool.sort(() => Math.random() - 0.5).slice(0, limit);
  res.json({ query, items, ts: new Date().toISOString(), paid_by: (req as any).payment?.payer });
});

app.listen(PORT, () => {
  console.log(`[ok] Paid APIs listening on http://localhost:${PORT}`);
  console.log(`     Network: ${NETWORK}`);
  console.log(`     Facilitator: ${FACILITATOR_URL}`);
  console.log(`     Merchants: price=${MERCHANT_PRICE}  sentiment=${MERCHANT_SENTIMENT}  news=${MERCHANT_NEWS}`);
});
