"""x402 client wrapper used by the agent to pay for each API call.

Responsibilities:
  1. Sign EIP-3009 payment authorizations with a local EOA (eth-account).
  2. Handle the 402 -> retry-with-payment handshake automatically.
  3. Append every settled payment to tx_log.jsonl so the UI can display proof.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from eth_account import Account
from x402 import x402Client
from x402.mechanisms.evm.exact import ExactEvmScheme

TX_LOG_PATH = Path(__file__).resolve().parent.parent / "tx_log.jsonl"


class PaidAPIClient:
    """HTTP client that pays per call using x402."""

    def __init__(
        self,
        private_key: str,
        base_url: str,
        network: str,
        tx_log_path: Path = TX_LOG_PATH,
    ) -> None:
        self.account = Account.from_key(private_key)
        self.base_url = base_url.rstrip("/")
        self.network = network
        self.tx_log_path = tx_log_path

        self.x402 = x402Client()
        self.x402.register("eip155:*", ExactEvmScheme(signer=self.account))

        self._http = httpx.Client(timeout=30.0)

    @property
    def address(self) -> str:
        return self.account.address

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        """GET a paid endpoint — pays on first 402, returns JSON body on success."""
        url = f"{self.base_url}{path}"
        params = params or {}
        t0 = time.time()

        # First attempt (unpaid) — expect 402
        r = self._http.get(url, params=params)

        if r.status_code == 402:
            payment_required = r.json()
            payload = self.x402.create_payment_payload(payment_required)
            r = self._http.get(
                url,
                params=params,
                headers={"X-PAYMENT": payload.encoded()},
            )

        r.raise_for_status()
        elapsed_ms = int((time.time() - t0) * 1000)

        # Settlement info is returned by the server in X-PAYMENT-RESPONSE
        settlement = r.headers.get("X-PAYMENT-RESPONSE", "")
        tx_hash = _extract_tx_hash(settlement)
        price = _extract_price(r, path)

        self._log_tx(path=path, params=params, tx_hash=tx_hash, price=price, latency_ms=elapsed_ms)
        return r.json()

    def _log_tx(self, *, path: str, params: dict, tx_hash: str, price: str, latency_ms: int) -> None:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "path": path,
            "params": params,
            "price": price,
            "tx_hash": tx_hash,
            "network": self.network,
            "from": self.address,
            "latency_ms": latency_ms,
        }
        with self.tx_log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")


def _extract_tx_hash(settlement_header: str) -> str:
    """Settlement header is base64/JSON with a 'transaction' field; tolerate either."""
    if not settlement_header:
        return ""
    try:
        import base64

        raw = base64.b64decode(settlement_header).decode()
        data = json.loads(raw)
        return data.get("transaction") or data.get("txHash") or ""
    except Exception:
        try:
            data = json.loads(settlement_header)
            return data.get("transaction") or data.get("txHash") or ""
        except Exception:
            return ""


def _extract_price(response: httpx.Response, path: str) -> str:
    prices = {"/price": "$0.001", "/sentiment": "$0.002", "/news": "$0.005"}
    return prices.get(path, "")


def build_client_from_env() -> PaidAPIClient:
    return PaidAPIClient(
        private_key=os.environ["AGENT_PRIVATE_KEY"],
        base_url=os.environ.get("API_BASE_URL", "http://localhost:8000"),
        network=os.environ["ARC_NETWORK"],
    )
