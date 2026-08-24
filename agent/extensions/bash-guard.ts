/**
 * Bash Guard
 *
 * Prompts for confirmation before the agent runs potentially destructive or
 * system-affecting shell commands. Based on the upstream permission-gate.ts
 * example, extended with a curated pattern list (shared with the ACP
 * permission policy) and a session-scoped allowlist so legitimate work is not
 * blocked repeatedly.
 *
 * - Interactive: select Allow once / Allow for this session / Block.
 * - Non-interactive (pi -p, RPC): dangerous commands are blocked by default.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findDangerous } from "./shared/danger.ts";

export default function (pi: ExtensionAPI) {
	// Labels the user approved for the remainder of this session.
	const sessionAllowed = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = String(event.input.command ?? "");
		const hit = findDangerous(command);
		if (!hit) return undefined;
		if (sessionAllowed.has(hit.label)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Dangerous command (${hit.label}) blocked: no UI available for confirmation. Run it yourself if intentional.`,
			};
		}

		const choice = await ctx.ui.select(`⚠️  Bash guard: ${hit.label}\n\n  ${command}\n`, [
			"Allow once",
			"Allow for this session",
			"Block",
		]);

		if (choice === "Allow for this session") {
			sessionAllowed.add(hit.label);
			return undefined;
		}

		if (choice !== "Allow once") {
			return { block: true, reason: `Blocked by user (${hit.label})` };
		}

		return undefined;
	});

	// Session-scoped approvals must not leak across sessions.
	pi.on("session_before_switch", () => {
		sessionAllowed.clear();
	});
}
