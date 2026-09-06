import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFilePeerOutboxPersistence,
	PeerOutbox,
	peerOutboxPath,
	peerOutboxProjectScope,
	type PeerAdmission,
	type PeerAdmissionResult,
	type PeerOutboxPersistence,
} from "../extensions/subagent/peer-outbox.ts";

let now = 1_000;
let idSeq = 0;
const memory = (initial?: string): PeerOutboxPersistence & { value?: string; saves: number; quarantines: string[] } => ({
	value: initial,
	saves: 0,
	quarantines: [],
	load() { return this.value; },
	save(serialized) { this.saves++; this.value = serialized; },
	quarantine(reason) { this.quarantines.push(reason); this.value = undefined; },
});
const make = (persistence: PeerOutboxPersistence = memory(), overrides: Record<string, unknown> = {}) =>
	new PeerOutbox({ now: () => now, id: () => `q_${++idSeq}`, persistence, ...overrides });
const receiptOf = (result: PeerAdmissionResult) => {
	if (result.kind === "persistence_failed") throw new Error(result.error);
	return result.receipt;
};
const input = (recipientLoomId: string, text: string, busy: boolean, requestKey?: string): PeerAdmission => ({
	recipientLoomId,
	recipientName: recipientLoomId === "A" ? "Alpha" : "Beta",
	senderLoomId: "sender",
	senderName: "Sender",
	text,
	busy,
	...(requestKey ? { requestKey } : {}),
});

// Idle is immediate; busy is queued; an existing FIFO prevents idle bypass.
{
	const outbox = make();
	const immediate = outbox.admit(input("A", "now", false, "immediate"));
	assert.equal(immediate.kind, "immediate");
	assert.equal(immediate.receipt.state, "delivering");
	outbox.markDelivered(immediate.receipt.id, "done");

	const first = outbox.admit(input("A", "one", true, "one"));
	const second = outbox.admit(input("A", "two", false, "two"));
	assert.equal(first.kind, "queued");
	assert.equal(second.kind, "queued", "an idle observation must not bypass an existing FIFO");
	assert.equal(second.position, 2);
	assert.equal(outbox.claimNext("A")!.text, "one");
	outbox.markDelivered(first.receipt.id, "reply one");
	assert.equal(outbox.claimNext("A")!.text, "two");
	outbox.markFailed(second.receipt.id, "adapter_failed");
	assert.equal(outbox.queueDepth("A"), 0);
	assert.equal(outbox.receipt(first.receipt.id)!.state, "delivered");
	assert.equal(outbox.receipt(second.receipt.id)!.state, "failed");
}

// FIFO is per recipient, while recipients remain independent.
{
	const outbox = make();
	const a1 = outbox.admit(input("A", "a1", true));
	const b1 = outbox.admit(input("B", "b1", true));
	const a2 = outbox.admit(input("A", "a2", true));
	assert.equal(a1.kind, "queued");
	assert.equal(b1.kind, "queued");
	assert.equal(a2.kind, "queued");
	assert.equal(outbox.claimNext("B")!.text, "b1");
	assert.equal(outbox.claimNext("A")!.text, "a1");
	outbox.markDelivered(a1.receipt.id);
	assert.equal(outbox.claimNext("A")!.text, "a2");
}

// Duplicate request keys return the original receipt and never append twice.
{
	const outbox = make();
	const first = outbox.admit(input("A", "same", true, "rpc:7"));
	const duplicate = outbox.admit(input("A", "same", true, "rpc:7"));
	assert.equal(first.kind, "queued");
	assert.equal(duplicate.kind, "duplicate");
	assert.equal(duplicate.receipt.id, first.receipt.id);
	assert.equal(outbox.queueDepth("A"), 1);
}

