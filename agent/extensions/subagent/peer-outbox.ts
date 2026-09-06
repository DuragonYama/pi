import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PEER_OUTBOX_SCHEMA_VERSION = 1;
export const DEFAULT_PER_RECIPIENT_DEPTH = 32;
export const DEFAULT_GLOBAL_DEPTH = 256;
export const DEFAULT_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECEIPT_DEPTH = 256;
export const DEFAULT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PREVIEW_CHARS = 512;

export type PeerDeliveryState = "queued" | "delivering" | "delivered" | "dropped" | "failed";
export type PeerTerminalState = "delivered" | "dropped" | "failed";

export interface PeerDelivery {
	id: string;
	recipientLoomId: string;
	recipientName: string;
	senderLoomId: string;
	senderName: string;
	text: string;
	requestKey?: string;
	generation?: number;
	sequence: number;
	state: "queued" | "delivering";
	queuedAt: number;
	deliveryStartedAt?: number;
}

export interface PeerReceipt {
	id: string;
	recipientLoomId: string;
	recipientName: string;
	senderLoomId: string;
	senderName: string;
	requestKey?: string;
	generation?: number;
	sequence: number;
	state: PeerDeliveryState;
	queuedAt: number;
	deliveryStartedAt?: number;
	deliveredAt?: number;
	droppedAt?: number;
	failedAt?: number;
	reason?: string;
	preview?: string;
}

export interface PeerOutboxSnapshot {
	schemaVersion: typeof PEER_OUTBOX_SCHEMA_VERSION;
	nextSequence: number;
	deliveries: PeerDelivery[];
	receipts: PeerReceipt[];
}

export interface PeerOutboxPersistence {
	load(): string | undefined;
	save(serialized: string): void;
	quarantine?(reason: string): void;
}

export interface PeerOutboxOptions {
	now: () => number;
	id: () => string;
	persistence: PeerOutboxPersistence;
	perRecipientDepth?: number;
	globalDepth?: number;
	queueRetentionMs?: number;
	receiptDepth?: number;
	receiptRetentionMs?: number;
	previewChars?: number;
}

export class PeerOutboxPersistenceError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(`peer outbox persistence failed: ${message}`, options);
		this.name = "PeerOutboxPersistenceError";
	}
}

export interface PeerAdmission {
	recipientLoomId: string;
	recipientName: string;
	senderLoomId: string;
	senderName: string;
	text: string;
	requestKey?: string;
	generation?: number;
	busy: boolean;
}

export type PeerAdmissionResult =
	| { kind: "immediate"; receipt: PeerReceipt }
	| { kind: "queued"; receipt: PeerReceipt; position: number }
	| { kind: "duplicate"; receipt: PeerReceipt; position?: number }
	| { kind: "dropped"; receipt: PeerReceipt }
	| { kind: "persistence_failed"; error: string };

export interface PeerHydrationResult {
	loaded: number;
	dropped: number;
	failedUnknown: number;
	quarantined: boolean;
}

function positiveInt(value: number, fallback: number): number {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function finiteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function terminalAt(receipt: PeerReceipt): number | undefined {
	return receipt.deliveredAt ?? receipt.droppedAt ?? receipt.failedAt;
}

function cloneDelivery(delivery: PeerDelivery): PeerDelivery {
	return { ...delivery };
}

function cloneReceipt(receipt: PeerReceipt): PeerReceipt {
	return { ...receipt };
}

function isDelivery(value: unknown): value is PeerDelivery {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		nonEmpty(v.id) &&
		nonEmpty(v.recipientLoomId) &&
		nonEmpty(v.recipientName) &&
		nonEmpty(v.senderLoomId) &&
		nonEmpty(v.senderName) &&
		typeof v.text === "string" &&
		(v.requestKey === undefined || nonEmpty(v.requestKey)) &&
		(v.generation === undefined || (typeof v.generation === "number" && Number.isFinite(v.generation))) &&
		Number.isSafeInteger(v.sequence) &&
		(v.sequence as number) >= 0 &&
		(v.state === "queued" || v.state === "delivering") &&
		finiteTimestamp(v.queuedAt) &&
		(v.deliveryStartedAt === undefined || finiteTimestamp(v.deliveryStartedAt))
	);
}

