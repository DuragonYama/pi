#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

printf '\n[1/20] Guard regression tests\n'
node --experimental-strip-types tests/guard.test.ts

printf '\n[2/20] ACP config/model-routing tests\n'
node --experimental-strip-types tests/acp-core.test.ts

printf '\n[3/20] ACP permission-policy tests\n'
node --experimental-strip-types tests/acp-policy.test.ts

printf '\n[4/20] ACP runner session-load tests\n'
node --experimental-strip-types tests/acp-runner.test.ts

printf '\n[5/20] Subagent result/handoff tests\n'
node --experimental-strip-types tests/subagent-core.test.ts

printf '\n[6/20] Subagent background-delegation tests\n'
node --experimental-strip-types tests/subagent-background.test.ts

printf '\n[7/20] Background bash (/bg) tests\n'
node --experimental-strip-types tests/bg-command.test.ts

printf '\n[8/20] Agent-comms MCP server tests (loop-safety + auth boundary)\n'
node --experimental-strip-types tests/comms-server.test.ts

printf '\n[9/20] Persistent-agent roster durability tests\n'
node --experimental-strip-types tests/persistent-agents.test.ts

printf '\n[10/20] Fleet epoch/input-gate tests\n'
node --experimental-strip-types tests/fleet-epoch.test.ts

printf '\n[11/20] /dm pipe-grammar (dm-parse) tests\n'
node --experimental-strip-types tests/dm-parse.test.ts

printf '\n[12/20] dm-exchange render helpers (wrap/hue/sigil/header-fence) tests\n'
node --experimental-strip-types tests/dm-render.test.ts

printf '\n[13/20] /dm @name autocomplete helper tests\n'
node --experimental-strip-types tests/dm-mention.test.ts

printf '\n[14/20] Harness TypeScript gate\n'
./typecheck/node_modules/.bin/tsc -p typecheck/tsconfig.json --noEmit

printf '\n[15/20] Strict web-tools TypeScript gate\n'
# Uses typecheck's tsc on purpose (not web-tools' local tsc) so the gate
# stays one TypeScript install.
./typecheck/node_modules/.bin/tsc -p extensions/web-tools/tsconfig.json --noEmit

printf '\n[16/20] Local extension surface/load gate\n'
grep -q 'name: "subagent"' extensions/subagent/index.ts
grep -q 'name: "bg_run"' extensions/bg-command.ts
if grep -R -q --include='*.ts' 'name: "acp_delegate"' extensions; then
	printf 'ERROR: redundant acp_delegate registration is present\n' >&2
	exit 1
fi
printf '{"type":"get_state"}\n' | pi --mode rpc --offline --no-session >/dev/null

printf '\n[17/20] Web-tools deterministic gate (parser + SSRF + Jina default-off)\n'
# Live ranking/throttling lives in scripts/canary-web-live.sh (manual).
node --experimental-strip-types tests/web-tools-gate.test.ts

DIFF_BASE="${VERIFY_DIFF_BASE:-HEAD^}"
printf '\n[18/20] Git hygiene (worktree + %s..HEAD)\n' "$DIFF_BASE"
git diff --check
git diff --check "$DIFF_BASE..HEAD"

printf '\n[19/20] Usage extension tests\n'
node --experimental-strip-types tests/usage.test.ts

printf '\n[20/20] ACP lane-peek / failure-text tests\n'
node --experimental-strip-types tests/lane-peek.test.ts

printf '\nALL HARNESS CHECKS PASSED\n'
