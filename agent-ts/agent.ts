/**
 * Research agent that pays per API call in USDC on Arc, with:
 *   - Budget guardrail: max spend per user question (env MAX_SPEND_USD).
 *   - Trust scoring: every paid response is sanity-checked; bad responses
 *     decay that endpoint's reputation, persisted to ../trust.json.
 *   - Analyst marketplace: two competing analyst services (A on :8001 and
 *     B on :8002) run different LLMs at different prices. The research
 *     agent picks between them by (trust_score / price) on each call —
 *     a real reputation-gated marketplace, not a fixed vendor.
 *
 * Uses AI/ML API (OpenAI-compatible) with function calling to route user
 * questions to paid tools. Each tool invocation is a sub-cent USDC
 * nanopayment settled on Arc via Circle Gateway.
 */
import { getAgentPrivateKey, required } from "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TX_LOG = path.resolve(__dirname, "..", "tx_log.jsonl");
const TRUST_FILE = path.resolve(__dirname, "..", "trust.json");

const AIML_API_KEY = required("AIML_API_KEY");
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const PORT = Number(process.env.AGENT_PORT ?? 9000);
const MODEL = process.env.RESEARCH_MODEL ?? "gpt-4o-mini";
const MAX_SPEND_USD = Number(process.env.MAX_SPEND_USD ?? "0.05");
const AIML_BASE = "https://api.aimlapi.com/v1/chat/completions";

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

const RAW_PRICES_USD: Record<string, number> = {
  "/price": 0.001,
  "/sentiment": 0.002,
  "/news": 0.005,
};

// ───────── Analyst marketplace ─────────────────────────────────────────────

interface AnalystProvider {
  name: string;
  url: string;
  priceUsd: number;
  model: string;
}

const ANALYSTS: AnalystProvider[] = [
  {
    name: process.env.ANALYST_A_NAME ?? "gemini",
    url: process.env.ANALYST_A_URL ?? "http://localhost:8001",
    priceUsd: Number(process.env.ANALYST_A_PRICE_USD ?? "0.020"),
    model: process.env.ANALYST_MODEL ?? "google/gemini-2.5-flash",
  },
  {
    name: process.env.ANALYST_B_NAME ?? "premium",
    url: process.env.ANALYST_B_URL ?? "http://localhost:8002",
    priceUsd: Number(process.env.ANALYST_B_PRICE_USD ?? "0.030"),
    model: process.env.ANALYST_B_MODEL ?? "gpt-4o-mini",
  },
];

function analystTrustKey(name: string): string {
  return `/synthesis@${name}`;
}

/** Pick the analyst with highest trust-per-price that fits the remaining budget. */
function pickAnalyst(budgetRemaining: number): (AnalystProvider & { trust: number; score: number }) | null {
  const trust = loadTrust();
  const affordable = ANALYSTS
    .filter(a => a.priceUsd <= budgetRemaining + 1e-9)
    .map(a => {
      const t = trust[analystTrustKey(a.name)]?.score ?? 100;
      const score = t / (a.priceUsd * 1000);  // trust points per milli-USD
      return { ...a, trust: t, score };
    });
  if (affordable.length === 0) return null;
  affordable.sort((a, b) => b.score - a.score);
  return affordable[0];
}

// ───────── Trust store ─────────────────────────────────────────────────────

interface TrustEntry {
  score: number;          // 0..100
  calls: number;
  violations: number;
  last_violation?: string;
  last_checked: string;
}

type TrustStore = Record<string, TrustEntry>;

