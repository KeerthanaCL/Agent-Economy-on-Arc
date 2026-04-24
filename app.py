"""Streamlit UI for Agent Research Desk.

Left:  chat with the research agent (running in agent-ts/ on :9000).
Right: live transaction log + budget + trust score table.

All the business logic lives in the three TS services; Streamlit just posts
questions and reads shared state (tx_log.jsonl, trust.json).
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
ROOT = Path(__file__).resolve().parent
TX_LOG_PATH = ROOT / "tx_log.jsonl"
TRUST_PATH = ROOT / "trust.json"
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


def load_trust() -> dict[str, dict]:
    if not TRUST_PATH.exists():
        return {}
    try:
        return json.loads(TRUST_PATH.read_text())
    except Exception:
        return {}


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


def trust_color(score: int) -> str:
    if score >= 90:
        return "🟢"
    if score >= 70:
        return "🟡"
    return "🔴"


# ───────── Layout ─────────────────────────────────────────────────────────

st.title("Agent Research Desk")
st.caption(
    "Cross-provider agent marketplace on Arc testnet. Research agent "
    "(GPT-4o-mini) picks between two competing analyst agents (Gemini 2.5 "
    "Flash $0.020 · GPT-4o-mini $0.030) by trust-score-per-USD. All settled "
    "in USDC via Circle Gateway nanopayments."
)

left, right = st.columns([0.6, 0.4], gap="large")

# ───────── Right column: tx log + trust + totals ──────────────────────────

with right:
    txs = load_tx_log()
    trust = load_trust()

    c1, c2, c3 = st.columns(3)
    c1.metric("Payments", len(txs))
    c2.metric("USDC spent", f"${total_spend(txs):.4f}")
    c3.metric("Network", "Arc testnet")

    st.subheader("Trust scores")
    if not trust:
        st.info("No trust data yet. Ask the agent something to populate.")
    else:
        rows = []
        for path, entry in sorted(trust.items()):
            rows.append({
                "endpoint": path,
                "score": f"{trust_color(entry['score'])} {entry['score']}/100",
                "calls": entry["calls"],
                "viol": entry["violations"],
            })
        st.dataframe(rows, hide_index=True, use_container_width=True)
        st.caption(
            "Each paid response is sanity-checked. Violations drop the score "
            "by 10; clean calls slowly rebuild it. The research agent picks "
            "between `/synthesis@gemini` ($0.02) and `/synthesis@premium` "
            "($0.03) by **trust / price** — highest score wins."
        )

    st.subheader("On-chain payment log")
    if not txs:
        st.info("No payments yet. Ask the agent a question to start.")
    else:
        for tx in reversed(txs[-50:]):
            tx_hash = tx.get("tx_hash", "")
            link = f"[{tx_hash[:10]}…]({ARC_EXPLORER}{tx_hash})" if tx_hash else "(pending)"
            caller = tx.get("caller", "research")
            provider = tx.get("provider", "")
            badge = "🤖→🔬" if caller.startswith("analyst") else "👤→🤖"
            provider_tag = f" → **{provider}**" if provider else ""
            st.markdown(
                f"{badge} **{tx['ts']}** · `{tx['path']}`{provider_tag} · **{tx['price']}** · {link}  \n"
                f"<span style='color:#888'>caller: {caller} · params: {tx.get('params', {})}</span>",
                unsafe_allow_html=True,
            )

# ───────── Left column: chat ──────────────────────────────────────────────

with left:
    st.subheader("Ask the agent")

    if "chat" not in st.session_state:
        st.session_state.chat = []

    for msg in st.session_state.chat:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
            if msg.get("spend"):
                s = msg["spend"]
                pct = min(s.get("pct", 0) / 100.0, 1.0)
                label = (
                    f"Spend: ${s['total_usd']:.4f} / ${s['budget_usd']:.3f} "
                    f"({s['pct']:.1f}%)"
                )
                if s.get("exhausted"):
                    label += " ⚠️ budget exhausted — agent skipped some tools"
                st.progress(pct, text=label)
            if msg.get("tool_calls"):
                with st.expander(f"Tool calls ({len(msg['tool_calls'])})"):
                    st.json(msg["tool_calls"])

    question = st.chat_input("e.g. Give me a full analyst report on ETH with a rating.")
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
                    spend = result.get("spend", {})

                    st.markdown(answer)
                    if spend:
                        pct = min(spend.get("pct", 0) / 100.0, 1.0)
                        label = (
                            f"Spend: ${spend['total_usd']:.4f} / "
                            f"${spend['budget_usd']:.3f} ({spend['pct']:.1f}%)"
                        )
                        if spend.get("exhausted"):
                            label += " ⚠️ budget exhausted"
                        st.progress(pct, text=label)
                    if tool_calls:
                        with st.expander(f"Tool calls ({len(tool_calls)})"):
                            st.json(tool_calls)

                    st.session_state.chat.append({
                        "role": "assistant",
                        "content": answer,
                        "tool_calls": tool_calls,
                        "spend": spend,
                    })
                except Exception as e:
                    err = f"Agent error: {e}"
                    st.error(err)
                    st.session_state.chat.append({"role": "assistant", "content": err})

        st.rerun()