// Reject newest at per-recipient and global caps; never evict accepted work.
{
	const outbox = make(memory(), { perRecipientDepth: 1, globalDepth: 2 });
	const accepted = outbox.admit(input("A", "keep", true));
	const recipientFull = outbox.admit(input("A", "reject", true));
	const other = outbox.admit(input("B", "keep-b", true));
	const globalFull = outbox.admit({ ...input("C", "reject-global", true), recipientName: "Gamma" });
	assert.equal(recipientFull.kind, "dropped");
	assert.equal(recipientFull.receipt.reason, "recipient_queue_full");
	assert.equal(globalFull.kind, "dropped");
	assert.equal(globalFull.receipt.reason, "global_queue_full");
	assert.equal(outbox.peek("A")!.id, receiptOf(accepted).id);
	assert.equal(outbox.queueDepth(), 2);
	assert.equal(other.kind, "queued");
}

// Expiry drops only expired queued heads, then exposes the next FIFO item.
{
	const outbox = make(memory(), { queueRetentionMs: 100 });
	const old = outbox.admit(input("A", "old", true));
	now += 60;
	const fresh = outbox.admit(input("A", "fresh", true));
	now += 41;
	const expired = outbox.expire();
	assert.deepEqual(expired.map((r) => r.id), [receiptOf(old).id]);
	assert.equal(expired[0].state, "dropped");
	assert.equal(expired[0].reason, "retention_expired");
	assert.equal(outbox.peek("A")!.id, receiptOf(fresh).id);
}

// Illegal terminal transitions are rejected.
{
	const outbox = make();
	const queued = outbox.admit(input("A", "queued", true));
	assert.throws(() => outbox.markDelivered(receiptOf(queued).id), /must be delivering/);
	outbox.drop(receiptOf(queued).id, "cancelled");
	assert.throws(() => outbox.markFailed(receiptOf(queued).id, "late"), /already terminal/);
}

// Save failures roll admission back and fail closed.
{
	const persistence: PeerOutboxPersistence = {
		load: () => undefined,
		save: () => { throw new Error("disk full"); },
	};
	const outbox = make(persistence);
	const result = outbox.admit(input("A", "must not vanish", true));
	assert.deepEqual(result, { kind: "persistence_failed", error: "peer outbox persistence failed: disk full" });
	assert.equal(outbox.queueDepth(), 0);
}

// Hydration restores queued work, drops orphans, and never replays delivering.
{
	const persistence = memory();
	const source = make(persistence);
	const queued = source.admit(input("A", "queued", true, "queued-key"));
	const unknown = source.admit(input("B", "in progress", true, "unknown-key"));
	assert.equal(unknown.kind, "queued");
	source.claimNext("B");
	const orphan = source.admit({ ...input("C", "orphan", true), recipientName: "Gamma" });
	assert.equal(orphan.kind, "queued");

	const restored = make(persistence);
	const result = restored.hydrate((loomId) => loomId === "A" || loomId === "B");
	assert.deepEqual(result, { loaded: 1, dropped: 1, failedUnknown: 1, quarantined: false });
	assert.equal(restored.peek("A")!.id, receiptOf(queued).id);
	assert.equal(restored.receipt(receiptOf(unknown).id)!.reason, "restart_during_delivery_outcome_unknown");
	assert.equal(restored.receipt(receiptOf(orphan).id)!.reason, "orphan_recipient");
	const dedupe = restored.admit(input("A", "queued", true, "queued-key"));
	assert.equal(dedupe.kind, "duplicate", "dedupe index must survive hydration");
}

