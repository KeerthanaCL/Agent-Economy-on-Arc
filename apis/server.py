"""Paid micro-APIs gated by x402 on Arc testnet.

Three endpoints demonstrate per-call USDC pricing at sub-cent amounts:
  GET /price      $0.001 — mock market price for a ticker
  GET /sentiment  $0.002 — mock sentiment score for a topic
  GET /news       $0.005 — mock news headlines for a query

Each call requires a valid x402 payment header settled on Arc testnet.
"""
import os
import random
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, Query
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http import HTTPFacilitatorClient, FacilitatorConfig, PaymentOption
from x402.http.types import RouteConfig
from x402.server import x402ResourceServer
from x402.mechanisms.evm.exact import ExactEvmServerScheme

load_dotenv()

NETWORK = os.environ["ARC_NETWORK"]
FACILITATOR_URL = os.environ["FACILITATOR_URL"]
MERCHANT_PRICE = os.environ["MERCHANT_PRICE_ADDRESS"]
MERCHANT_SENTIMENT = os.environ["MERCHANT_SENTIMENT_ADDRESS"]
MERCHANT_NEWS = os.environ["MERCHANT_NEWS_ADDRESS"]

app = FastAPI(title="Agent Research Desk — Paid APIs on Arc")

server = x402ResourceServer(HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL)))
server.register(NETWORK, ExactEvmServerScheme())

routes = {
    "GET /price": RouteConfig(
        accepts=[PaymentOption(scheme="exact", price="$0.001", network=NETWORK, pay_to=MERCHANT_PRICE)]
    ),
    "GET /sentiment": RouteConfig(
        accepts=[PaymentOption(scheme="exact", price="$0.002", network=NETWORK, pay_to=MERCHANT_SENTIMENT)]
    ),
    "GET /news": RouteConfig(
        accepts=[PaymentOption(scheme="exact", price="$0.005", network=NETWORK, pay_to=MERCHANT_NEWS)]
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/")
def index():
    return {
        "service": "Agent Research Desk — Paid APIs",
        "network": NETWORK,
        "endpoints": {
            "/price": "$0.001 per call",
            "/sentiment": "$0.002 per call",
            "/news": "$0.005 per call",
        },
    }


@app.get("/price")
def price(ticker: str = Query("BTC")):
    base = {"BTC": 68000, "ETH": 3400, "SOL": 180, "USDC": 1}.get(ticker.upper(), 100)
    return {
        "ticker": ticker.upper(),
        "price_usd": round(base * random.uniform(0.98, 1.02), 2),
        "ts": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/sentiment")
def sentiment(topic: str = Query(...)):
    score = round(random.uniform(-1, 1), 3)
    label = "bullish" if score > 0.2 else "bearish" if score < -0.2 else "neutral"
    return {
        "topic": topic,
        "score": score,
        "label": label,
        "ts": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/news")
def news(query: str = Query(...), limit: int = Query(3, ge=1, le=5)):
    headlines = [
        f"{query}: market analysts revise outlook after Q1 data",
        f"Institutional inflows into {query} hit 12-week high",
        f"{query}: regulators signal clearer guidance coming",
        f"On-chain activity for {query} up 8% week-over-week",
        f"{query} adoption accelerates among mid-market firms",
    ]
    return {
        "query": query,
        "items": random.sample(headlines, k=min(limit, len(headlines))),
        "ts": datetime.now(timezone.utc).isoformat(),
    }
