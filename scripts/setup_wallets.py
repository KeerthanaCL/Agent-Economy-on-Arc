"""One-time setup: generate the wallets this demo needs.

Generates:
  - 1 agent EOA (used for x402 client signing)
  - 3 merchant EOAs (receive USDC per API call)

Prints the .env block to paste, plus funding instructions from the Arc faucet.

If CIRCLE_API_KEY is set, also creates a developer-controlled Circle wallet
to demonstrate Circle Wallets integration (optional — the demo runs without it).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from eth_account import Account

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
WALLETS_FILE = ROOT / "wallets.json"


def generate_eoa() -> dict:
    acct = Account.create()
    return {"address": acct.address, "private_key": acct.key.hex()}


def maybe_create_circle_wallet() -> dict | None:
    """Optionally create a Circle developer-controlled wallet on Arc testnet."""
    api_key = os.environ.get("CIRCLE_API_KEY")
    entity_secret = os.environ.get("CIRCLE_ENTITY_SECRET")
    if not api_key or not entity_secret:
        return None
    try:
        from circle.web3 import developer_controlled_wallets, utils
    except Exception as e:
        print(f"[warn] circle-developer-controlled-wallets not installed: {e}")
        return None

    try:
        client = utils.init_developer_controlled_wallets_client(
            api_key=api_key, entity_secret=entity_secret
        )
        ws_api = developer_controlled_wallets.WalletSetsApi(client)
        ws = ws_api.create_wallet_set(
            developer_controlled_wallets.CreateWalletSetRequest(name="agent-research-desk")
        ).data.wallet_set

        w_api = developer_controlled_wallets.WalletsApi(client)
        wallets = w_api.create_wallet(
            developer_controlled_wallets.CreateWalletRequest(
                account_type="EOA",
                blockchains=["ARC-TESTNET"],
                wallet_set_id=ws.id,
                count=1,
            )
        ).data.wallets
        w = wallets[0]
        return {"wallet_set_id": ws.id, "wallet_id": w.id, "address": w.address}
    except Exception as e:
        print(f"[warn] Circle wallet creation failed: {e}")
        return None


def main() -> None:
    print("Generating wallets…\n")

    wallets = {
        "agent": generate_eoa(),
        "merchant_price": generate_eoa(),
        "merchant_sentiment": generate_eoa(),
        "merchant_news": generate_eoa(),
    }

    circle = maybe_create_circle_wallet()
    if circle:
        wallets["circle_wallet"] = circle
        print(f"[ok] Created Circle Wallet on ARC-TESTNET: {circle['address']}")

    WALLETS_FILE.write_text(json.dumps(wallets, indent=2))
    print(f"[ok] Saved to {WALLETS_FILE}\n")

    print("=" * 60)
    print("Paste this into your .env:")
    print("=" * 60)
    print(f"AGENT_PRIVATE_KEY={wallets['agent']['private_key']}")
    print(f"AGENT_ADDRESS={wallets['agent']['address']}")
    print(f"MERCHANT_PRICE_ADDRESS={wallets['merchant_price']['address']}")
    print(f"MERCHANT_SENTIMENT_ADDRESS={wallets['merchant_sentiment']['address']}")
    print(f"MERCHANT_NEWS_ADDRESS={wallets['merchant_news']['address']}")
    print()
    print("=" * 60)
    print("Fund the AGENT wallet with Arc testnet USDC:")
    print("=" * 60)
    print(f"  1. Go to https://faucet.circle.com/")
    print(f"  2. Select network: Arc Testnet")
    print(f"  3. Paste agent address: {wallets['agent']['address']}")
    print(f"  4. Request USDC (10 USDC covers ~thousands of calls)")
    print()
    print("The merchant wallets do NOT need to be funded — they only receive.")


if __name__ == "__main__":
    main()
