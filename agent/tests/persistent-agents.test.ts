/**
 * Roster durability: the persistent-agent store is globalThis-pinned (survives
 * /reload) AND written through to disk, so a full Pi RESTART can rehydrate the
 * standing agents and their resume spine. A "restart" is simulated here by
 * clear() (memory wiped, disk kept) followed by hydrate() (a fresh process reads
 * disk). The file holds session ids, so it must be private (0600, no group/other).
 *
 * getAgentDir() honours PI_CODING_AGENT_DIR, so we redirect all writes to a temp
 * dir — this test must never touch the real ~/.pi/agent/fleet/roster.json.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-roster-"));
process.env.PI_CODING_AGENT_DIR = dir;
// The roster filename is now scoped per project: `fleet/roster-<scope>.json`,
// where <scope> is a hash of PI_FLEET_ROSTER_KEY (else the process cwd). Pin the
// key so this test is hermetic (independent of the runner's cwd) and the single
// active roster file is deterministic; find it by glob rather than re-deriving
// the hash here.
process.env.PI_FLEET_ROSTER_KEY = "roster-test-project-A";
delete process.env.PI_FLEET_EPOCH_FILE;
const fleetDir = join(dir, "fleet");
const rosterFiles = (): string[] =>
	existsSync(fleetDir) ? readdirSync(fleetDir).filter((f) => /^roster-.*\.json$/.test(f)).sort() : [];
/** The single active roster file under the current scope (asserts exactly one). */
const rosterFile = (): string => {
	const files = rosterFiles();
	assert.equal(files.length, 1, `expected exactly one active roster file, saw: ${files.join(", ") || "none"}`);
	return join(fleetDir, files[0]);
};

const pa = await import("../extensions/shared/persistent-agents.ts");

