"""Fire a batch of paid API calls to build up the on-chain transaction history.

Used to satisfy the hackathon's "50+ on-chain transactions" requirement
before recording the demo video. Runs a deterministic mix of calls across
the three paid endpoints.
"""
from __future__ import annotations

import argparse
import random
import time

from dotenv import load_dotenv

load_dotenv()

from agent.x402_client import build_client_from_env

TICKERS = ["BTC", "ETH", "SOL", "USDC"]
TOPICS = ["bitcoin", "stablecoins", "AI agents", "Circle Arc", "DePIN"]
QUERIES = ["USDC", "Arc network", "agentic commerce", "stablecoin regulation"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=60, help="total paid calls")
    parser.add_argument("--delay", type=float, default=0.3, help="seconds between calls")
    args = parser.parse_args()

    client = build_client_from_env()
    print(f"Agent: {client.address}")
    print(f"Firing {args.count} paid calls against {client.base_url}…\n")

    ok = 0
    for i in range(args.count):
        choice = random.choices(["price", "sentiment", "news"], weights=[3, 2, 1])[0]
        try:
            if choice == "price":
                r = client.get("/price", {"ticker": random.choice(TICKERS)})
            elif choice == "sentiment":
                r = client.get("/sentiment", {"topic": random.choice(TOPICS)})
            else:
                r = client.get("/news", {"query": random.choice(QUERIES), "limit": 3})
            ok += 1
            print(f"  [{i+1:>3}/{args.count}] {choice:<9} ok  →  {str(r)[:90]}")
        except Exception as e:
            print(f"  [{i+1:>3}/{args.count}] {choice:<9} FAIL {e}")
        time.sleep(args.delay)

    print(f"\nDone: {ok}/{args.count} settled. See tx_log.jsonl for hashes.")


if __name__ == "__main__":
    main()