function isReceipt(value: unknown): value is PeerReceipt {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		nonEmpty(v.id) &&
		nonEmpty(v.recipientLoomId) &&
		nonEmpty(v.recipientName) &&
		nonEmpty(v.senderLoomId) &&
		nonEmpty(v.senderName) &&
		(v.requestKey === undefined || nonEmpty(v.requestKey)) &&
		(v.generation === undefined || (typeof v.generation === "number" && Number.isFinite(v.generation))) &&
		Number.isSafeInteger(v.sequence) &&
		(v.sequence as number) >= 0 &&
		["queued", "delivering", "delivered", "dropped", "failed"].includes(String(v.state)) &&
		finiteTimestamp(v.queuedAt) &&
		(v.deliveryStartedAt === undefined || finiteTimestamp(v.deliveryStartedAt)) &&
		(v.deliveredAt === undefined || finiteTimestamp(v.deliveredAt)) &&
		(v.droppedAt === undefined || finiteTimestamp(v.droppedAt)) &&
		(v.failedAt === undefined || finiteTimestamp(v.failedAt)) &&
		(v.reason === undefined || typeof v.reason === "string") &&
		(v.preview === undefined || typeof v.preview === "string")
	);
}

export class PeerOutbox {
	private deliveries = new Map<string, PeerDelivery[]>();
	private receipts = new Map<string, PeerReceipt>();
	private receiptOrder: string[] = [];
	private dedupe = new Map<string, string>();
	private nextSequence = 0;
	private readonly now: () => number;
	private readonly id: () => string;
	private readonly persistence: PeerOutboxPersistence;
	private readonly perRecipientDepth: number;
	private readonly globalDepth: number;
	private readonly queueRetentionMs: number;
	private readonly receiptDepth: number;
	private readonly receiptRetentionMs: number;
	private readonly previewChars: number;

	constructor(options: PeerOutboxOptions) {
		this.now = options.now;
		this.id = options.id;
		this.persistence = options.persistence;
		this.perRecipientDepth = positiveInt(options.perRecipientDepth ?? DEFAULT_PER_RECIPIENT_DEPTH, DEFAULT_PER_RECIPIENT_DEPTH);
		this.globalDepth = positiveInt(options.globalDepth ?? DEFAULT_GLOBAL_DEPTH, DEFAULT_GLOBAL_DEPTH);
		this.queueRetentionMs = positiveInt(options.queueRetentionMs ?? DEFAULT_QUEUE_RETENTION_MS, DEFAULT_QUEUE_RETENTION_MS);
		this.receiptDepth = positiveInt(options.receiptDepth ?? DEFAULT_RECEIPT_DEPTH, DEFAULT_RECEIPT_DEPTH);
		this.receiptRetentionMs = positiveInt(options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS, DEFAULT_RECEIPT_RETENTION_MS);
		this.previewChars = positiveInt(options.previewChars ?? DEFAULT_PREVIEW_CHARS, DEFAULT_PREVIEW_CHARS);
	}

	hydrate(isRecipientLive: (loomId: string) => boolean = () => true): PeerHydrationResult {
		const raw = this.persistence.load();
		if (raw === undefined) return { loaded: 0, dropped: 0, failedUnknown: 0, quarantined: false };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.persistence.quarantine?.("invalid-json");
			return { loaded: 0, dropped: 0, failedUnknown: 0, quarantined: true };
		}
		if (!this.validSnapshot(parsed)) {
			this.persistence.quarantine?.("unsupported-or-invalid-schema");
			return { loaded: 0, dropped: 0, failedUnknown: 0, quarantined: true };
		}

		const snapshot = parsed as PeerOutboxSnapshot;
		this.deliveries.clear();
		this.receipts.clear();
		this.receiptOrder = [];
		this.dedupe.clear();
		this.nextSequence = snapshot.nextSequence;
		for (const receipt of snapshot.receipts.sort((a, b) => a.sequence - b.sequence)) this.putReceipt(cloneReceipt(receipt));

