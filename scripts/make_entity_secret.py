"""One-off: generate a Circle Entity Secret + its ciphertext.

Run once, paste the ciphertext into Circle Console, paste the entity
secret into .env, never run again.

Usage:
    python scripts/make_entity_secret.py
"""
from __future__ import annotations

import base64
import os
import secrets
import sys

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ.get("CIRCLE_API_KEY")
if not API_KEY:
    print("ERROR: CIRCLE_API_KEY not set in .env")
    sys.exit(1)

# 1. Generate a random 32-byte (64 hex char) entity secret.
entity_secret_hex = secrets.token_hex(32)
entity_secret_bytes = bytes.fromhex(entity_secret_hex)

# 2. Fetch Circle's RSA public key.
print("Fetching Circle's RSA public key…")
resp = requests.get(
    "https://api.circle.com/v1/w3s/config/entity/publicKey",
    headers={"Authorization": f"Bearer {API_KEY}"},
    timeout=15,
)
if resp.status_code != 200:
    print(f"ERROR fetching public key: {resp.status_code} {resp.text}")
    sys.exit(1)

public_key_pem = resp.json()["data"]["publicKey"]
public_key = serialization.load_pem_public_key(public_key_pem.encode())

# 3. RSA-OAEP-SHA256 encrypt the entity secret, then base64 encode.
ciphertext = public_key.encrypt(
    entity_secret_bytes,
    padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None,
    ),
)
ciphertext_b64 = base64.b64encode(ciphertext).decode()

print()
print("=" * 70)
print("STEP 1 — Paste THIS into Circle Console (Entity Secret Ciphertext):")
print("=" * 70)
print(ciphertext_b64)
print()
print("=" * 70)
print("STEP 2 — Paste THIS into .env as CIRCLE_ENTITY_SECRET:")
print("=" * 70)
print(entity_secret_hex)
print()
print("=" * 70)
print("IMPORTANT: save the entity secret somewhere safe. If you lose it,")
print("you must register a NEW one (the old wallets stay, new ones can't")
print("be created).")
print("=" * 70)
