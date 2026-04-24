/**
 * Research agent that pays per API call in USDC on Arc.
 *
 * Uses AI/ML API (OpenAI-compatible) with function calling to route user
 * questions to paid tools. Each tool invocation is a sub-cent USDC nanopayment
 * settled on Arc via Circle Gateway. Some tools (get_deep_analysis) trigger
 * a second-hop agent-to-agent payment to the Analyst service on :8001 — which
 * runs a DIFFERENT foundation model, making the handshake a real cross-model
 * agent-to-agent commerce loop.
 */
import { getAgentPrivateKey, required } from "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TX_LOG = path.resolve(__dirname, "..", "tx_log.jsonl");

const AIML_API_KEY = required("AIML_API_KEY");
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const ANALYST_BASE = process.env.ANALYST_BASE_URL ?? "http://localhost:8001";
const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const PORT = Number(process.env.AGENT_PORT ?? 9000);
const MODEL = process.env.RESEARCH_MODEL ?? "gpt-4o-mini";
const AIML_BASE = "https://api.aimlapi.com/v1/chat/completions";

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

const PRICES: Record<string, string> = {
  "/price": "$0.001",
  "/sentiment": "$0.002",
  "/news": "$0.005",
  "/synthesis": "$0.020",
};

const SYSTEM_INSTRUCTION = `You are a research agent in the Agentic Economy on Arc.

For every user question, decide which paid tools to call (if any). Each tool
call costs real USDC, settled on Arc testnet via Circle Gateway nanopayments.
Keep calls purposeful, but do not hesitate to fan out when a question benefits.

Tool choice guide:
- For a quick factual answer (current price, one sentiment score, a few
  headlines): call the raw tools (get_price / get_sentiment / get_news).
- For a *deep analysis* or *analyst report* request (multiple aspects, a
  recommendation, a rating): call get_deep_analysis. It pays a specialist
  analyst agent (runs on a different foundation model), which in turn fans
  out to the raw APIs — one $0.02 call is often cheaper than stitching three
  raw calls plus your own synthesis.

After gathering data, give a concise, cited answer. Reference specific
numbers from tool results. If a question does not need paid data, answer
from general knowledge and skip the tools.`;

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
        "Pay a specialist Analyst Agent (runs on a different foundation model) " +
        "for a full synthesized report on a ticker. The analyst internally fans " +
        "out to price + sentiment + news and returns a 2-3 sentence note plus a " +
        "BULLISH/NEUTRAL/BEARISH rating. Cost: $0.02.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string", description: "e.g. BTC, ETH" } },
        required: ["ticker"],
      },
    },
  },
];

async function callPaidEndpoint(
  baseUrl: string,
  pathName: string,
  params: Record<string, unknown>,
) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${baseUrl}${pathName}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();

  const result = await gateway.pay(url);

  appendFileSync(TX_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    caller: "research",
    path: pathName,
    params,
    price: PRICES[pathName] ?? "",
    tx_hash: result.transaction,
    amount_atomic: result.amount.toString(),
    network: NETWORK,
    from: gateway.address,
    latency_ms: Date.now() - t0,
  }) + "\n");

  return result.data;
}

async function runToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_price":
      return callPaidEndpoint(API_BASE, "/price", { ticker: args.ticker });
    case "get_sentiment":
      return callPaidEndpoint(API_BASE, "/sentiment", { topic: args.topic });
    case "get_news":
      return callPaidEndpoint(API_BASE, "/news", { query: args.query, limit: args.limit ?? 3 });
    case "get_deep_analysis":
      return callPaidEndpoint(ANALYST_BASE, "/synthesis", { ticker: args.ticker });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
  const r = await fetch(AIML_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AIML_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 600,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`AI/ML API ${r.status}: ${body.slice(0, 2000)}`);
  }
  const data = await r.json() as any;
  return data.choices?.[0]?.message as Message;
}

async function ask(question: string): Promise<{ answer: string; toolCalls: unknown[] }> {
  const toolCalls: unknown[] = [];
  const messages: Message[] = [
    { role: "system", content: SYSTEM_INSTRUCTION },
    { role: "user", content: question },
  ];

  for (let step = 0; step < 6; step++) {
    const msg = await chatCompletion(messages);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { answer: msg.content ?? "(no answer)", toolCalls };
    }

    // AI/ML API's validator rejects null content on assistant messages even
    // when tool_calls are present. Coerce to empty string before replay.
    messages.push({ ...msg, content: msg.content ?? "" });

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      try {
        const result = await runToolCall(name, args);
        toolCalls.push({ name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name,
          content: JSON.stringify(result),
        });
      } catch (e: any) {
        const err = { error: e.message ?? String(e) };
        toolCalls.push({ name, args, result: err });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name,
          content: JSON.stringify(err),
        });
      }
    }
  }
  return { answer: "(agent reached max steps without a final answer)", toolCalls };
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, agent: gateway.address, network: NETWORK, api_base: API_BASE, analyst_base: ANALYST_BASE, model: MODEL });
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
  console.log(`     Agent wallet: ${gateway.address}`);
  console.log(`     API base:     ${API_BASE}`);
  console.log(`     Analyst base: ${ANALYST_BASE}`);
  console.log(`     Model:        ${MODEL}  (via AI/ML API)`);
  console.log(`     Tx log:       ${TX_LOG}`);
});