		let loaded = 0;
		let dropped = 0;
		let failedUnknown = 0;
		const now = this.now();
		for (const source of snapshot.deliveries.sort((a, b) => a.sequence - b.sequence)) {
			const delivery = cloneDelivery(source);
			this.ensureReceipt(delivery);
			if (!isRecipientLive(delivery.recipientLoomId)) {
				this.terminalizeLoaded(delivery, "dropped", "orphan_recipient", now);
				dropped++;
			} else if (now - delivery.queuedAt >= this.queueRetentionMs) {
				this.terminalizeLoaded(delivery, "dropped", "retention_expired", now);
				dropped++;
			} else if (delivery.state === "delivering") {
				this.terminalizeLoaded(delivery, "failed", "restart_during_delivery_outcome_unknown", now);
				failedUnknown++;
			} else {
				const queue = this.deliveries.get(delivery.recipientLoomId) ?? [];
				queue.push(delivery);
				this.deliveries.set(delivery.recipientLoomId, queue);
				loaded++;
			}
		}
		this.pruneReceipts(now);
		this.save();
		return { loaded, dropped, failedUnknown, quarantined: false };
	}

	admit(input: PeerAdmission): PeerAdmissionResult {
		const now = this.now();
		try {
			this.expire(now);
		} catch (error) {
			return { kind: "persistence_failed", error: this.errorText(error) };
		}
		if (input.requestKey) {
			const duplicateId = this.dedupe.get(input.requestKey);
			const duplicate = duplicateId ? this.receipts.get(duplicateId) : undefined;
			if (duplicate) {
				const position = duplicate.state === "queued" ? this.positionOf(duplicate.id, duplicate.recipientLoomId) : undefined;
				return { kind: "duplicate", receipt: cloneReceipt(duplicate), ...(position ? { position } : {}) };
			}
		}

		const delivery = this.newDelivery(input, now);
		const queue = this.deliveries.get(input.recipientLoomId) ?? [];
		const shouldQueue = input.busy || queue.length > 0;
		if (!shouldQueue) {
			delivery.state = "delivering";
			delivery.deliveryStartedAt = now;
			const receipt = this.receiptFrom(delivery);
			this.transaction(() => this.putReceipt(receipt));
			return { kind: "immediate", receipt: cloneReceipt(receipt) };
		}

		if (queue.length >= this.perRecipientDepth || this.totalDepth() >= this.globalDepth) {
			const reason = queue.length >= this.perRecipientDepth ? "recipient_queue_full" : "global_queue_full";
			const receipt = this.receiptFrom(delivery);
			receipt.state = "dropped";
			receipt.droppedAt = now;
			receipt.reason = reason;
			try {
				this.transaction(() => this.putReceipt(receipt));
				return { kind: "dropped", receipt: cloneReceipt(receipt) };
			} catch (error) {
				return { kind: "persistence_failed", error: this.errorText(error) };
			}
		}

		const receipt = this.receiptFrom(delivery);
		const position = queue.length + 1;
		try {
			this.transaction(() => {
				const next = this.deliveries.get(input.recipientLoomId) ?? [];
				next.push(delivery);
				this.deliveries.set(input.recipientLoomId, next);
				this.putReceipt(receipt);
			});
			return { kind: "queued", receipt: cloneReceipt(receipt), position };
		} catch (error) {
			return { kind: "persistence_failed", error: this.errorText(error) };
		}
	}

	claimNext(recipientLoomId: string): PeerDelivery | undefined {
		this.expire(this.now(), recipientLoomId);
		const queue = this.deliveries.get(recipientLoomId);
		const head = queue?.[0];
		if (!head || head.state !== "queued") return undefined;
		const now = Math.max(this.now(), head.queuedAt);
		this.transaction(() => {
			head.state = "delivering";
			head.deliveryStartedAt = now;
			const receipt = this.receipts.get(head.id)!;
			receipt.state = "delivering";
			receipt.deliveryStartedAt = now;
		});
		return cloneDelivery(head);
	}

	markDelivered(id: string, replyPreview = ""): PeerReceipt {
		return this.finish(id, "delivered", undefined, replyPreview);
	}

	markFailed(id: string, reason: string, preview = ""): PeerReceipt {
		return this.finish(id, "failed", reason, preview);
	}

	drop(id: string, reason: string): PeerReceipt {
		return this.finish(id, "dropped", reason, "");
	}

	dropRecipient(recipientLoomId: string, reason: string): PeerReceipt[] {
		const queue = [...(this.deliveries.get(recipientLoomId) ?? [])];
		const out: PeerReceipt[] = [];
		for (const delivery of queue) out.push(this.drop(delivery.id, reason));
		return out;
	}

	expire(now = this.now(), recipientLoomId?: string): PeerReceipt[] {
		const recipients = recipientLoomId ? [recipientLoomId] : [...this.deliveries.keys()];
		const expired: PeerReceipt[] = [];
		for (const key of recipients) {
			for (;;) {
				const head = this.deliveries.get(key)?.[0];
				if (!head || head.state !== "queued" || now - head.queuedAt < this.queueRetentionMs) break;
				expired.push(this.finish(head.id, "dropped", "retention_expired", "", now));
			}
		}
		this.pruneReceipts(now);
		return expired;
	}

	receipt(id: string): PeerReceipt | undefined {
		const receipt = this.receipts.get(id);
		return receipt ? cloneReceipt(receipt) : undefined;
	}

	receiptsForRecipient(recipientLoomId: string): PeerReceipt[] {
		return this.receiptOrder
			.map((id) => this.receipts.get(id))
			.filter((receipt): receipt is PeerReceipt => receipt?.recipientLoomId === recipientLoomId)
			.map(cloneReceipt);
	}

	queueDepth(recipientLoomId?: string): number {
		return recipientLoomId === undefined ? this.totalDepth() : (this.deliveries.get(recipientLoomId)?.length ?? 0);
	}

	peek(recipientLoomId: string): PeerDelivery | undefined {
		const head = this.deliveries.get(recipientLoomId)?.[0];
		return head ? cloneDelivery(head) : undefined;
	}

	snapshot(): PeerOutboxSnapshot {
		return {
			schemaVersion: PEER_OUTBOX_SCHEMA_VERSION,
			nextSequence: this.nextSequence,
			deliveries: [...this.deliveries.values()].flat().sort((a, b) => a.sequence - b.sequence).map(cloneDelivery),
			receipts: this.receiptOrder.map((id) => this.receipts.get(id)).filter((r): r is PeerReceipt => Boolean(r)).map(cloneReceipt),
		};
	}

	/** Force the current in-memory state through the synchronous persistence adapter. */
	flush(): void {
		this.save();
	}

	/**
	 * Last-resort in-memory terminalization after a terminal receipt write failed.
	 * Disk deliberately remains `delivering`, so restart recovery reports the
	 * honest outcome-unknown state; memory advances so one bad write cannot strand
	 * the recipient drain for the rest of this process.
	 */
	recoverTerminalInMemory(id: string, reason: string): PeerReceipt | undefined {
		const receipt = this.receipts.get(id);
		if (!receipt) return undefined;
		const at = Math.max(this.now(), receipt.deliveryStartedAt ?? receipt.queuedAt);
		receipt.state = "failed";
		receipt.reason = this.preview(reason);
		receipt.failedAt = at;
		this.removeDelivery(id, receipt.recipientLoomId);
		return cloneReceipt(receipt);
	}

	private newDelivery(input: PeerAdmission, now: number): PeerDelivery {
		const id = this.id();
		if (!nonEmpty(id) || this.receipts.has(id)) throw new Error("peer outbox id generator returned an empty or duplicate id");
		return {
			id,
			recipientLoomId: input.recipientLoomId,
			recipientName: input.recipientName,
			senderLoomId: input.senderLoomId,
			senderName: input.senderName,
			text: input.text,
			...(input.requestKey ? { requestKey: input.requestKey } : {}),
			...(input.generation !== undefined ? { generation: input.generation } : {}),
			sequence: this.nextSequence++,
			state: "queued",
			queuedAt: now,
		};
	}

	private receiptFrom(delivery: PeerDelivery): PeerReceipt {
		return {
			id: delivery.id,
			recipientLoomId: delivery.recipientLoomId,
			recipientName: delivery.recipientName,
			senderLoomId: delivery.senderLoomId,
			senderName: delivery.senderName,
			...(delivery.requestKey ? { requestKey: delivery.requestKey } : {}),
			...(delivery.generation !== undefined ? { generation: delivery.generation } : {}),
			sequence: delivery.sequence,
			state: delivery.state,
			queuedAt: delivery.queuedAt,
			...(delivery.deliveryStartedAt !== undefined ? { deliveryStartedAt: delivery.deliveryStartedAt } : {}),
		};
	}

	private ensureReceipt(delivery: PeerDelivery): void {
		const existing = this.receipts.get(delivery.id);
		if (existing) return;
		this.putReceipt(this.receiptFrom(delivery));
	}

	private putReceipt(receipt: PeerReceipt): void {
		if (!this.receipts.has(receipt.id)) this.receiptOrder.push(receipt.id);
		this.receipts.set(receipt.id, receipt);
		if (receipt.requestKey) this.dedupe.set(receipt.requestKey, receipt.id);
	}

	private finish(id: string, state: PeerTerminalState, reason?: string, preview = "", at = this.now()): PeerReceipt {
		const receipt = this.receipts.get(id);
		if (!receipt) throw new Error(`unknown peer delivery receipt: ${id}`);
		if (receipt.state === "delivered" || receipt.state === "dropped" || receipt.state === "failed") {
			throw new Error(`peer delivery ${id} is already terminal (${receipt.state})`);
		}
		if (state === "delivered" && receipt.state !== "delivering") {
			throw new Error(`peer delivery ${id} must be delivering before it can be delivered`);
		}
		at = Math.max(at, receipt.deliveryStartedAt ?? receipt.queuedAt);
		this.transaction(() => {
			receipt.state = state;
			receipt.preview = this.preview(preview);
			if (reason) receipt.reason = this.preview(reason);
			if (state === "delivered") receipt.deliveredAt = at;
			if (state === "dropped") receipt.droppedAt = at;
			if (state === "failed") receipt.failedAt = at;
			this.removeDelivery(id, receipt.recipientLoomId);
			this.pruneReceipts(at);
		});
		return cloneReceipt(receipt);
	}

	private terminalizeLoaded(delivery: PeerDelivery, state: "dropped" | "failed", reason: string, at: number): void {
		const receipt = this.receipts.get(delivery.id)!;
		receipt.state = state;
		receipt.reason = reason;
		if (state === "dropped") receipt.droppedAt = at;
		else receipt.failedAt = at;
	}

	private removeDelivery(id: string, recipientLoomId: string): void {
		const queue = this.deliveries.get(recipientLoomId);
		if (!queue) return;
		const index = queue.findIndex((delivery) => delivery.id === id);
		if (index >= 0) queue.splice(index, 1);
		if (queue.length === 0) this.deliveries.delete(recipientLoomId);
	}

	private positionOf(id: string, recipientLoomId: string): number | undefined {
		const index = this.deliveries.get(recipientLoomId)?.findIndex((delivery) => delivery.id === id) ?? -1;
		return index >= 0 ? index + 1 : undefined;
	}

	private totalDepth(): number {
		let count = 0;
		for (const queue of this.deliveries.values()) count += queue.length;
		return count;
	}

	private preview(value: string): string {
		return value.length > this.previewChars ? `${value.slice(0, this.previewChars)}…` : value;
	}

	private pruneReceipts(now: number): void {
		for (const id of [...this.receiptOrder]) {
			const receipt = this.receipts.get(id);
			const at = receipt ? terminalAt(receipt) : undefined;
			if (at !== undefined && now - at >= this.receiptRetentionMs) this.removeReceipt(id);
		}
		while (this.receiptOrder.length > this.receiptDepth) {
			const terminalId = this.receiptOrder.find((id) => {
				const state = this.receipts.get(id)?.state;
				return state === "delivered" || state === "dropped" || state === "failed";
			});
			if (!terminalId) break;
			this.removeReceipt(terminalId);
		}
	}

	private removeReceipt(id: string): void {
		const receipt = this.receipts.get(id);
		this.receipts.delete(id);
		this.receiptOrder = this.receiptOrder.filter((candidate) => candidate !== id);
		if (receipt?.requestKey && this.dedupe.get(receipt.requestKey) === id) this.dedupe.delete(receipt.requestKey);
	}

	private transaction(mutator: () => void): void {
		const before = this.snapshot();
		try {
			mutator();
			this.save();
		} catch (error) {
			this.restore(before);
			throw error;
		}
	}

	private restore(snapshot: PeerOutboxSnapshot): void {
		this.deliveries.clear();
		this.receipts.clear();
		this.receiptOrder = [];
		this.dedupe.clear();
		this.nextSequence = snapshot.nextSequence;
		for (const delivery of snapshot.deliveries) {
			const queue = this.deliveries.get(delivery.recipientLoomId) ?? [];
			queue.push(cloneDelivery(delivery));
			this.deliveries.set(delivery.recipientLoomId, queue);
		}
		for (const receipt of snapshot.receipts) this.putReceipt(cloneReceipt(receipt));
	}

	private save(): void {
		try {
			this.persistence.save(JSON.stringify(this.snapshot(), null, 2) + "\n");
		} catch (error) {
			if (error instanceof PeerOutboxPersistenceError) throw error;
			throw new PeerOutboxPersistenceError(this.errorText(error), { cause: error });
		}
	}

	private validSnapshot(value: unknown): boolean {
		if (!value || typeof value !== "object") return false;
		const v = value as Record<string, unknown>;
		if (v.schemaVersion !== PEER_OUTBOX_SCHEMA_VERSION || !Number.isSafeInteger(v.nextSequence) || (v.nextSequence as number) < 0) return false;
		if (!Array.isArray(v.deliveries) || !Array.isArray(v.receipts)) return false;
		if (!v.deliveries.every(isDelivery) || !v.receipts.every(isReceipt)) return false;
		if (v.deliveries.length > this.globalDepth) return false;
		const deliveryIds = new Set<string>();
		const perRecipient = new Map<string, number>();
		for (const delivery of v.deliveries as PeerDelivery[]) {
			if (deliveryIds.has(delivery.id)) return false;
			if (delivery.sequence >= (v.nextSequence as number)) return false;
			if (delivery.deliveryStartedAt !== undefined && delivery.deliveryStartedAt < delivery.queuedAt) return false;
			deliveryIds.add(delivery.id);
			const depth = (perRecipient.get(delivery.recipientLoomId) ?? 0) + 1;
			if (depth > this.perRecipientDepth) return false;
			perRecipient.set(delivery.recipientLoomId, depth);
		}
		const receiptIds = new Set<string>();
		for (const receipt of v.receipts as PeerReceipt[]) {
			if (receiptIds.has(receipt.id)) return false;
			if (receipt.sequence >= (v.nextSequence as number)) return false;
			if (receipt.deliveryStartedAt !== undefined && receipt.deliveryStartedAt < receipt.queuedAt) return false;
			const terminal = terminalAt(receipt);
			if (terminal !== undefined && terminal < (receipt.deliveryStartedAt ?? receipt.queuedAt)) return false;
			receiptIds.add(receipt.id);
		}
		for (const delivery of v.deliveries as PeerDelivery[]) {
			const receipt = (v.receipts as PeerReceipt[]).find((candidate) => candidate.id === delivery.id);
			if (!receipt || receipt.recipientLoomId !== delivery.recipientLoomId || receipt.senderLoomId !== delivery.senderLoomId) return false;
			if (receipt.state !== delivery.state) return false;
		}
		return true;
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export function peerOutboxProjectScope(explicitKey: string | undefined, cwd: string): string {
	let key = explicitKey?.trim() ?? "";
	if (!key) {
		try {
			key = fs.realpathSync(cwd);
		} catch {
			key = cwd;
		}
	}
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function peerOutboxPath(agentDir: string, scope: string): string {
	return path.join(agentDir, "fleet", `peer-outbox-${scope}.json`);
}

export function createFilePeerOutboxPersistence(file: string): PeerOutboxPersistence {
	return {
		load(): string | undefined {
			try {
				return fs.readFileSync(file, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		save(serialized: string): void {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, serialized, { mode: 0o600 });
			fs.renameSync(tmp, file);
		},
		quarantine(reason: string): void {
			try {
				const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "invalid";
				fs.renameSync(file, `${file}.quarantine-${Date.now()}-${safeReason}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}