function loadTrust(): TrustStore {
  if (!existsSync(TRUST_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TRUST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveTrust(store: TrustStore) {
  writeFileSync(TRUST_FILE, JSON.stringify(store, null, 2));
}

function ensureTrust(store: TrustStore, endpoint: string): TrustEntry {
  if (!store[endpoint]) {
    store[endpoint] = { score: 100, calls: 0, violations: 0, last_checked: new Date().toISOString() };
  }
  return store[endpoint];
}

/** Return a reason string if the response fails the sanity rule, or null if OK. */
function sanityCheck(endpoint: string, response: any): string | null {
  const pathOnly = endpoint.split("@")[0];  // strip "@gemini" etc.
  try {
    switch (pathOnly) {
      case "/price": {
        const p = Number(response?.price_usd);
        if (!isFinite(p) || p <= 0.01 || p > 1_000_000) return `price_usd out of range: ${p}`;
        return null;
      }
      case "/sentiment": {
        const s = Number(response?.score);
        if (!isFinite(s) || s < -1 || s > 1) return `score out of [-1,1]: ${s}`;
        return null;
      }
      case "/news": {
        const items = response?.items;
        if (!Array.isArray(items) || items.length === 0) return "items missing or empty";
        return null;
      }
      case "/synthesis": {
        if (typeof response?.report !== "string" || response.report.length < 10) return "report missing or too short";
        if (typeof response?.citations !== "object" || !response.citations) return "citations missing";
        return null;
      }
      default:
        return null;
    }
  } catch (e: any) {
    return `sanity check threw: ${e.message}`;
  }
}

function updateTrust(endpoint: string, response: any) {
  const store = loadTrust();
  const entry = ensureTrust(store, endpoint);
  entry.calls += 1;
  entry.last_checked = new Date().toISOString();

  const violation = sanityCheck(endpoint, response);
  if (violation) {
    entry.violations += 1;
    entry.last_violation = violation;
    entry.score = Math.max(0, entry.score - 10);
  } else {
    if (entry.calls % 5 === 0) entry.score = Math.min(100, entry.score + 1);
  }
  saveTrust(store);
}

// ───────── Paid endpoint wrapper ───────────────────────────────────────────

interface PaidOpts {
  trustKey?: string;    // override key for trust store (used for analyst providers)
  priceUsd?: number;    // override price (for dynamic-priced paths like /synthesis)
  provider?: string;    // tag for the tx log
}

async function callPaidEndpoint(
  baseUrl: string,
  pathName: string,
  params: Record<string, unknown>,
  opts: PaidOpts = {},
) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${baseUrl}${pathName}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();

  const result = await gateway.pay(url);
  const data = result.data as any;
  const priceUsd = opts.priceUsd ?? RAW_PRICES_USD[pathName] ?? 0;

  appendFileSync(TX_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    caller: "research",
    path: pathName,
    provider: opts.provider ?? "",
    params,
    price: `$${priceUsd.toFixed(3)}`,
    tx_hash: result.transaction,
    amount_atomic: result.amount.toString(),
    network: NETWORK,
    from: gateway.address,
    latency_ms: Date.now() - t0,
  }) + "\n");

  updateTrust(opts.trustKey ?? pathName, data);
  return data;
}

// ───────── Tool schema + dispatch ──────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are a research agent in the Agentic Economy on Arc.

For every user question, decide which paid tools to call (if any). Each tool
call costs real USDC, settled on Arc testnet via Circle Gateway nanopayments.
You operate with a strict spend budget per question (see "BUDGET:" line
below). Keep calls purposeful. If a tool response includes
{ "error": "budget_exhausted" } or { "error": "no_affordable_analyst" }, you
MUST stop calling tools and answer with whatever data you've already
collected.

Tool choice guide:
- For a quick factual answer (current price, one sentiment score, a few
  headlines): call the raw tools (get_price / get_sentiment / get_news).
- For a *deep analysis* or *analyst report* request (multiple aspects, a
  recommendation, a rating): call get_deep_analysis. The system will
  automatically pick the best Analyst Agent from a marketplace of competing
  providers (trust score × price). The response tells you which analyst was
  chosen and its trust level — cite that if relevant.

After gathering data, give a concise, cited answer. Reference specific
numbers from tool results.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "Get current USD price for a ticker symbol. Cost: $0.001.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string", description: "e.g. BTC, ETH, SOL" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sentiment",
      description: "Get a sentiment score in [-1, 1] for a topic. Cost: $0.002.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "Get recent headlines for a query. Cost: $0.005.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "1-5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deep_analysis",
      description:
        "Pay an Analyst Agent for a full synthesized report on a ticker. Cost " +
        "varies by provider ($0.02–$0.03). The system picks the best analyst " +
        "from a marketplace of competing providers by trust × price.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string", description: "e.g. BTC, ETH" } },
        required: ["ticker"],
      },
    },
  },
];

// ───────── Chat loop ──────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

async function chatCompletion(messages: Message[]): Promise<Message> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    max_tokens: 600,
  });

  // Retry up to 2 times on transient 5xx (Cloudflare 524 timeouts, etc.)
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.log(`[chatCompletion] retrying (attempt ${attempt + 1}/3) after ${lastErr.slice(0, 80)}…`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    const r = await fetch(AIML_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AIML_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (r.ok) {
      const data = await r.json() as any;
      return data.choices?.[0]?.message as Message;
    }
    const text = await r.text().catch(() => "");
    lastErr = `AI/ML API ${r.status}: ${text.slice(0, 200)}`;
    if (r.status < 500) {
      // 4xx is a real client error; don't retry
      throw new Error(`AI/ML API ${r.status}: ${text.slice(0, 2000)}`);
    }
  }
  throw new Error(lastErr);
}

interface AskResult {
  answer: string;
  toolCalls: unknown[];
  spend: { total_usd: number; budget_usd: number; pct: number; exhausted: boolean };
}

