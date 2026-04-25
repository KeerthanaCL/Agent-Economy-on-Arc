/**
 * Marketplace demo — fire N deep-analysis questions at the research agent
 * and watch the trust-aware picker flip from the misbehaving cheap analyst
 * to the clean premium one in real time.
 *
 * Usage:
 *   npm run marketplace                 # 20 calls, keep existing trust
 *   npm run marketplace -- 30 --reset   # 30 calls, wipe trust.json first
 */
import "./env.js";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRUST_FILE = path.resolve(__dirname, "..", "trust.json");

const AGENT = process.env.AGENT_URL ?? "http://localhost:9000";
const TICKERS = ["BTC", "ETH", "SOL", "USDC"];

const args = process.argv.slice(2);
const COUNT = Number(args.find(a => !a.startsWith("--")) ?? 20);
const RESET = args.includes("--reset");

if (RESET && existsSync(TRUST_FILE)) {
  unlinkSync(TRUST_FILE);
  console.log("🗑  Reset trust.json — all analysts start at 100.\n");
}

console.log(`Firing ${COUNT} deep-analysis questions through the marketplace…`);
console.log(`Endpoint: ${AGENT}/ask\n`);
console.log("┌─────────┬───────┬──────────┬────────┬─────────┬───────────┐");
console.log("│ #       │ ticker│ picked   │ trust  │ price   │ note      │");
console.log("├─────────┼───────┼──────────┼────────┼─────────┼───────────┤");

let totalSpend = 0;
const picks: Record<string, number> = {};
let misbehaviors = 0;
let dumpedFirst = false;

for (let i = 0; i < COUNT; i++) {
  const ticker = TICKERS[i % TICKERS.length];
  // Directive prompt — tell the LLM explicitly to use the marketplace tool,
  // because otherwise gpt-4o-mini may choose the raw tools for cheaper cost.
  const q = `Use the get_deep_analysis tool to produce a full analyst report on ${ticker}. Return its exact synthesis plus a BULLISH/NEUTRAL/BEARISH rating.`;

  const t0 = Date.now();
  try {
    const r = await fetch(`${AGENT}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = await r.json() as any;

    // Dump the first response's shape for debugging if we can't extract the
    // marketplace info — this happens when the LLM didn't call get_deep_analysis.
    if (!dumpedFirst && !(data.toolCalls ?? []).some((tc: any) => tc.name === "get_deep_analysis")) {
      console.log(`\n⚠️  First response didn't call get_deep_analysis. Dumping shape:`);
      console.log(`   Tools called: ${(data.toolCalls ?? []).map((tc: any) => tc.name).join(", ") || "(none)"}`);
      console.log(`   Spend: $${data.spend?.total_usd ?? 0}`);
      console.log(`   Answer start: ${(data.answer ?? "").slice(0, 120)}`);
      dumpedFirst = true;
    }

    const toolCall = (data.toolCalls ?? []).find((tc: any) => tc.name === "get_deep_analysis");
    const market = toolCall?.result?._market;
    const misbehaving = !!toolCall?.result?._misbehaving;
    const picked = market?.picked ?? "(none)";
    const trust = market?.trust_score ?? "?";
    const price = market?.price_usd ?? 0;
    const spend = data.spend?.total_usd ?? 0;
    const toolNames = (data.toolCalls ?? []).map((tc: any) => tc.name).join(",") || "(none)";

    totalSpend += spend;
    picks[picked] = (picks[picked] ?? 0) + 1;
    if (misbehaving) misbehaviors += 1;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const note = misbehaving ? "⚠️  junk" : (picked === "(none)" ? `tools: ${toolNames.slice(0, 20)}` : "");
    console.log(
      `│ ${String(i + 1).padStart(2)}/${String(COUNT).padEnd(3)} │ ${ticker.padEnd(5)} │ ${picked.padEnd(8)} │ ${String(trust).padStart(5)}  │ $${price.toFixed(3)} │ ${note.padEnd(9)} │  ${elapsed}s`
    );
  } catch (e: any) {
    console.log(`│ ${String(i + 1).padStart(2)}/${String(COUNT).padEnd(3)} │ ${ticker.padEnd(5)} │ ERROR    │   ?    │   ?     │ ${e.message}`);
  }
}

console.log("└─────────┴───────┴──────────┴────────┴─────────┴───────────┘\n");

console.log("── Summary ──");
for (const [name, count] of Object.entries(picks).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(10)} ${count} picks`);
}
console.log(`  Misbehaviors detected: ${misbehaviors}/${COUNT}`);
console.log(`  Total USDC spent:      $${totalSpend.toFixed(4)}`);
console.log();
console.log("Current trust scores (GET /analysts on the research agent):");
try {
  const tr = await fetch(`${AGENT}/analysts`).then(r => r.json() as Promise<any[]>);
  for (const a of tr) {
    console.log(`  ${a.name.padEnd(10)} trust=${a.trust_score}/100  calls=${a.trust_calls}  violations=${a.violations}`);
  }
} catch {
  // ignore
}