try {
	// --- register writes the roster through to disk -------------------------
	pa.register({
		loomId: "loom-A",
		name: "Lark",
		harness: "claude",
		laneKey: "lane-A",
		sessionId: "sess-A-secret",
		parentSessionId: "parent-1",
		cwd: "/tmp/work-A",
		model: "claude-opus-4-8",
		lane: "solo-aaaa",
	});
	pa.recordExchange("loom-A", { from: "you", prompt: "hi", reply: "hello" });
	pa.register({
		loomId: "loom-B",
		name: "Forge",
		harness: "cursor",
		laneKey: "lane-B",
		parentSessionId: "parent-1",
		cwd: "/tmp/work-B",
		lane: "solo-bbbb",
	});

	assert.ok(existsSync(rosterFile()), "register must write the roster to disk");
	const ungatedRosterRaw = readFileSync(rosterFile(), "utf8");
	assert.ok(!ungatedRosterRaw.includes('"generation"'), "unset PI_FLEET_EPOCH_FILE must serialize no generation key");
	const ungatedRecords = JSON.parse(ungatedRosterRaw) as Array<Record<string, unknown>>;
	assert.deepEqual(
		Object.keys(ungatedRecords.find((record) => record.loomId === "loom-B")!).sort(),
		["createdAt", "cwd", "harness", "lane", "laneKey", "lastActiveAt", "loomId", "name", "parentSessionId"].sort(),
		"the ungated roster record shape must stay byte-schema-identical to the pre-Stage-2 shape",
	);

	// --- the file is private (holds session ids) ----------------------------
	const mode = statSync(rosterFile()).mode & 0o777;
	assert.equal(mode & 0o077, 0, `roster must deny group/other access (mode was 0${mode.toString(8)})`);

	// --- simulate a restart: clear() = process dies, disk survives ----------
	pa.clear();
	assert.equal(pa.all().length, 0, "clear() wipes the in-memory store");
	assert.ok(existsSync(rosterFile()), "clear() (shutdown) must NOT delete the durable roster on disk");

	// --- hydrate() = a fresh process reads disk -----------------------------
	const n = pa.hydrate("parent-2-NEW");
	assert.equal(n, 2, "hydrate must restore both agents from disk");

	const a = pa.byName("Lark");
	assert.ok(a, "Lark must be restored");
	// The full resume spine round-trips unchanged...
	assert.equal(a!.loomId, "loom-A");
	assert.equal(a!.harness, "claude");
	assert.equal(a!.laneKey, "lane-A");
	assert.equal(a!.sessionId, "sess-A-secret", "the session id (the resume pointer) must survive a restart");
	assert.equal(a!.cwd, "/tmp/work-A");
	assert.equal(a!.model, "claude-opus-4-8");
	assert.equal(a!.lane, "solo-aaaa");
	assert.equal(pa.history("loom-A").length, 1, "exchange history survives the restart too");
	assert.equal(pa.history("loom-A")[0].reply, "hello");
	// ...except parentSessionId, which is re-adopted by the active session so the
	// session_start clearExceptParent() keeps the agent instead of dropping it.
	assert.equal(a!.parentSessionId, "parent-2-NEW", "hydrated agents are re-adopted by the active parent session");

	// --- hydrate() is a no-op when the store is already populated -----------
	pa.register({ loomId: "loom-C", name: "Extra", harness: "codex", laneKey: "lane-C", parentSessionId: "parent-2-NEW", cwd: "/tmp/c", lane: "solo-cccc" });
	assert.equal(pa.hydrate("parent-3"), 0, "hydrate must not touch a non-empty store (memory is authoritative)");
	assert.equal(pa.byName("Lark")!.parentSessionId, "parent-2-NEW", "a no-op hydrate must not rebind existing agents");

	// --- /kill (removeByName) persists, and the removal survives a restart --
	pa.removeByName("Lark");
	pa.clear();
	pa.hydrate("parent-4");
	assert.equal(pa.byName("Lark"), undefined, "a killed agent must stay gone across a restart");
	assert.ok(pa.byName("Forge"), "un-killed agents remain after the restart");
	assert.ok(pa.byName("Extra"), "agents registered after hydrate are also persisted");

	// --- per-project ISOLATION: a different scope is a different roster file,
	// so two concurrent projects on one profile never collide, even when both
	// mint the same seed-deterministic codename ("Lark"). This is the fix for the
	// cross-process name/roster collision. ---
	// Project A currently holds Forge + Extra on disk under key "…project-A".
	const projectAFiles = rosterFiles();
	assert.equal(projectAFiles.length, 1, "project A has exactly one roster file");

	// Switch to project B (a second concurrent pi would have its own key/cwd).
	process.env.PI_FLEET_ROSTER_KEY = "roster-test-project-B";
	pa.clear(); // a brand-new process for project B
	assert.equal(pa.hydrate("parent-B"), 0, "project B must NOT inherit project A's agents (isolation)");
	assert.equal(pa.byName("Forge"), undefined, "project A's Forge is invisible to project B");

	// Project B mints its OWN agent that happens to share a codename with A's.
	pa.register({ loomId: "loomB-0", name: "Forge", harness: "cursor", laneKey: "lane-b0", parentSessionId: "parent-B", cwd: "/tmp/proj-b", lane: "solo-b0" });
	assert.equal(pa.byName("Forge")!.loomId, "loomB-0", "project B's Forge is its own, not A's");
	assert.equal(pa.byName("Forge")!.cwd, "/tmp/proj-b", "project B's Forge carries project B's cwd");
	assert.equal(rosterFiles().length, 2, "A and B now have two distinct roster files — no clobber");

	// Back to project A: its roster is intact and resumes its OWN agents.
	process.env.PI_FLEET_ROSTER_KEY = "roster-test-project-A";
	pa.clear();
	pa.hydrate("parent-A-again");
	assert.ok(pa.byName("Forge"), "project A's roster survived project B entirely");
	assert.equal(pa.byName("Forge")!.cwd, "/tmp/work-B", "project A's Forge is A's (unclobbered by B's same-named agent)");

	// The extension passes a generation only when its epoch runtime exists. The
	// optional field is additive and touch updates it without changing task text.
	process.env.PI_FLEET_EPOCH_FILE = "/tmp/fleet-epoch-enabled-for-test";
	pa.register(
		{ loomId: "loom-D", name: "Onyx", harness: "claude", laneKey: "lane-D", parentSessionId: "parent-A-again", cwd: "/tmp/d", lane: "solo-dddd", task: "original task" },
		7,
	);
	assert.equal(pa.byName("Onyx")!.generation, 7, "gated register records the L2-accepted generation");
	pa.touch("loom-D", { task: "original task" }, 8);
	assert.equal(pa.byName("Onyx")!.generation, 8, "gated touch advances the generation");
	assert.equal(pa.byName("Onyx")!.task, "original task", "roster task remains unstamped");
	const gatedRoster = rosterFiles().map((file) => join(fleetDir, file)).find((file) => readFileSync(file, "utf8").includes('"loomId": "loom-D"'));
	assert.ok(gatedRoster, "the active project roster must contain the gated worker");
	assert.match(readFileSync(gatedRoster!, "utf8"), /"generation": 8/, "gated roster serialization gains generation");

	console.log("ALL PERSISTENT-AGENTS TESTS PASSED");
} finally {
	delete process.env.PI_FLEET_EPOCH_FILE;
	rmSync(dir, { recursive: true, force: true });
}
