/**
 * Steer & Queue Commands
 *
 * Explicit slash-command versions of pi's built-in steering keys
 * (Enter = steer, Alt+Enter = follow-up):
 *
 *   /steer <message>  - inject a message while the agent is working; it is
 *                       delivered at the next tool-call boundary.
 *   /queue <message>  - queue a message for when the agent finishes/stops.
 *
 * When the agent is idle, both behave like a normal message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("steer", {
		description: "Inject a message while the agent is working (/steer <message>)",
		handler: async (args, ctx) => {
			const message = args.trim();
			if (!message) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}
			await pi.sendUserMessage(message, { deliverAs: "steer" });
		},
	});

	pi.registerCommand("queue", {
		description: "Queue a message for when the agent finishes (/queue <message>)",
		handler: async (args, ctx) => {
			const message = args.trim();
			if (!message) {
				ctx.ui.notify("Usage: /queue <message>", "warning");
				return;
			}
			await pi.sendUserMessage(message, { deliverAs: "followUp" });
		},
	});
}
