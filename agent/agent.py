"""Gemini-powered research agent that pays per API call on Arc.

Uses Gemini function calling to route a user question to one or more paid
endpoints, aggregates the results, and returns a cited answer. Every tool
invocation triggers an on-chain USDC settlement via x402 on Arc testnet.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable

from dotenv import load_dotenv
from google import genai
from google.genai import types

from agent.x402_client import PaidAPIClient, build_client_from_env

load_dotenv()

MODEL = "gemini-2.5-flash"  # Fast + cheap; swap to gemini-2.5-pro for reasoning.

SYSTEM_INSTRUCTION = """You are a research agent in the Agentic Economy on Arc.

For every user question, decide which paid micro-APIs to call (if any) and
call them via the available tools. Each tool call costs real USDC, settled
on Arc testnet via x402 — keep calls purposeful, but do not hesitate to
fan out across multiple tools when a question benefits from it.

After gathering data, give a concise, cited answer. Reference the tool
results explicitly (e.g. "per /price, BTC = $68,412"). If a question does
not need paid data, answer from general knowledge and skip the tools."""


TOOLS = [
    types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name="get_price",
            description="Get the current USD price for a ticker symbol. Cost: $0.001.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={"ticker": types.Schema(type=types.Type.STRING, description="e.g. BTC, ETH, SOL")},
                required=["ticker"],
            ),
        ),
        types.FunctionDeclaration(
            name="get_sentiment",
            description="Get a sentiment score in [-1, 1] for a given topic. Cost: $0.002.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={"topic": types.Schema(type=types.Type.STRING)},
                required=["topic"],
            ),
        ),
        types.FunctionDeclaration(
            name="get_news",
            description="Get recent headlines for a query. Cost: $0.005.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "query": types.Schema(type=types.Type.STRING),
                    "limit": types.Schema(type=types.Type.INTEGER, description="1-5"),
                },
                required=["query"],
            ),
        ),
    ])
]


@dataclass
class AgentRun:
    answer: str = ""
    tool_calls: list[dict] = field(default_factory=list)


class ResearchAgent:
    def __init__(self, paid_client: PaidAPIClient | None = None) -> None:
        self.paid_client = paid_client or build_client_from_env()
        self.genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

        self.handlers: dict[str, Callable[..., dict]] = {
            "get_price": lambda ticker: self.paid_client.get("/price", {"ticker": ticker}),
            "get_sentiment": lambda topic: self.paid_client.get("/sentiment", {"topic": topic}),
            "get_news": lambda query, limit=3: self.paid_client.get("/news", {"query": query, "limit": limit}),
        }

    def ask(self, question: str, max_steps: int = 6) -> AgentRun:
        run = AgentRun()
        contents: list[types.Content] = [
            types.Content(role="user", parts=[types.Part(text=question)]),
        ]

        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            tools=TOOLS,
        )

        for _ in range(max_steps):
            response = self.genai_client.models.generate_content(
                model=MODEL, contents=contents, config=config
            )
            candidate = response.candidates[0]
            parts = candidate.content.parts or []

            function_calls = [p.function_call for p in parts if getattr(p, "function_call", None)]

            if not function_calls:
                run.answer = response.text or ""
                return run

            # Append model turn (with the function_call parts) to the conversation.
            contents.append(candidate.content)

            # Execute each function call and append its response.
            response_parts = []
            for fc in function_calls:
                name = fc.name
                args = dict(fc.args or {})
                try:
                    result = self.handlers[name](**args)
                    run.tool_calls.append({"name": name, "args": args, "result": result})
                    response_parts.append(
                        types.Part(function_response=types.FunctionResponse(name=name, response={"result": result}))
                    )
                except Exception as e:  # surface errors back to the model
                    err = {"error": str(e)}
                    run.tool_calls.append({"name": name, "args": args, "result": err})
                    response_parts.append(
                        types.Part(function_response=types.FunctionResponse(name=name, response=err))
                    )

            contents.append(types.Content(role="user", parts=response_parts))

        run.answer = run.answer or "(agent reached max steps without a final answer)"
        return run


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "What's the current price and sentiment for BTC?"
    agent = ResearchAgent()
    result = agent.ask(q)
    print("\n=== ANSWER ===\n" + result.answer)
    print("\n=== TOOL CALLS ===")
    print(json.dumps(result.tool_calls, indent=2, default=str))
