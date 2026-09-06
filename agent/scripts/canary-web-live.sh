#!/bin/bash
# Live web-tools canary (search ranking + fetch). NOT part of verify-harness.
# Needs network. After web-tools `npm install --omit=dev`, tsx is gone — this
# script uses node --experimental-strip-types against test/smoke.ts instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/extensions/web-tools"
if [ -x node_modules/.bin/tsx ]; then
	exec npm test
fi
printf 'tsx missing (web-tools was installed with --omit=dev). npm install tsx (or a full install) then re-run.\n' >&2
exit 1
