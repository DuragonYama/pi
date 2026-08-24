#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

printf '\n[1/18] Guard regression tests\n'
node --experimental-strip-types tests/guard.test.ts

printf '\n[2/18] ACP config/model-routing tests\n'
node --experimental-strip-types tests/acp-core.test.ts

printf '\n[3/18] ACP permission-policy tests\n'
node --experimental-strip-types tests/acp-policy.test.ts

printf '\n[4/18] ACP runner session-load tests\n'
node --experimental-strip-types tests/acp-runner.test.ts

printf '\n[5/18] Subagent result/handoff tests\n'
node --experimental-strip-types tests/subagent-core.test.ts

printf '\n[6/18] Subagent background-delegation tests\n'
node --experimental-strip-types tests/subagent-background.test.ts

printf '\n[7/18] Background bash (/bg) tests\n'
node --experimental-strip-types tests/bg-command.test.ts

printf '\n[8/18] Agent-comms MCP server tests (loop-safety + auth boundary)\n'
node --experimental-strip-types tests/comms-server.test.ts

printf '\n[9/18] Persistent-agent roster durability tests\n'
node --experimental-strip-types tests/persistent-agents.test.ts

printf '\n[10/18] Fleet epoch/input-gate tests\n'
node --experimental-strip-types tests/fleet-epoch.test.ts

printf '\n[11/18] /dm pipe-grammar (dm-parse) tests\n'
node --experimental-strip-types tests/dm-parse.test.ts

printf '\n[12/18] dm-exchange render helpers (wrap/hue/sigil/header-fence) tests\n'
node --experimental-strip-types tests/dm-render.test.ts

printf '\n[13/18] /dm @name autocomplete helper tests\n'
node --experimental-strip-types tests/dm-mention.test.ts

printf '\n[14/18] Harness TypeScript gate\n'
./typecheck/node_modules/.bin/tsc -p typecheck/tsconfig.json --noEmit

printf '\n[15/18] Strict web-tools TypeScript gate\n'
./extensions/web-tools/node_modules/.bin/tsc -p extensions/web-tools/tsconfig.json --noEmit

printf '\n[16/18] Local extension surface/load gate\n'
grep -q 'name: "subagent"' extensions/subagent/index.ts
grep -q 'name: "bg_run"' extensions/bg-command.ts
if grep -R -q --include='*.ts' 'name: "acp_delegate"' extensions; then
	printf 'ERROR: redundant acp_delegate registration is present\n' >&2
	exit 1
fi
printf '{"type":"get_state"}\n' | pi --mode rpc --offline --no-session >/dev/null

printf '\n[17/18] Web tool smoke tests (live canary)\n'
(
	cd extensions/web-tools
	# Live search-engine ranking is a canary, not a local code check: the
	# engines churn rankings and throttle automated queries. Retry a few
	# times, then warn instead of failing the gate.
	attempt=0
	while true; do
		if npm test; then
			break
		fi
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 3 ]; then
			printf 'WARN: web smoke canary failed after %d attempts (live search ranking drift/throttling). Web unit behavior is covered elsewhere; re-run manually later.\n' "$attempt"
			break
		fi
		printf 'web smoke attempt %d failed, retrying in 15s...\n' "$attempt"
		sleep 15
	done
)

DIFF_BASE="${VERIFY_DIFF_BASE:-HEAD^}"
printf '\n[18/18] Git hygiene (worktree + %s..HEAD)\n' "$DIFF_BASE"
git diff --check
git diff --check "$DIFF_BASE..HEAD"

printf '\nALL HARNESS CHECKS PASSED\n'