// Invalid JSON and newer schemas are quarantined, never partially loaded.
{
	const invalid = memory("not json");
	assert.equal(make(invalid).hydrate().quarantined, true);
	assert.deepEqual(invalid.quarantines, ["invalid-json"]);
	const newer = memory(JSON.stringify({ schemaVersion: 999, nextSequence: 0, deliveries: [], receipts: [] }));
	assert.equal(make(newer).hydrate().quarantined, true);
	assert.deepEqual(newer.quarantines, ["unsupported-or-invalid-schema"]);
	const overCap = memory(JSON.stringify({
		schemaVersion: 1,
		nextSequence: 2,
		deliveries: [
			{ id: "q1", recipientLoomId: "A", recipientName: "A", senderLoomId: "S", senderName: "S", text: "1", sequence: 0, state: "queued", queuedAt: 1 },
			{ id: "q2", recipientLoomId: "A", recipientName: "A", senderLoomId: "S", senderName: "S", text: "2", sequence: 1, state: "queued", queuedAt: 1 },
		],
		receipts: [
			{ id: "q1", recipientLoomId: "A", recipientName: "A", senderLoomId: "S", senderName: "S", sequence: 0, state: "queued", queuedAt: 1 },
			{ id: "q2", recipientLoomId: "A", recipientName: "A", senderLoomId: "S", senderName: "S", sequence: 1, state: "queued", queuedAt: 1 },
		],
	}));
	assert.equal(make(overCap, { perRecipientDepth: 1 }).hydrate().quarantined, true, "over-cap snapshots are never partially adopted");
}

// Injected clocks cannot make receipt timestamps move backwards.
{
	const outbox = make();
	now = 10_000;
	const admitted = outbox.admit(input("A", "clock", true));
	now = 9_000;
	outbox.claimNext("A");
	now = 8_000;
	const done = outbox.markDelivered(receiptOf(admitted).id);
	assert.equal(done.deliveryStartedAt, 10_000);
	assert.equal(done.deliveredAt, 10_000);
}

// Receipt bounds and preview bounds do not prune active receipts.
{
	const outbox = make(memory(), { receiptDepth: 2, receiptRetentionMs: 100, previewChars: 4 });
	for (let i = 0; i < 3; i++) {
		const admitted = outbox.admit(input("A", `m${i}`, false, `r${i}`));
		assert.equal(admitted.kind, "immediate");
		outbox.markDelivered(admitted.receipt.id, "abcdefgh");
	}
	assert.equal(outbox.snapshot().receipts.length, 2);
	assert.equal(outbox.snapshot().receipts[1].preview, "abcd…");
	now += 101;
	outbox.expire();
	assert.equal(outbox.snapshot().receipts.length, 0);
}

// Drop all queued work for a dismissed recipient.
{
	const outbox = make();
	outbox.admit(input("A", "one", true));
	outbox.admit(input("A", "two", true));
	const dropped = outbox.dropRecipient("A", "target_dismissed");
	assert.equal(dropped.length, 2);
	assert.ok(dropped.every((receipt) => receipt.state === "dropped" && receipt.reason === "target_dismissed"));
	assert.equal(outbox.queueDepth("A"), 0);
}

// Real file persistence: exact scoped filename, 0600, atomic result, quarantine rename.
{
	const dir = mkdtempSync(join(tmpdir(), "pi-peer-outbox-"));
	try {
		const scope = peerOutboxProjectScope("project-A", "/ignored");
		assert.equal(scope, peerOutboxProjectScope(" project-A ", "/other"));
		assert.notEqual(scope, peerOutboxProjectScope("project-B", "/ignored"));
		const file = peerOutboxPath(dir, scope);
		assert.equal(file, join(dir, "fleet", `peer-outbox-${scope}.json`));
		const persistence = createFilePeerOutboxPersistence(file);
		const outbox = make(persistence);
		outbox.admit(input("A", "durable", true));
		assert.ok(existsSync(file));
		assert.equal(statSync(file).mode & 0o077, 0, "spool must deny group/other access");
		assert.equal(readdirSync(join(dir, "fleet")).filter((name) => name.includes(".tmp")).length, 0, "atomic tmp is renamed away");
		assert.match(readFileSync(file, "utf8"), /"schemaVersion": 1/);

		writeFileSync(file, JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
		assert.equal(make(persistence).hydrate().quarantined, true);
		assert.equal(existsSync(file), false);
		assert.equal(readdirSync(join(dir, "fleet")).filter((name) => name.startsWith(`peer-outbox-${scope}.json.quarantine-`)).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("ALL PEER-OUTBOX TESTS PASSED");
