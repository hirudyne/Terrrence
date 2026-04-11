"""
Mint a new API key.

Generates a fresh random key, stores its argon2 hash in api_keys, and prints
the plaintext key to stdout exactly once. The plaintext is never persisted.

Usage:
    python3 mint_key.py [--label LABEL]
"""
import argparse
import os
import secrets
import sqlite3
import sys
from pathlib import Path

from argon2 import PasswordHasher

DB_PATH = Path(os.environ.get("TERRRENCE_DB", "/workspace/data/terrrence.db"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default=None, help="human-friendly name for this key")
    args = ap.parse_args()

    if not DB_PATH.exists():
        sys.exit(f"DB not found at {DB_PATH}; apply schema.sql first")

    key = "trk_" + secrets.token_urlsafe(32)
    ph = PasswordHasher()
    h = ph.hash(key)

    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute(
            "INSERT INTO api_keys (key_hash, label) VALUES (?, ?)",
            (h, args.label),
        )
        conn.commit()
        key_id = cur.lastrowid
    finally:
        conn.close()

    print(f"id:    {key_id}")
    if args.label:
        print(f"label: {args.label}")
    print(f"key:   {key}")
    print()
    print("This key will not be shown again. Store it now.")


if __name__ == "__main__":
    main()
