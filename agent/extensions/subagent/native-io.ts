/**
 * Native-child I/O: temp system-prompt files, pi argv resolution, and the
 * stdout/stderr byte caps the native runner applies.
 *
 * `writePromptToTempFile` takes a `queueWrite` dep so this module stays
 * plain-node-importable (no runtime import of `@earendil-works/pi-coding-agent`).
 * The runner passes `withFileMutationQueue` at the call site — same write
 * path, mode 0o600, live-dir tracking.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STDERR_TAIL_BYTES = 16 * 1024;
export const RPC_PARTIAL_LINE_CAP_BYTES = 1024 * 1024;
export const NATIVE_MESSAGES_CAP_BYTES = 1024 * 1024;

const liveTmpPromptDirs = new Set<string>();

/** Best-effort sweep of native-child prompt temp dirs. SIGKILL of pi cannot run this. */
export function cleanupLiveTmpPromptDirs(): void {
	for (const dir of [...liveTmpPromptDirs]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* already gone */
		}
		liveTmpPromptDirs.delete(dir);
	}
}

/** Forget a temp dir after the runner's success-path rmdir (original liveTmpPromptDirs.delete). */
export function forgetLiveTmpPromptDir(dir: string): void {
	liveTmpPromptDirs.delete(dir);
}

/**
 * Serialized write, matching `withFileMutationQueue` from the pi package.
 * Injected so this file never value-imports that package.
 */
export type QueueWrite = <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;

export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
	queueWrite: QueueWrite,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await queueWrite(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
		liveTmpPromptDirs.add(tmpDir);
		return { dir: tmpDir, filePath };
	} catch (error) {
		// Don't leak the temp dir if the write itself fails.
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		throw error;
	}
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}
