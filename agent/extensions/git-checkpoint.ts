/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 *
 * Untracked-file semantics: `git stash create` captures modified tracked
 * files only. Untracked files are NOT checkpointed — `git stash apply` cannot
 * restore them even when the stash was created with `-u`. Deletions of
 * tracked files ARE captured (the stash records the removal).
 *
 * Retention: checkpoints live until the session is switched or replaced
 * (cleared on session_before_switch), not on agent_end — agent_end can
 * precede retries or queued continuations that still need the checkpoints.
 *
 * Copied from the upstream pi-coding-agent example (examples/extensions/git-checkpoint.ts),
 * with the retention fix applied.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	/** Stash ref taken at turn_start, keyed once the turn's user message exists. */
	let pendingRef: string | undefined;

	/** The id /fork looks up is the user MESSAGE entry, not the live leaf. */
	const lastUserEntryId = (ctx: { sessionManager: { getBranch(): Array<{ id: string; type: string; message?: { role?: string } }> } }) => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message && "role" in entry.message && entry.message.role === "user") {
				return entry.id;
			}
		}
		return undefined;
	};

	// turn_start fires BEFORE the user prompt is persisted. The stash is taken
	// here — the first one of the prompt wins, so inner/retry turns cannot
	// overwrite it — and is bound to the user entry below.
	pi.on("turn_start", async () => {
		if (pendingRef !== undefined) return;
		// Create a git stash entry before LLM makes changes
		const { stdout } = await pi.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref) pendingRef = ref;
	});

	// By the first assistant message_start the user row has been appended to
	// the session tree, so getBranch() finds it. Bind the pending stash to
	// that entry — never to tool_result/assistant leaves, and never to the
	// previous turn's leaf.
	pi.on("message_start", async (_event, ctx) => {
		if (!("role" in _event.message) || _event.message.role !== "assistant") return;
		const userEntryId = lastUserEntryId(ctx);
		if (!userEntryId) return;
		if (pendingRef) {
			// One user turn may contain several post-tool model turns. Preserve
			// the stash captured before that user turn; later inner-turn stashes
			// must never replace it.
			if (!checkpoints.has(userEntryId)) checkpoints.set(userEntryId, pendingRef);
			pendingRef = undefined;
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	// Checkpoints belong to the current session; drop them when it ends.
	pi.on("session_before_switch", async () => {
		checkpoints.clear();
		pendingRef = undefined;
	});
}
