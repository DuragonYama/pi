/**
 * /bg extension tests — run with: node --experimental-strip-types bg-command.test.ts
 * Covers ping bounding/redaction, listing, log rotation, and a real spawn with
 * the completion callback.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BG_PING_MAX_BYTES,
	buildBgList,
	buildBgPing,
	finishBgJob,
	getRunningLogPaths,
	MAX_ACTIVE_BG_JOBS,
	newJobId,
	pruneExitedJobs,
	readBgLogTail,
	rotateBgLogs,
	startBgJob,
	truncateBgLog,
	type BgJob,
} from "../extensions/shared/bg.ts";

// --- newJobId: format + collision resistance ---
const id = newJobId(new Date(2026, 7, 14, 12, 34, 56));
assert.match(id, /^20260814-123456-[0-9a-f]{8}$/);
const ids = new Set<string>();
for (let i = 0; i < 200; i++) ids.add(newJobId(new Date(2026, 7, 14, 12, 34, 56)));
assert.equal(ids.size, 200, "IDs must not collide within the same clock tick");

// --- buildBgPing: shape, bounding, redaction ---
const job = { id: "j1", command: "make build", logPath: "/tmp/x.log" };
const ping = buildBgPing(job, 0, "hello world\n");
assert.match(ping, /\[bg\] Job j1 exited \(code 0\)/);
assert.match(ping, /Command: make build/);
assert.match(ping, /Log: \/tmp\/x\.log/);
assert.match(ping, /hello world/);

const secretPing = buildBgPing({ id: "j1", command: "curl https://x/api?token=sk-secret123", logPath: "/tmp/x.log" }, 1, "curl https://x/api?token=sk-secret123&a=1");
assert.ok(!secretPing.includes("sk-secret123"), "secrets must be redacted from pings");
assert.match(secretPing, /token=REDACTED/);

const huge = "x".repeat(100_000);
const bounded = buildBgPing(job, 0, huge);
assert.ok(Buffer.byteLength(bounded, "utf8") <= BG_PING_MAX_BYTES, "ping must stay bounded");
assert.ok(bounded.length < huge.length, "long logs must be tailed");

// Redaction must happen before the secret label is discarded by tailing.
const longSecret = `token=${"s".repeat(2_000)}`;
const longSecretPing = buildBgPing(job, 0, longSecret);
assert.ok(!longSecretPing.includes("s".repeat(32)), "a long secret value must not leak when its label is outside the tail");

// Final bounding must preserve the absolute newest output, even with a long header.
const newestMarker = "ABSOLUTE-NEWEST-MARKER";
const newestPing = buildBgPing(
	{ id: "j2", command: "x".repeat(200), logPath: `/tmp/${"p".repeat(500)}.log` },
	0,
	`${"o".repeat(2_000)}${newestMarker}`,
);
assert.ok(newestPing.includes(newestMarker), "completion ping must retain the newest log output");

// --- buildBgList: count line first ---
const list = buildBgList([
	{ id: "a", command: "make build", logPath: "/tmp/a.log", startedAt: 1, state: "running", exit: null },
	{ id: "b", command: "npm test", logPath: "/tmp/b.log", startedAt: 2, state: "exited", exit: 0 },
]);
assert.match(list, /1 running, 1 finished/);
assert.match(list, /\[running\] a:/);
assert.match(list, /\[exited 0\] b:/);
assert.match(buildBgList([]), /No background jobs/);
const twentyOneFinished = Array.from({ length: 21 }, (_, i): BgJob => ({
	id: `done-${i}`,
	command: "x",
	logPath: `/tmp/done-${i}.log`,
	startedAt: i,
	state: "exited",
	exit: 0,
}));
assert.match(buildBgList(twentyOneFinished), /1 more job omitted/, "listing must report every omitted job");

// --- rotateBgLogs: cap + active exemption ---
const dir = mkdtempSync(join(tmpdir(), "bg-test-"));
try {
	for (let i = 0; i < 5; i++) {
		writeFileSync(join(dir, `bg-${i}.log`), "x");
		utimesSync(join(dir, `bg-${i}.log`), new Date(1000 + i), new Date(1000 + i));
	}
	const active = new Set([join(dir, "bg-0.log")]); // oldest is active
	rotateBgLogs(dir, active, 2);
	const remaining = statSyncSafe(dir);
	assert.equal(remaining.includes("bg-1.log"), false, "oldest inactive must be deleted");
	assert.equal(remaining.includes("bg-2.log"), false);
	assert.equal(remaining.includes("bg-3.log"), true);
	assert.equal(remaining.includes("bg-4.log"), true);
	assert.equal(remaining.includes("bg-0.log"), true, "active jobs are exempt from rotation");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
function statSyncSafe(dir: string): string[] {
	return readdirSync(dir);
}

// --- startBgJob: real spawn, completion callback, error handling, exclusivity ---
const out = await new Promise<string>((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("bg job did not complete")), 10_000);
	const started = startBgJob({
		command: "echo bg-ok",
		cwd: process.cwd(),
		onExit: (code, logPath) => {
			clearTimeout(timeout);
			resolve(`${code}:${logPath.split("/").pop()}:${readFileSync(logPath, "utf8").trim()}`);
		},
		onError: (message) => reject(new Error(`unexpected spawn error: ${message}`)),
	});
	if (started.pid === undefined) reject(new Error("no pid"));
});
assert.match(out, /^0:bg-.*\.log:bg-ok$/, `unexpected result: ${out}`);

// Detached logging must remain byte-bounded while the command is still alive,
// not only after Pi receives its completion callback.
{
	let resolveExit!: () => void;
	let rejectExit!: (error: Error) => void;
	const exited = new Promise<void>((resolve, reject) => {
		resolveExit = resolve;
		rejectExit = reject;
	});
	const timeout = setTimeout(() => rejectExit(new Error("bounded writer job did not exit")), 10_000);
	const started = startBgJob({
		command: `node -e 'process.stdout.write("x".repeat(3 * 1024 * 1024)); setTimeout(() => {}, 1500)'`,
		cwd: process.cwd(),
		onExit: () => {
			clearTimeout(timeout);
			resolveExit();
		},
		onError: (message) => {
			clearTimeout(timeout);
			rejectExit(new Error(`unexpected bounded-writer error: ${message}`));
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.ok(statSync(started.logPath).size <= 1024 * 1024, "live detached log must stay within 1 MiB");
	await exited;
	assert.ok(statSync(started.logPath).size <= 64 * 1024, "helper must leave a bounded tail even if Pi exits first");
}

// Spawn failure must route through onError, never an unhandled event, and
// must never fire onExit. A sync throw is NOT success: it must not occur for
// the invalid-cwd case.
const spawnErr = await new Promise<string>((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("onError never fired")), 10_000);
	startBgJob({
		command: "echo hi",
		cwd: "/nonexistent-dir-" + Date.now(),
		onExit: () => reject(new Error("onExit fired on spawn failure")),
		onError: (message) => {
			clearTimeout(timeout);
			resolve(`onerror:${message}`);
		},
	});
});
assert.match(spawnErr, /^onerror:/, "invalid cwd must route through onError, not throw");

// Exclusive creation: two sibling starts in the same tick get distinct logs.
const pair = await new Promise<string[]>((resolve, reject) => {
	const results: string[] = [];
	const timeout = setTimeout(() => reject(new Error("jobs did not finish")), 10_000);
	let done = 0;
	const onFinish = () => {
		done += 1;
		if (done === 2) {
			clearTimeout(timeout);
			resolve(results);
		}
	};
	startBgJob({
		command: "echo a",
		cwd: process.cwd(),
		onExit: (code, logPath) => {
			results.push(logPath);
			onFinish();
		},
		onError: () => onFinish(),
	});
	startBgJob({
		command: "echo b",
		cwd: process.cwd(),
		onExit: (code, logPath) => {
			results.push(logPath);
			onFinish();
		},
		onError: () => onFinish(),
	});
});
assert.equal(pair.length, 2);
assert.notEqual(pair[0], pair[1], "sibling jobs must not share a log file");

// --- readBgLogTail: bounded offset reads, UTF-8-safe at the split ---
const bigLog = mkdtempSync(join(tmpdir(), "bg-tail-"));
try {
	const bigPath = join(bigLog, "big.log");
	writeFileSync(bigPath, "a".repeat(2 * 1024 * 1024) + "TAILMARK");
	const tailRead = readBgLogTail(bigPath, 800);
	assert.ok(tailRead.endsWith("TAILMARK"));
	assert.ok(Buffer.byteLength(tailRead, "utf8") <= 800);
	// No U+FFFD from a mid-sequence readAt boundary (2-byte AND 4-byte chars).
	writeFileSync(bigPath, "é".repeat(100_000) + "ENDMARK");
	const utf8Tail = readBgLogTail(bigPath, 800);
	assert.ok(utf8Tail.endsWith("ENDMARK"));
	assert.ok(!utf8Tail.includes("\uFFFD"), "no replacement chars at the split boundary");
	writeFileSync(bigPath, "🌍".repeat(100_000) + "END4");
	const utf8Tail4 = readBgLogTail(bigPath, 800);
	assert.ok(utf8Tail4.endsWith("END4"));
	assert.ok(!utf8Tail4.includes("\uFFFD"), "4-byte chars must not split into replacement chars");
	const truncated = truncateBgLog(bigPath, 64 * 1024);
	assert.ok(truncated !== null && truncated.endsWith("END4"));
	const after = readFileSync(bigPath, "utf8");
	assert.ok(Buffer.byteLength(after, "utf8") <= 64 * 1024, "completed logs must be truncated");
	assert.ok(after.endsWith("END4"), "truncation must preserve the tail");

	// Completion rewriting must not follow a pre-created predictable temp symlink.
	const victimPath = join(bigLog, "victim.txt");
	const attackPath = join(bigLog, "attack.log");
	writeFileSync(victimPath, "VICTIM-UNCHANGED");
	writeFileSync(attackPath, `${"z".repeat(10_000)}ATTACK-END`);
	symlinkSync(victimPath, `${attackPath}.trunc`);
	assert.ok(truncateBgLog(attackPath, 1_024)?.endsWith("ATTACK-END"));
	assert.equal(readFileSync(victimPath, "utf8"), "VICTIM-UNCHANGED", "temp rewrite must not follow symlinks");

	const sourceLink = join(bigLog, "source-link.log");
	symlinkSync(victimPath, sourceLink);
	assert.notEqual(truncateBgLog(sourceLink, 1_024), "VICTIM-UNCHANGED", "completion reads must not follow a replaced log-path symlink");
	assert.equal(readFileSync(victimPath, "utf8"), "VICTIM-UNCHANGED");
} finally {
	rmSync(bigLog, { recursive: true, force: true });
}

// --- pruneExitedJobs: history cap, running jobs untouched ---
const jobMap = new Map<string, BgJob>();
for (let i = 0; i < 30; i++) {
	jobMap.set(`j${i}`, { id: `j${i}`, command: "x", logPath: `/tmp/j${i}.log`, startedAt: i, state: "exited", exit: 0 });
}
jobMap.set("running-1", { id: "running-1", command: "x", logPath: "/tmp/r.log", startedAt: 0, state: "running", exit: null });
pruneExitedJobs(jobMap, 20);
assert.equal(jobMap.size, 21);
assert.ok(!jobMap.has("j0") && !jobMap.has("j9"), "oldest exited jobs must be pruned");
assert.ok(jobMap.has("j29"));
assert.ok(jobMap.has("running-1"), "running jobs are never pruned");

// Completion is the state transition where the retained-history cap applies.
const completing = new Map<string, BgJob>();
for (let i = 0; i < 20; i++) {
	completing.set(`old-${i}`, { id: `old-${i}`, command: "x", logPath: `/tmp/old-${i}.log`, startedAt: i, state: "exited", exit: 0 });
}
completing.set("running", { id: "running", command: "x", logPath: "/tmp/running.log", startedAt: 21, state: "running", exit: null });
finishBgJob(completing, "/tmp/running.log", 0);
assert.equal([...completing.values()].filter((entry) => entry.state === "exited").length, 20);
assert.deepEqual([...getRunningLogPaths(completing)], [], "only genuinely running logs may be rotation-exempt");

console.log("ALL BG-COMMAND TESTS PASSED");
