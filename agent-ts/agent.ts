/**
 * Gemini-powered research agent that pays per API call in USDC on Arc.
 *
 * Exposes POST /ask { question } which:
 *   1. Uses Gemini 2.5 Flash function calling to pick which paid endpoints
 *      to hit (price / sentiment / news).
 *   2. For each tool call, invokes GatewayClient.pay() — a sub-cent USDC
 *      nanopayment settled on Arc via Circle Gateway.
 *   3. Aggregates tool results and returns a cited answer.
 *   4. Appends every payment to ../tx_log.jsonl so the Streamlit UI can
 *      display settlement proof.
 */
import { getAgentPrivateKey, required } from "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { GoogleGenAI, Type, type FunctionCall } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TX_LOG = path.resolve(__dirname, "..", "tx_log.jsonl");

const GEMINI_API_KEY = required("GEMINI_API_KEY");
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8000";
const NETWORK = process.env.ARC_NETWORK ?? "eip155:5042002";
const PORT = Number(process.env.AGENT_PORT ?? 9000);
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PRICES: Record<string, string> = {
  "/price": "$0.001",
  "/sentiment": "$0.002",
  "/news": "$0.005",
};

const SYSTEM_INSTRUCTION = `You are a research agent in the Agentic Economy on Arc.

For every user question, decide which paid micro-APIs to call (if any) and
call them via the available tools. Each tool call costs real USDC, settled
on Arc testnet via Circle Gateway nanopayments — keep calls purposeful, but
do not hesitate to fan out across multiple tools when a question benefits.

After gathering data, give a concise, cited answer. Reference the tool
results explicitly (e.g. "per /price, BTC = $68,412"). If a question does
not need paid data, answer from general knowledge and skip the tools.`;

const TOOL_DEFS = [{
  functionDeclarations: [
    {
      name: "get_price",
      description: "Get current USD price for a ticker symbol. Cost: $0.001.",
      parameters: {
        type: Type.OBJECT,
        properties: { ticker: { type: Type.STRING, description: "e.g. BTC, ETH, SOL" } },
        required: ["ticker"],
      },
    },
    {
      name: "get_sentiment",
      description: "Get a sentiment score in [-1, 1] for a given topic. Cost: $0.002.",
      parameters: {
        type: Type.OBJECT,
        properties: { topic: { type: Type.STRING } },
        required: ["topic"],
      },
    },
    {
      name: "get_news",
      description: "Get recent headlines for a query. Cost: $0.005.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING },
          limit: { type: Type.INTEGER, description: "1-5" },
        },
        required: ["query"],
      },
    },
  ],
}];

async function callPaidEndpoint(pathName: string, params: Record<string, unknown>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${API_BASE}${pathName}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();

  const result = await gateway.pay(url);

  appendFileSync(TX_LOG, JSON.stringify({
    ts: new Date().toISOString(),
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

async function runToolCall(fc: FunctionCall): Promise<unknown> {
  const args = (fc.args ?? {}) as Record<string, unknown>;
  switch (fc.name) {
    case "get_price": return callPaidEndpoint("/price", { ticker: args.ticker });
    case "get_sentiment": return callPaidEndpoint("/sentiment", { topic: args.topic });
    case "get_news": return callPaidEndpoint("/news", { query: args.query, limit: args.limit ?? 3 });
    default: throw new Error(`Unknown tool: ${fc.name}`);
  }
}

async function ask(question: string): Promise<{ answer: string; toolCalls: unknown[] }> {
  const toolCalls: unknown[] = [];
  const contents: any[] = [{ role: "user", parts: [{ text: question }] }];

  for (let step = 0; step < 6; step++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: SYSTEM_INSTRUCTION, tools: TOOL_DEFS },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const fcalls: FunctionCall[] = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

    if (fcalls.length === 0) {
      return { answer: response.text ?? "(no answer)", toolCalls };
    }

    contents.push(response.candidates![0].content);
    const responseParts: any[] = [];
    for (const fc of fcalls) {
      try {
        const result = await runToolCall(fc);
        toolCalls.push({ name: fc.name, args: fc.args, result });
        responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
      } catch (e: any) {
        const err = { error: e.message };
        toolCalls.push({ name: fc.name, args: fc.args, result: err });
        responseParts.push({ functionResponse: { name: fc.name, response: err } });
      }
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return { answer: "(agent reached max steps without a final answer)", toolCalls };
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, agent: gateway.address, network: NETWORK, api_base: API_BASE });
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
  console.log(`[ok] Agent listening on http://localhost:${PORT}`);
  console.log(`     Agent wallet: ${gateway.address}`);
  console.log(`     API base:     ${API_BASE}`);
  console.log(`     Model:        ${MODEL}`);
  console.log(`     Tx log:       ${TX_LOG}`);
});
