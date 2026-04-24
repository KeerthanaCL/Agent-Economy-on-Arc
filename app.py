"""Streamlit UI for Agent Research Desk.

Left: chat with the Gemini-powered agent (running in agent-ts/ as a TS service).
Right: live transaction log showing every on-chain USDC payment on Arc testnet.

The TS agent handles Gemini function calling + Circle Gateway nanopayments.
Streamlit just POSTs questions to it and reads the shared tx_log.jsonl.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

AGENT_URL = os.environ.get("AGENT_URL", "http://localhost:9000")
TX_LOG_PATH = Path(__file__).resolve().parent / "tx_log.jsonl"
ARC_EXPLORER = "https://explorer.testnet.arc.network/tx/"

st.set_page_config(page_title="Agent Research Desk — Arc", layout="wide")


def load_tx_log() -> list[dict]:
    if not TX_LOG_PATH.exists():
        return []
    out = []
    for line in TX_LOG_PATH.read_text().strip().splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def total_spend(txs: list[dict]) -> float:
    total = 0.0
    for tx in txs:
        price = tx.get("price", "").lstrip("$")
        try:
            total += float(price)
        except ValueError:
            pass
    return total


def ask_agent(question: str) -> dict:
    r = httpx.post(f"{AGENT_URL}/ask", json={"question": question}, timeout=180.0)
    r.raise_for_status()
    return r.json()


# --- Layout ---

st.title("Agent Research Desk")
st.caption("Gemini agent that pays per API call in USDC on Arc testnet via Circle Gateway nanopayments.")

left, right = st.columns([0.6, 0.4], gap="large")

with right:
    st.subheader("On-chain payment log")

    txs = load_tx_log()
    c1, c2, c3 = st.columns(3)
    c1.metric("Payments", len(txs))
    c2.metric("USDC spent", f"${total_spend(txs):.4f}")
    c3.metric("Network", "Arc testnet")

    st.caption("Every paid API call settles as a USDC nanopayment on Arc via Circle Gateway (x402).")

    if not txs:
        st.info("No payments yet. Ask the agent a question to start.")
    else:
        for tx in reversed(txs[-50:]):
            tx_hash = tx.get("tx_hash", "")
            link = f"[{tx_hash[:10]}…]({ARC_EXPLORER}{tx_hash})" if tx_hash else "(pending)"
            caller = tx.get("caller", "research")
            badge = "🤖→🔬" if caller == "analyst" else "👤→🤖"
            st.markdown(
                f"{badge} **{tx['ts']}** · `{tx['path']}` · **{tx['price']}** · {link}  \n"
                f"<span style='color:#888'>caller: {caller} · params: {tx.get('params', {})}</span>",
                unsafe_allow_html=True,
            )

with left:
    st.subheader("Ask the agent")

    if "chat" not in st.session_state:
        st.session_state.chat = []

    for msg in st.session_state.chat:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
            if msg.get("tool_calls"):
                with st.expander(f"Tool calls ({len(msg['tool_calls'])})"):
                    st.json(msg["tool_calls"])

    question = st.chat_input("e.g. What's the latest on ETH — price, sentiment, and news?")
    if question:
        st.session_state.chat.append({"role": "user", "content": question})
        with st.chat_message("user"):
            st.markdown(question)

        with st.chat_message("assistant"):
            with st.spinner("Agent is deciding which paid APIs to hit…"):
                try:
                    result = ask_agent(question)
                    answer = result.get("answer", "")
                    tool_calls = result.get("toolCalls", [])
                    st.markdown(answer)
                    if tool_calls:
                        with st.expander(f"Tool calls ({len(tool_calls)})"):
                            st.json(tool_calls)
                    st.session_state.chat.append({
                        "role": "assistant",
                        "content": answer,
                        "tool_calls": tool_calls,
                    })
                except Exception as e:
                    err = f"Agent error: {e}"
                    st.error(err)
                    st.session_state.chat.append({"role": "assistant", "content": err})

        st.rerun()
