/**
 * Fire a batch of paid API calls directly (no Gemini loop) to pile up on-chain
 * settlements for the 50+ tx hackathon requirement.
 *
 *   npm run seed              # 60 calls
 *   npm run seed -- 120       # 120 calls
 */
import { getAgentPrivateKey } from "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TX_LOG = path.resolve(__dirname, "..", "tx_log.jsonl");

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const COUNT = Number(process.argv[2] ?? 60);

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

const TICKERS = ["BTC", "ETH", "SOL", "USDC"];
const TOPICS = ["bitcoin", "stablecoins", "AI agents", "Circle Arc", "DePIN"];
const QUERIES = ["USDC", "Arc network", "agentic commerce", "stablecoin regulation"];

const PRICES: Record<string, string> = {
  "/price": "$0.001",
  "/sentiment": "$0.002",
  "/news": "$0.005",
};

function pick<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

async function paidGet(pathName: string, params: Record<string, unknown>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${API_BASE}${pathName}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();
  const r = await gateway.pay(url);
  appendFileSync(TX_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    path: pathName,
    params,
    price: PRICES[pathName] ?? "",
    tx_hash: r.transaction,
    amount_atomic: r.amount.toString(),
    network: NETWORK,
    from: gateway.address,
    latency_ms: Date.now() - t0,
  }) + "\n");
  return r;
}

console.log(`Agent: ${gateway.address}`);
console.log(`Firing ${COUNT} paid calls against ${API_BASE}…\n`);

let ok = 0;
for (let i = 0; i < COUNT; i++) {
  const kind = ["price", "sentiment", "news"][Math.floor(Math.random() * 3)];
  try {
    if (kind === "price") {
      await paidGet("/price", { ticker: pick(TICKERS) });
    } else if (kind === "sentiment") {
      await paidGet("/sentiment", { topic: pick(TOPICS) });
    } else {
      await paidGet("/news", { query: pick(QUERIES), limit: 3 });
    }
    ok++;
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${COUNT}…`);
  } catch (e: any) {
    console.log(`  [${i + 1}] FAIL on ${kind}: ${e.message}`);
  }
}

console.log(`\nDone: ${ok}/${COUNT} settled.`);
console.log(`See ${TX_LOG} for tx hashes.`);
