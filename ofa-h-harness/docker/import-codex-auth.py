#!/usr/bin/env python3
"""Bootstrap pi's openai-codex credential from this box's existing codex login.

The fleet-in-a-box runs its L2 orchestrator (and the scout/planner/reviewer/worker
roles) on the `openai-codex` provider — ChatGPT OAuth. pi keeps that token in its
own auth store (~/.pi/agent/auth.json), NOT in ~/.codex. But this machine already
authorized ChatGPT once, for the codex CLI (~/.codex/auth.json). This script
reshapes that SAME token — the box's own, same account — into pi's schema, so no
second browser login is needed.

Nothing leaves the machine. It reads ~/.codex/auth.json and writes
~/.pi/agent/auth.json (mode 600). Secrets are never printed.

Usage:  python3 import-codex-auth.py
Env:    CODEX_AUTH (default ~/.codex/auth.json), PI_AGENT_DIR (default ~/.pi/agent)
"""
import base64
import json
import os
import sys
import time

codex_path = os.environ.get("CODEX_AUTH", os.path.expanduser("~/.codex/auth.json"))
agent_dir = os.environ.get("PI_AGENT_DIR", os.path.expanduser("~/.pi/agent"))
pi_path = os.path.join(agent_dir, "auth.json")


def die(msg):
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


if not os.path.isfile(codex_path):
    die(f"{codex_path} not found — log the codex CLI into ChatGPT on this box first.")

try:
    codex = json.load(open(codex_path))
except Exception as e:
    die(f"could not parse {codex_path}: {e}")

tokens = codex.get("tokens") or {}
access = tokens.get("access_token")
refresh = tokens.get("refresh_token")
account = tokens.get("account_id", "")
if not access or not refresh:
    die("~/.codex/auth.json has no tokens.access_token/refresh_token "
        "(is it an API-key login rather than ChatGPT OAuth?)")


def jwt_exp_ms(tok):
    """Real expiry (ms) from the access JWT's exp claim, or None."""
    try:
        payload = tok.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return int(exp) * 1000 if exp else None
    except Exception:
        return None


# pi refreshes an expired OAuth token on first use via the refresh token, so a
# slightly-stale expiry is self-healing. Prefer the JWT's real exp; fall back to
# a near-future stamp if the token isn't a decodable JWT.
expires = jwt_exp_ms(access) or int((time.time() + 3000) * 1000)

entry = {
    "type": "oauth",
    "access": access,
    "refresh": refresh,
    "expires": expires,
    "accountId": account,
}

# Merge into any existing auth.json rather than clobbering other providers.
existing = {}
if os.path.isfile(pi_path):
    try:
        existing = json.load(open(pi_path))
    except Exception:
        existing = {}
existing["openai-codex"] = entry

os.makedirs(agent_dir, exist_ok=True)
with open(pi_path, "w") as f:
    json.dump(existing, f, indent=2)
os.chmod(pi_path, 0o600)

print(f"wrote openai-codex credential to {pi_path} (mode 600)")
print(f"  account: {account or '(none in token)'}")
print(f"  expires: {time.strftime('%Y-%m-%d %H:%M', time.localtime(expires / 1000))} "
      "(pi auto-refreshes past this)")
print("verify in-container after starting the box:")
print("  docker exec ofa-box pi auth check --provider openai-codex")
