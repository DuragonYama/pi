/**
 * Auto Session Name
 *
 * Names interactive sessions from the first user message so the session picker
 * (/resume, pi -r) shows a meaningful title instead of the raw first message.
 *
 * Manual naming stays available with the built-in /name command; this extension
 * only sets a name when none exists yet. One-shot and RPC sessions are skipped.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_LENGTH = 48;

function nameFrom(text: string): string | undefined {
	const clean = text.trim().replace(/\s+/g, " ");
	if (!clean || clean.startsWith("/")) return undefined;
	if (clean.length <= MAX_NAME_LENGTH) return clean;
	return `${clean.slice(0, MAX_NAME_LENGTH).trimEnd()}…`;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		// Only name interactive, idle conversations without an existing name.
		if (event.source !== "interactive") return { action: "continue" };
		if (event.streamingBehavior) return { action: "continue" };
		if (pi.getSessionName()) return { action: "continue" };

		const name = nameFrom(event.text);
		if (name) pi.setSessionName(name);

		return { action: "continue" };
	});
}