async function ask(question: string): Promise<AskResult> {
  const toolCalls: unknown[] = [];
  let totalSpent = 0;
  let exhausted = false;

  const budgetLine = `BUDGET: $${MAX_SPEND_USD.toFixed(3)} max per question.`;
  const messages: Message[] = [
    { role: "system", content: `${SYSTEM_INSTRUCTION}\n\n${budgetLine}` },
    { role: "user", content: question },
  ];

  for (let step = 0; step < 6; step++) {
    const msg = await chatCompletion(messages);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        answer: msg.content ?? "(no answer)",
        toolCalls,
        spend: {
          total_usd: Number(totalSpent.toFixed(6)),
          budget_usd: MAX_SPEND_USD,
          pct: Number(((totalSpent / MAX_SPEND_USD) * 100).toFixed(1)),
          exhausted,
        },
      };
    }

    messages.push({ ...msg, content: msg.content ?? "" });

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

      let result: unknown;
      try {
        if (name === "get_deep_analysis") {
          const remaining = MAX_SPEND_USD - totalSpent;
          const picked = pickAnalyst(remaining);
          if (!picked) {
            exhausted = true;
            result = {
              error: "no_affordable_analyst",
              message: `No analyst fits the remaining budget $${remaining.toFixed(3)}`,
              spent_so_far: Number(totalSpent.toFixed(6)),
              budget: MAX_SPEND_USD,
            };
          } else {
            const data = await callPaidEndpoint(
              picked.url,
              "/synthesis",
              { ticker: String(args.ticker ?? "BTC") },
              { provider: picked.name, priceUsd: picked.priceUsd, trustKey: analystTrustKey(picked.name) },
            );
            totalSpent += picked.priceUsd;
            result = {
              ...data,
              _market: {
                picked: picked.name,
                model: picked.model,
                trust_score: picked.trust,
                price_usd: picked.priceUsd,
                competitors_considered: ANALYSTS.length,
              },
            };
          }
        } else {
          const path = `/${name.replace("get_", "")}`;
          const cost = RAW_PRICES_USD[path] ?? 0;
          if (totalSpent + cost > MAX_SPEND_USD + 1e-9) {
            exhausted = true;
            result = {
              error: "budget_exhausted",
              message: `Skipping ${name}: would spend $${(totalSpent + cost).toFixed(3)}, over budget $${MAX_SPEND_USD.toFixed(3)}`,
              spent_so_far: Number(totalSpent.toFixed(6)),
              budget: MAX_SPEND_USD,
            };
          } else {
            const params =
              name === "get_price" ? { ticker: args.ticker } :
              name === "get_sentiment" ? { topic: args.topic } :
              name === "get_news" ? { query: args.query, limit: args.limit ?? 3 } :
              {};
            result = await callPaidEndpoint(API_BASE, path, params);
            totalSpent += cost;
          }
        }
      } catch (e: any) {
        result = { error: e.message ?? String(e) };
      }

      toolCalls.push({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    answer: "(agent reached max steps without a final answer)",
    toolCalls,
    spend: {
      total_usd: Number(totalSpent.toFixed(6)),
      budget_usd: MAX_SPEND_USD,
      pct: Number(((totalSpent / MAX_SPEND_USD) * 100).toFixed(1)),
      exhausted,
    },
  };
}

// ───────── HTTP server ────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    agent: gateway.address,
    network: NETWORK,
    api_base: API_BASE,
    analysts: ANALYSTS,
    model: MODEL,
    max_spend_usd: MAX_SPEND_USD,
  });
});

app.get("/trust", (_req, res) => {
  res.json(loadTrust());
});

app.get("/analysts", (_req, res) => {
  const trust = loadTrust();
  res.json(ANALYSTS.map(a => ({
    ...a,
    trust_score: trust[analystTrustKey(a.name)]?.score ?? 100,
    trust_calls: trust[analystTrustKey(a.name)]?.calls ?? 0,
    violations: trust[analystTrustKey(a.name)]?.violations ?? 0,
  })));
});

app.post("/ask", async (req: Request, res: Response) => {
  const question = (req.body?.question as string) ?? "";
  if (!question) {
    res.status(400).json({ error: "missing 'question' field" });
    return;
  }
  try {
    const result = await ask(question);
    res.json(result);
  } catch (e: any) {
    console.error("[/ask] error:", e);
    res.status(500).json({ error: e.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[ok] Research agent listening on http://localhost:${PORT}`);
  console.log(`     Agent wallet:   ${gateway.address}`);
  console.log(`     API base:       ${API_BASE}`);
  console.log(`     Model:          ${MODEL}  (via AI/ML API)`);
  console.log(`     Budget/question: $${MAX_SPEND_USD.toFixed(3)}`);
  console.log(`     Analyst marketplace (${ANALYSTS.length} providers):`);
  for (const a of ANALYSTS) {
    console.log(`       - ${a.name}: $${a.priceUsd.toFixed(3)} @ ${a.url}  (${a.model})`);
  }
  console.log(`     Tx log:         ${TX_LOG}`);
  console.log(`     Trust store:    ${TRUST_FILE}`);
});
