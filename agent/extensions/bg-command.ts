/**
 * bg_run — agent-invoked background shell jobs with completion pings.
 *
 * Tool: `bg_run { command }` — starts a detached job (survives pi exit),
 * returns job id + PID + log path immediately, and delivers one bounded,
 * redacted completion ping as a steer message when it exits, so the agent
 * is notified once idle.
 *
 * Command: `/bg` lists jobs started in this session, with a running count.
 *
 * Safety: commands are checked against the shared danger matcher before they
 * start (confirm with UI, reject without UI). Logs live under
 * ~/.pi/agent/bg-logs/ (0600, capped at 20 files, active jobs exempt from
 * rotation). Jobs started before a pi reload lose their ping (the process and
 * its log survive; the tracker does not).
 *
 * Pure logic lives in ./bg-core.ts so plain-node tests can import it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BG_LOG_DIR,
	MAX_ACTIVE_BG_JOBS,
	MAX_BG_LOG_FILES,
	buildBgList,
	buildBgPing,
	bgDangerReason,
	finishBgJob,
	getRunningLogPaths,
	pruneExitedJobs,
	readBgLogTail,
	rotateBgLogs,
	startBgJob,
	truncateBgLog,
	type BgJob,
} from "./shared/bg.ts";

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, BgJob>();

	/** Shared start path for the tool and the /bg command. */
	async function startJob(
		ctx: ExtensionContext,
		command: string,
	): Promise<{ ok: true; id: string; pid: number | undefined; logPath: string } | { ok: false; reason: string }> {
		const danger = bgDangerReason(command);
		if (danger) {
			if (!ctx.hasUI) {
				return { ok: false, reason: `Blocked dangerous command (${danger}): no UI available to confirm.` };
			}
			const approved = await ctx.ui.confirm(`⚠️  Background command (${danger}):`, command);
			if (!approved) return { ok: false, reason: "Blocked by user." };
		}

		// Cap check and spawn happen in one synchronous region (no await between
		// them for non-dangerous commands), so parallel sibling bg_run calls
		// cannot race this check in the single-threaded event loop. Keep it that
		// way: never add an await between here and startBgJob.
		const activeCount = [...jobs.values()].filter((j) => j.state === "running").length;
		if (activeCount >= MAX_ACTIVE_BG_JOBS) {
			return {
				ok: false,
				reason: `Too many background jobs are running (${activeCount}); wait for some to finish or kill them first.`,
			};
		}
		pruneExitedJobs(jobs);

		const failPing = (text: string) => {
			try {
				// Steer, not followUp: pings must inject at the next tool-call
				// boundary while the agent is working, not queue until it settles.
				pi.sendUserMessage(text, { deliverAs: "steer" });
			} catch {
				/* stale instance: log file is the durable record */
			}
		};

		const started = startBgJob({
			command,
			cwd: ctx.cwd,
			onExit: (code, logPath) => {
				finishBgJob(jobs, logPath, code);
				// Completed logs are truncated to a tail so disk stays bounded;
				// the returned tail feeds the ping (never empty on write failure).
				const tail = truncateBgLog(logPath) ?? readBgLogTail(logPath);
				rotateBgLogs(BG_LOG_DIR, getRunningLogPaths(jobs), MAX_BG_LOG_FILES);
				failPing(buildBgPing({ id: started.id, command, logPath }, code, tail));
			},
			onError: (message, logPath) => {
				finishBgJob(jobs, logPath, null);
				rotateBgLogs(BG_LOG_DIR, getRunningLogPaths(jobs), MAX_BG_LOG_FILES);
				failPing(`[bg] Job ${started.id} failed to start: ${message}`);
			},
		});

		jobs.set(started.id, {
			id: started.id,
			command,
			logPath: started.logPath,
			startedAt: Date.now(),
			state: "running",
			exit: null,
		});
		rotateBgLogs(BG_LOG_DIR, getRunningLogPaths(jobs), MAX_BG_LOG_FILES);
		return { ok: true, id: started.id, pid: started.pid, logPath: started.logPath };
	}

	pi.registerTool({
		name: "bg_run",
		label: "bg run",
		description:
			"Start a shell command as a detached background job that keeps running while you continue working. Returns the job id and log path immediately; when the job exits, a completion ping with the log tail arrives as a steer message. Use for long builds, test suites, installs — anything that would block. The job survives pi restarts; check its log file for output. Dangerous commands are confirmed with the user first.",
		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to run in the background",
				minLength: 1,
				maxLength: 100_000,
			}),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await startJob(ctx, params.command);
			if (result.ok === false) {
				return { isError: true, content: [{ type: "text", text: result.reason }], details: {} };
			}
			return {
				content: [
					{
						type: "text",
						text: `Started background job ${result.id} (PID ${result.pid}). Log: ${result.logPath}. A completion ping will arrive as a steer message at the next tool-call boundary.`,
					},
				],
				details: { jobId: result.id, pid: result.pid, logPath: result.logPath },
			};
		},
	});

	pi.registerCommand("bg", {
		description: "List background jobs started in this session (/bg)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildBgList([...jobs.values()]), "info");
		},
	});
}
