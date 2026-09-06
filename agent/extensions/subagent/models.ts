/**
 * Persisted per-agent model overrides (`subagent-models.json`) and the
 * `/subagent-model` command. Kept as its own sibling so dm-ui.ts stays DM-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";

export function modelOverridesPath(): string {
	return path.join(getAgentDir(), "subagent-models.json");
}

export function loadPersistedModels(filePath: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		/* no overrides yet */
		return {};
	}
}

export function savePersistedModels(filePath: string, persistedModels: Record<string, string>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(persistedModels, null, 2) + "\n");
}

export function registerSubagentModelCommand(
	pi: ExtensionAPI,
	persistedModels: Record<string, string>,
	filePath: string,
): void {
	pi.registerCommand("subagent-model", {
		description: "Pick a model for a subagent (/subagent-model [agent])",
		handler: async (args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "user");
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found", "warning");
				return;
			}

			let agentName = args.trim();
			if (!agentName) {
				agentName = (await ctx.ui.select("Pick an agent", agents.map((a) => a.name))) ?? "";
				if (!agentName) return;
			} else if (!agents.some((a) => a.name === agentName)) {
				ctx.ui.notify(
					`Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ")}`,
					"warning",
				);
				return;
			}

			const agent = agents.find((a) => a.name === agentName)!;
			const current = persistedModels[agentName];
			const currentLabel = current
				? ` (current override: ${current})`
				: agent.model
					? ` (default: ${agent.model})`
					: " (default: inherited)";

			const models = ctx.modelRegistry.getAvailable();
			const options = [`(agent default${currentLabel})`, ...models.map((m) => `${m.provider}/${m.id}`)];

			const choice = await ctx.ui.select(`Model for ${agentName}`, options);
			if (!choice) return;

			if (choice.startsWith("(agent default")) {
				delete persistedModels[agentName];
				ctx.ui.notify(`${agentName} → agent default`, "info");
			} else {
				persistedModels[agentName] = choice;
				ctx.ui.notify(`${agentName} → ${choice}`, "info");
			}
			savePersistedModels(filePath, persistedModels);
		},
	});
}
