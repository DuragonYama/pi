/**
 * ACP Subagents — delegate work to external coding harnesses.
 *
 * Shared ACP runner used by the unified `subagent` tool. Pi acts as an ACP
 * *client* (orchestrator) and spawns external agents (Claude Code, Codex,
 * Cursor, Hermes, pi, …) over stdio, collecting their streamed output.
 *
 * Safety model: every permission request is routed through PolicyClient.
 * Non-dangerous write/edit/execute auto-allow (grant 2026-08-13). Danger-
 * scanned ops prompt when a UI is present and fail closed with no UI.
 * trust:"full" (claude, cursor) bypasses the danger floor. Allow-always is
 * never selected; session-scoped approvals last one delegation.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { types as utilTypes } from "node:util";
// Type-only: erased at runtime, so the SDK still loads lazily in runDelegation.
import type { ActiveSessionMessage } from "@agentclientprotocol/sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findDangerous, findSsrf, type Pattern } from "../shared/danger.ts";
import { agentDir } from "../shared/env-config.ts";
import {
	AcpModelOverrideError,
	AcpResumeUnsupportedError,
	AcpSessionUnusableError,
	AcpStaleGenerationError,
	AcpTurnUncertainError,
	appendBoundedUtf8,
	createBoundedLineTransform,
	parseAgentConfig,
	planRunnerContinuity,
	redactSecrets,
	advertisedSessionConfigValues,
	resolveExactSessionConfigValue,
	type AgentConfig,
	type AgentDef,
	type AgentTrust,
	type ContinuityMode,
	type RunnerContinuity,
} from "./core.ts";
import { utf8HeadWithin, utf8TailWithin } from "../shared/utf8.ts";
import {
	formatAdapterLabel,
	getLanePeekStore,
	type AdapterPackageInfo,
	type PeekUsage,
} from "./lane-peek.ts";

export type { AgentConfig, AgentDef, AgentTrust } from "./core.ts";
export { AcpStaleGenerationError } from "./core.ts";

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

// Resolved from the ACTIVE profile dir (PI_CODING_AGENT_DIR-aware), not a
// hardcoded ~/.pi/agent — a copied/shipped profile has no ~/.pi/agent, and
// would otherwise silently read the source machine's config (or nothing).
const CONFIG_PATH = join(agentDir(), "acp-subagents.json");

// There is deliberately no built-in default config: a missing file must never
// activate stale or PATH-dependent adapter commands.
function warnModelOverrideShape(message: string): void {
	process.stderr.write(`[acp-subagents] ${message}\n`);
	logPolicy(`model-override-unavailable ${message}`);
}

export function loadConfigFromPath(configPath: string): AgentConfig {
	if (!existsSync(configPath)) {
		throw new Error(
			`ACP configuration not found at ${configPath}. ` +
				"Native subagents remain available; configure ACP agents in that file before requesting one.",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new Error(
			`Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		// modelOverride shape problems warn and drop that adapter's override; they
		// must not reject the file (an older in-memory runner + a newer pi
		// sessionConfig field previously killed every ACP spawn).
		return parseAgentConfig(parsed, warnModelOverrideShape);
	} catch (error) {
		throw new Error(
			`Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function loadConfig(): AgentConfig {
	return loadConfigFromPath(CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Permission policy
// ---------------------------------------------------------------------------

const SAFE_KINDS = new Set(["read", "search", "think", "fetch"]);
// Safe to auto-allow even when the adapter OMITS the payload: their effect does
// not hinge on an un-inspectable argument. `fetch` is excluded — its target URL
// is the security-relevant payload and would be invisible when absent.
const ABSENT_SAFE_KINDS = new Set(["read", "search", "think"]);

const POLICY_LOG = join(agentDir(), "acp-policy.log");
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_ENTRY_BYTES = 4 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const ACP_TEXT_TAIL_BYTES = 256 * 1024;
const MAX_TOOL_CALL_SUMMARIES = 500;
const MAX_PERMISSION_RAW_BYTES = 64 * 1024;
const MAX_PERMISSION_RAW_NODES = 4096;
const MAX_PERMISSION_RAW_DEPTH = 32;
const MAX_ACP_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_FAILURE_MESSAGE_BYTES = 4096;
const FULL_TRUST_NOTICE_MAX = 256;
const fullTrustNoticed = new Set<string>();
let fullTrustNoticeSeq = 0;

/** True on the first notice for `key`; bounds the set so it cannot grow without limit. */
function firstFullTrustNotice(key: string): boolean {
	if (fullTrustNoticed.has(key)) return false;
	if (fullTrustNoticed.size >= FULL_TRUST_NOTICE_MAX) {
		const oldest = fullTrustNoticed.values().next().value;
		if (oldest !== undefined) fullTrustNoticed.delete(oldest);
	}
	fullTrustNoticed.add(key);
	return true;
}

const DEFAULT_INHERITED_ENV = [
	"HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
	"SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
];
const TRUSTED_COMMAND_PATHS = [
	join(homedir(), ".local", "bin"),
	join(homedir(), ".bun", "bin"),
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

export function buildChildEnv(def: AgentDef): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of new Set([...DEFAULT_INHERITED_ENV, ...(def.inheritEnv ?? [])])) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	// Absolute adapter paths are not sufficient when their shebang uses
	// `/usr/bin/env` (pi-acp uses `env bun`). Keep interpreter discovery
	// deterministic in GUI/non-login launches as well.
	const commandDir = isAbsolute(def.command) ? dirname(def.command) : undefined;
	const pathEntries = [commandDir, ...TRUSTED_COMMAND_PATHS];
	env.PATH = [...new Set(pathEntries.filter(Boolean))].join(":");
	return { ...env, ...(def.env ?? {}) };
}

/**
 * Replace exact sensitive strings (session IDs) everywhere they may surface:
 * stderr, generic errors, adapter text, policy-log lines, final output. Exact
 * match only — a session ID is an opaque token, never a pattern.
 */
const SDK_DEP_KEYS = ["claude-agent-sdk", "@anthropic-ai/claude-agent-sdk", "@agentclientprotocol/sdk"];

/**
 * Best-effort adapter identity: walk from `command` (after realpath) to the
 * nearest package.json and read name/version plus a pinned SDK dep.
 * No network, no CLI comparison — just what the binary actually ships.
 */
export function resolveAdapterPackageInfo(command: string): AdapterPackageInfo {
	let dir: string;
	try {
		dir = dirname(realpathSync(command));
	} catch {
		dir = dirname(command);
	}
	for (let i = 0; i < 8; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
					name?: unknown;
					version?: unknown;
					dependencies?: Record<string, string>;
					optionalDependencies?: Record<string, string>;
				};
				const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
				let sdk: string | undefined;
				for (const key of SDK_DEP_KEYS) {
					if (typeof deps[key] === "string") {
						sdk = `${key}@${deps[key]}`;
						break;
					}
				}
				return {
					name: typeof pkg.name === "string" ? pkg.name : undefined,
					version: typeof pkg.version === "string" ? pkg.version : undefined,
					sdk,
				};
			} catch {
				/* unreadable package.json — keep walking */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

function caughtErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Compose the model-visible ACP failure line. Adapter error + stderr tail
 * attach on both pre- and post-establish paths, always through `safeText`
 * (session-id scrubber). Versions always attach when known.
 */
export function formatAcpFailure(args: {
	established: boolean;
	error?: unknown;
	stderr?: string;
	adapter?: AdapterPackageInfo;
	safeText: (text: string) => string;
}): string {
	const header = args.established
		? "ACP turn failed after session establishment"
		: "ACP delegation failed before a session was established";
	const errorText = args.error !== undefined ? caughtErrorText(args.error) : "";
	const stderrText = args.stderr ? utf8TailWithin(args.stderr, 2000) : "";
	const harvested = harvestOpaqueIds(errorText, stderrText);
	const parts = [header];
	if (args.error !== undefined) {
		const detail = args.safeText(applyOpaqueScrub(errorText, harvested)).replace(/\s+/g, " ").trim();
		if (detail) parts.push(detail);
	}
	const versions = formatAdapterLabel(args.adapter);
	if (versions) parts.push(versions);
	if (args.stderr) {
		const tail = args.safeText(applyOpaqueScrub(stderrText, harvested)).replace(/\s+/g, " ").trim();
		if (tail) parts.push(`stderr: ${tail}`);
	}
	return utf8HeadWithin(parts.join(" — "), MAX_FAILURE_MESSAGE_BYTES);
}

export function redactExact(text: string, secrets: ReadonlySet<string>): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join("REDACTED");
	}
	return out;
}

/**
 * Conservative opaque-id scrub. Keyword (session / sessionId / id) may be
 * separated from the token by JSON/config punctuation. A keyword-adjacent
 * token is opaque iff it contains a digit, an uppercase letter, or a hyphen;
 * pure lowercase snake_case (`resource_exhausted`) survives by shape.
 * UUID / long-hex shapes are also scrubbed standalone.
 */
const OPAQUE_ID_KEYWORD =
	/(?:session[_-]?id|sessionId|\bsession|\bid)[:"'\[\]\s=]*([A-Za-z0-9._+/-]+)/gi;

function isOpaqueToken(token: string): boolean {
	if (/^[a-z_]+$/.test(token)) return false;
	return /[0-9A-Z-]/.test(token);
}

const BARE_ID_KEYWORD = /^(?:session(?:[_-]?id)?|id)$/i;

export function harvestOpaqueIds(...texts: string[]): Set<string> {
	const harvested = new Set<string>();
	for (const text of texts) {
		let pos = 0;
		while (pos < text.length) {
			OPAQUE_ID_KEYWORD.lastIndex = pos;
			const match = OPAQUE_ID_KEYWORD.exec(text);
			if (!match) break;
			const token = match[1];
			const start = match.index ?? 0;
			if (token && BARE_ID_KEYWORD.test(token)) {
				// `session id=secret`: first pass captures `id` as the token.
				// Resume at that keyword so `id=secret` can harvest the real id.
				pos = start + match[0].length - token.length;
				if (pos <= start) pos = start + 1;
				continue;
			}
			if (token && isOpaqueToken(token)) harvested.add(token);
			pos = start + match[0].length;
		}
	}
	return harvested;
}

export function applyOpaqueScrub(text: string, harvested: ReadonlySet<string>): string {
	let out = text;
	for (const token of harvested) {
		if (token.length > 0) out = out.split(token).join("REDACTED");
	}
	out = out.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "REDACTED");
	out = out.replace(/\b[0-9a-fA-F]{20,}\b/g, "REDACTED");
	return out;
}

export function scrubOpaqueIds(text: string): string {
	return applyOpaqueScrub(text, harvestOpaqueIds(text));
}

function logPolicy(line: string): void {
	// One line per record, secrets redacted, 0600, bounded rotation.
	const oneLine = appendBoundedUtf8("", redactSecrets(line).replace(/[\r\n]+/g, "\\n"), MAX_LOG_ENTRY_BYTES);
	const entry = `${new Date().toISOString()} ${oneLine}\n`;
	try {
		appendFileSync(POLICY_LOG, entry, { mode: 0o600 });
		chmodSync(POLICY_LOG, 0o600);
		const size = statSync(POLICY_LOG).size;
		if (size > MAX_LOG_BYTES) {
			const content = readFileSync(POLICY_LOG, "utf-8");
			writeFileSync(POLICY_LOG, content.slice(-Math.floor(MAX_LOG_BYTES / 2)), { mode: 0o600 });
		}
	} catch {
		/* logging is best-effort */
	}
}

interface PermissionRequestParams {
	sessionId?: string;
	toolCall?: { toolCallId?: string; kind?: string; title?: string; rawInput?: unknown };
	options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

interface RawInputInspection {
	valid: boolean;
	danger?: Pattern;
	fingerprint?: string;
	/** Bounded, redacted string preview of the raw input for the approval UI. */
	preview?: string;
	/** Head-truncated copy of the actual payload that triggered the danger. */
	dangerPreview?: string;
}

function inspectRawInput(root: unknown): RawInputInspection {
	// Absent payload: nothing structured to inspect. This stays `invalid` here so
	// present-but-malformed payloads share the path; requestPermission() decides
	// what an ABSENT payload means per-kind (safe kinds fall open, others closed).
	if (root === undefined) return { valid: false };
	const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	const seen = new Set<object>();
	const hash = createHash("sha256");
	let nodes = 0;
	let sourceBytes = 0;
	let danger: Pattern | undefined;
	// Bounded, redacted preview of the actual input for the approval dialog.
	const MAX_RAW_PREVIEW_BYTES = 600;
	let preview = "";
	let dangerPreview: string | undefined;
	const captureDanger = (value: string) => {
		if (dangerPreview === undefined) {
			dangerPreview = appendBoundedUtf8("", redactSecrets(value), MAX_RAW_PREVIEW_BYTES);
		}
	};
	const hashPart = (tag: string, text = "") => {
		const bytes = Buffer.from(text, "utf8");
		hash.update(`${tag}:${bytes.length}:`);
		hash.update(bytes);
	};

	try {
		while (stack.length) {
			const { value, depth } = stack.pop()!;
			if (++nodes > MAX_PERMISSION_RAW_NODES || depth > MAX_PERMISSION_RAW_DEPTH) return { valid: false };
			if (value === null) {
				hashPart("null");
				continue;
			}
			if (typeof value === "boolean") {
				hashPart("boolean", value ? "1" : "0");
				continue;
			}
			if (typeof value === "number") {
				if (!Number.isFinite(value)) return { valid: false };
				hashPart("number", Object.is(value, -0) ? "-0" : String(value));
				continue;
			}
			if (typeof value === "string") {
				sourceBytes += Buffer.byteLength(value, "utf8");
				if (sourceBytes > MAX_PERMISSION_RAW_BYTES) return { valid: false };
				const hit = findDangerous(value) ?? findSsrf(value);
				if (hit) {
					danger ??= hit;
					captureDanger(value);
				}
				preview = appendBoundedUtf8(
					preview + (preview === "" ? "" : " | "),
					redactSecrets(value),
					MAX_RAW_PREVIEW_BYTES,
				);
				hashPart("string", value);
				continue;
			}
			if (typeof value !== "object") return { valid: false };
			if (utilTypes.isProxy(value)) return { valid: false };
			if (seen.has(value)) return { valid: false };
			seen.add(value);

			if (Array.isArray(value)) {
				if (Object.getPrototypeOf(value) !== Array.prototype) return { valid: false };
				const keys = Reflect.ownKeys(value);
				if (keys.length !== value.length + 1 || value.length + nodes > MAX_PERMISSION_RAW_NODES) return { valid: false };
				const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
				if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== value.length) return { valid: false };
				for (const key of keys) {
					if (typeof key !== "string") return { valid: false };
					if (key === "length") continue;
					if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return { valid: false };
					const descriptor = Object.getOwnPropertyDescriptor(value, key);
					if (!descriptor?.enumerable || !("value" in descriptor)) return { valid: false };
				}
				hashPart("array", String(value.length));
				if (value.length + nodes > MAX_PERMISSION_RAW_NODES) return { valid: false };
				for (let i = value.length - 1; i >= 0; i--) {
					if (!Object.prototype.hasOwnProperty.call(value, i)) return { valid: false };
					const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
					if (!descriptor?.enumerable || !("value" in descriptor)) return { valid: false };
					stack.push({ value: descriptor.value, depth: depth + 1 });
				}
				continue;
			}

			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return { valid: false };
			const keys = Reflect.ownKeys(value);
			if (keys.length + nodes > MAX_PERMISSION_RAW_NODES) return { valid: false };
			hashPart("object", String(keys.length));
			const values: unknown[] = [];
			for (const key of keys) {
				if (typeof key !== "string") return { valid: false };
				sourceBytes += Buffer.byteLength(key, "utf8");
				if (sourceBytes > MAX_PERMISSION_RAW_BYTES) return { valid: false };
				const keyHit = findDangerous(key);
				if (keyHit) {
					danger ??= keyHit;
					captureDanger(key);
				}
				preview = appendBoundedUtf8(preview + (preview === "" ? "" : " | "), redactSecrets(key), MAX_RAW_PREVIEW_BYTES);
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) return { valid: false };
				hashPart("key", key);
				values.push(descriptor.value);
			}
			for (let i = values.length - 1; i >= 0; i--) stack.push({ value: values[i], depth: depth + 1 });
		}

		return {
			valid: true,
			danger,
			fingerprint: hash.digest("hex"),
			preview: preview === "" ? undefined : preview,
			dangerPreview,
		};
	} catch {
		return { valid: false };
	}
}

export class PolicyClient {
	private ctx: ExtensionContext;
	private sessionAllowed: Set<string>;
	/**
	 * Force non-interactive permission handling: never raise a modal even when the
	 * ctx has UI. Non-dangerous ops still auto-allow (the grant below); a
	 * danger-scanned op auto-DENIES instead of prompting. Set for autonomous
	 * agent→agent comms so a target can't stall behind the orchestrator's own modal.
	 */
	private forceNonInteractive: boolean;
	/**
	 * Adapter trust level. "full" auto-allows EVERY operation (see AgentTrust) —
	 * the owner has explicitly opted this adapter into acting autonomously, the
	 * equivalent of that harness's own `--yolo`/`bypassPermissions`. "default"
	 * runs the safe policy below.
	 */
	private trust: AgentTrust;
	/** Adapter name, prefixed to policy-log lines so denials are attributable. */
	private agentLabel: string;
	/** Present only for the gated fleet runtime. */
	declare private isStale: (() => boolean) | undefined;
	/**
	 * Stable identity for the first-notice toast: ACP lane key (preferred) or
	 * a per-instance fallback. Session id from the request wins when present
	 * so two PolicyClients on the same resumed conversation share one toast.
	 */
	private noticeKey: string;
	/** Full-trust auto-allows this PolicyClient (log counter only). */
	private fullTrustAllows = 0;

	constructor(
		ctx: ExtensionContext,
		sessionAllowed: Set<string>,
		forceNonInteractive = false,
		trust: AgentTrust = "default",
		agentLabel = "",
		isStale?: () => boolean,
		noticeKey?: string,
	) {
		this.ctx = ctx;
		this.sessionAllowed = sessionAllowed;
		this.forceNonInteractive = forceNonInteractive;
		this.trust = trust;
		this.agentLabel = agentLabel;
		if (isStale) this.isStale = isStale;
		this.noticeKey = noticeKey && noticeKey.length > 0 ? `lane:${noticeKey}` : `instance:${++fullTrustNoticeSeq}`;
	}

	/** Exact enum-kind matching only: never trust optionId/name substrings. */
	private findOption(options: PermissionRequestParams["options"], kind: string) {
		if (!options?.length) return undefined;
		return options.find((o) => o.kind === kind);
	}

	async requestPermission(params: PermissionRequestParams) {
		const tool = params.toolCall ?? {};
		// The request's own session ID is sensitive: scrub it from titles,
		// previews, and every log line before anything is shown or stored.
		const requestSecrets = new Set<string>();
		if (params.sessionId && params.sessionId.length > 0) requestSecrets.add(params.sessionId);
		const title = redactExact(tool.title ?? "(unknown tool call)", requestSecrets);
		const kind = tool.kind ?? "other";
		const options = params.options ?? [];

		const allowOnce = this.findOption(options, "allow_once");
		const rejectOnce = this.findOption(options, "reject_once");

		const select = (option?: { optionId: string }) =>
			option
				? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
				: { outcome: { outcome: "cancelled" as const } };

		// Attribute every policy-log line to its adapter, so a denial/allow can be
		// traced to cursor vs claude vs codex without guessing.
		const tag = this.agentLabel ? `[${this.agentLabel}] ` : "";
		const log = (line: string) => logPolicy(tag + line);

		// Fleet backstop: once this delegation's snapshot is stale, it may keep
		// reading while it winds down but may not gain a new side-effecting grant
		// (including fetch / outbound network). This precedes full-trust, whose
		// normal short-circuit allows everything.
		if (this.isStale?.() && !ABSENT_SAFE_KINDS.has(kind)) {
			log(`DENY (stale generation): kind=${kind} :: ${title}`);
			return select(rejectOnce);
		}

		// FULL-TRUST short-circuit (opt-in per adapter): this adapter is trusted to
		// act autonomously, so every operation is auto-allowed — the danger scan,
		// the absent-payload deny, and the forced-non-interactive deny below are all
		// bypassed. This is the owner-selected equivalent of that harness's own
		// `--yolo`/`bypassPermissions`, and it is the ONLY path that skips the danger
		// floor. Reached only by adapters explicitly marked trust:"full" in the ACP
		// config; the default fleet still runs the full policy below.
		if (this.trust === "full") {
			this.fullTrustAllows++;
			log(`AUTO-ALLOW (full-trust #${this.fullTrustAllows}): ${title}`);
			const key =
				params.sessionId && params.sessionId.length > 0 ? `session:${params.sessionId}` : this.noticeKey;
			if (firstFullTrustNotice(key) && this.ctx.hasUI && typeof this.ctx.ui?.notify === "function") {
				this.ctx.ui.notify(
					`${this.agentLabel || "adapter"}: full-trust auto-allow (danger floor bypassed for this lane)`,
					"warning",
				);
			}
			return select(allowOnce);
		}

		// Validate, bound, scan and fingerprint adapter-controlled input before
		// any auto-approval or prompt. Invalid input fails closed.
		// An adapter may legitimately OMIT the optional ACP `rawInput` field —
		// cursor does exactly this for its web-search tool (kind "search"). That is
		// "nothing structured to inspect", not "malformed": there is no payload to
		// fingerprint, danger-scan, or preview. We resolve it per-kind below — safe
		// read-only kinds fall open (title still danger-scanned), everything else
		// still fails closed. A payload that is PRESENT but malformed fails closed
		// here regardless of kind.
		const rawAbsent = tool.rawInput === undefined;
		const rawInspection = inspectRawInput(tool.rawInput);
		if (!rawInspection.valid && !rawAbsent) {
			// Log a COARSE shape (type/proto, never the payload) to aid diagnosis.
			let shape = "?";
			try {
				const ri = tool.rawInput;
				const proto = Object.getPrototypeOf(ri as object);
				shape = `${typeof ri}/${proto === Object.prototype ? "Object" : proto === null ? "null-proto" : (ri as { constructor?: { name?: string } })?.constructor?.name ?? "exotic"}`;
			} catch {
				shape = "unreadable";
			}
			log(`DENY (invalid raw input): kind=${kind} shape=${shape} :: ${title}`);
			return select(rejectOnce);
		}
		const rawDanger = rawInspection.danger;
		const titleDanger = findDangerous(title) ?? findSsrf(title);

		// Read-only work is safe by default — unless title or raw input is dangerous.
		// When the payload is ABSENT we auto-allow only the kinds that stay low-risk
		// with NO inspectable payload: read/search/think. `fetch` is deliberately
		// excluded here — its security-relevant payload IS the target URL, so an
		// absent-URL fetch could reach a loopback/metadata/exfil endpoint we can
		// never see (`findDangerous` has no URL/SSRF patterns). A fetch WITH a
		// present, inspected payload still auto-allows via the full SAFE_KINDS set.
		// This still auto-allows cursor's web search, which arrives as kind "search".
		const allowKinds = rawAbsent ? ABSENT_SAFE_KINDS : SAFE_KINDS;
		if (allowKinds.has(kind) && !titleDanger && !rawDanger) {
			log(`AUTO-ALLOW read${rawAbsent ? " (no raw input)" : ""}: ${title}`);
			// Never turn a safe-read fast path into adapter-persistent approval.
			return select(allowOnce);
		}

		// A non-safe op (or an absent-payload fetch) whose payload the adapter
		// omitted cannot be fingerprinted, previewed, or shown for informed
		// consent — fail closed without prompting.
		if (rawAbsent) {
			log(`DENY (no raw input, kind=${kind}): ${title}`);
			return select(rejectOnce);
		}

		// GRANT (all subagents): a non-safe op (write/edit/execute/…) with a PRESENT,
		// inspected, NON-dangerous payload is auto-allowed — agents do ordinary coding
		// work (writes, edits, running commands) without a modal, so no permission
		// prompt is ever raised for it and a target can't stall waiting on one. The
		// danger-scan above is the FLOOR: anything findDangerous/findSsrf flagged
		// (rm -rf, curl|bash, dd/mkfs to /dev, fork-bombs, SSRF) skips this and falls
		// through to the danger handling below (auto-deny when non-interactive, else
		// prompt the present human).
		if (!titleDanger && !rawDanger) {
			log(`AUTO-ALLOW (non-dangerous ${kind}): ${title}`);
			return select(allowOnce);
		}

		// Forced non-interactive (autonomous comms): the only ops reaching here are
		// danger-scanned, and a non-interactive delegation auto-DENIES them rather
		// than raising a modal that would stall behind the orchestrator's own. This
		// sits BEFORE the session cache on purpose — a "for this delegation" approval
		// must never rescue a danger op on the non-interactive side (today the comms
		// path always passes a fresh empty set, so this is defense-in-depth).
		if (this.forceNonInteractive) {
			log(`DENY (non-interactive): ${title}`);
			return select(rejectOnce);
		}

		// Previously approved for this delegation only when presentation fields
		// and the bounded raw-input fingerprint are identical.
		const rawFingerprint = rawInspection.fingerprint;
		const sessionKey = `${kind}|${title}|${rawFingerprint}`;
		if (rawFingerprint !== undefined && this.sessionAllowed.has(sessionKey)) {
			log(`SESSION-ALLOWED: ${title}`);
			return select(allowOnce);
		}

		// No UI: default-deny anything that still needs permission here.
		if (!this.ctx.hasUI) {
			log(`DENY (no UI): ${title}`);
			return select(rejectOnce);
		}

		const danger = titleDanger ?? rawDanger;
		const prefix = danger ? `⚠️  Subagent permission (${danger.label}):` : "⚠️  Subagent permission:";
		// Show the actual (redacted, bounded, session-ID-scrubbed) input being
		// approved — the adapter title alone is not sufficient informed consent.
		// When a specific payload triggered the danger, that payload is shown
		// (head-truncated), never just an unrelated tail window.
		const previewSource = rawInspection.dangerPreview ?? rawInspection.preview;
		const rawPreview = previewSource ? redactExact(previewSource, requestSecrets) : undefined;
		const inputBlock = rawPreview ? `\n  input: ${rawPreview}\n` : "\n";

		try {
			const choice = await this.ctx.ui.select(`${prefix}\n\n  ${title}\n${inputBlock}`, [
				"Allow once",
				"Allow for this delegation",
				"Reject",
			]);

			if (choice === "Allow for this delegation") {
				if (rawFingerprint !== undefined) this.sessionAllowed.add(sessionKey);
				log(`USER ALLOWED (session): ${title}`);
				// Keep delegation scope local. ACP allow_always can outlive this
				// runner, which would contradict the user's selected scope.
				return select(allowOnce);
			}
			if (choice !== "Allow once") {
				log(`USER REJECTED: ${title}`);
				return select(rejectOnce);
			}
			// "Allow once" must never upgrade to allow_always.
			log(`USER ALLOWED (once): ${title}`);
			return select(allowOnce);
		} catch (error) {
			// Never let a policy bug surface to the subagent as a protocol error.
			log(`POLICY ERROR (denying): ${title} — ${error instanceof Error ? error.message : String(error)}`);
			return select(rejectOnce);
		}
	}
}

// ---------------------------------------------------------------------------
// Delegation runner
// ---------------------------------------------------------------------------

export interface AcpSessionEstablished {
	sessionId: string;
	continuity: RunnerContinuity;
}

/**
 * Session-CUMULATIVE usage captured from ACP `PromptResponse.usage` (SDK:
 * "across session" / "across all turns"). Always numeric (never NaN/undefined)
 * so callers can subtract without guarding. `cost` is set only when the adapter
 * actually sent a finite number — never fabricated from tokens.
 * `usage_update` notifications are ignored: PromptResponse.usage is the single
 * source; per-turn increments are derived by `deltaAcpUsage`.
 */
export interface AcpTurnUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	thoughtTokens: number;
	cost?: number;
}

function nonNegFinite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Zeroed usage for adapters that omit PromptResponse.usage (e.g. cursor). */
export function normalizeAcpUsage(raw: unknown): AcpTurnUsage {
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const usage: AcpTurnUsage = {
		inputTokens: nonNegFinite(src?.inputTokens),
		outputTokens: nonNegFinite(src?.outputTokens),
		totalTokens: nonNegFinite(src?.totalTokens),
		cachedReadTokens: nonNegFinite(src?.cachedReadTokens),
		cachedWriteTokens: nonNegFinite(src?.cachedWriteTokens),
		thoughtTokens: nonNegFinite(src?.thoughtTokens),
	};
	// Spec Usage has no cost; a plain numeric `cost` is accepted if present.
	if (src && "cost" in src) {
		const cost = src.cost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.cost = cost;
	}
	return usage;
}

function fieldDelta(current: number, previous: number): number {
	return Math.max(0, current - previous);
}

/**
 * Per-turn increment: `cumulative` (this PromptResponse.usage) minus `prev`
 * (last-seen cumulative for the same session). Missing/malformed inputs are
 * zeroed via `normalizeAcpUsage`. A cumulative RESET (adapter restart → smaller
 * number) clamps to 0, never negative. Cost is delta'd only when the current
 * snapshot provided one.
 */
export function deltaAcpUsage(cumulative: unknown, prev: unknown): AcpTurnUsage {
	const cur = normalizeAcpUsage(cumulative);
	const last = normalizeAcpUsage(prev);
	const delta: AcpTurnUsage = {
		inputTokens: fieldDelta(cur.inputTokens, last.inputTokens),
		outputTokens: fieldDelta(cur.outputTokens, last.outputTokens),
		totalTokens: fieldDelta(cur.totalTokens, last.totalTokens),
		cachedReadTokens: fieldDelta(cur.cachedReadTokens, last.cachedReadTokens),
		cachedWriteTokens: fieldDelta(cur.cachedWriteTokens, last.cachedWriteTokens),
		thoughtTokens: fieldDelta(cur.thoughtTokens, last.thoughtTokens),
	};
	if (cur.cost !== undefined) delta.cost = fieldDelta(cur.cost, last.cost ?? 0);
	return delta;
}

export interface RunOptions {
	def: AgentDef;
	cwd: string;
	task: string;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	onText: (text: string) => void;
	policy: PolicyClient;
	/** Fleet-only generation fence; omitted entirely outside the gated runtime. */
	isStale?: () => boolean;
	/**
	 * Fleet-only. Called once the adapter child process exists; invoke the
	 * returned function when that process actually exits. Omitted entirely
	 * outside the gated runtime.
	 */
	trackWorkerExit?: () => () => void;
	/** Lane-resolved ACP session ID to resume via capability-gated session/load. */
	resumeSessionId?: string;
	continuityMode?: ContinuityMode;
	/**
	 * Fires as soon as a usable session exists — after `session/new` or
	 * `session/load` succeeds, before the prompt turn — so lane registration
	 * stays transactional even when the prompt later fails.
	 */
	onSessionEstablished?: (info: AcpSessionEstablished) => void;
	/** Fires immediately before the ACP session/prompt request is submitted. */
	onPromptSubmitted?: () => void;
	/** Fires on each child tool-call update (drives the Loom's per-agent beads). */
	onToolCall?: (info: { toolCallId?: string; title?: string; kind?: string; status?: string }) => void;
	/** Fires on each child reasoning (thought) chunk (drives the Loom's ∴ beads). */
	onThought?: () => void;
	/**
	 * Lane identity for the peek ring buffer. When set, session/update
	 * activity (tools, assistant tail, usage, last error) is retained
	 * until the lane is evicted or the agent is killed.
	 */
	peekKey?: string;
	/**
	 * MCP servers to attach to the delegated session (passed on BOTH session/new
	 * and session/load). Defaults to none. Transports: in-process HTTP, a stdio
	 * shim, or (experimental, adapter-dependent) ACP. Threaded verbatim into the
	 * ACP request — the caller owns transport choice and lifetime.
	 */
	mcpServers?: McpServerConfig[];
	/**
	 * Fires once, right after `initialize` succeeds, with the raw
	 * agent-capabilities object. Lets a probe inspect advertised
	 * `mcpCapabilities` without a second connection. Never carries a session ID.
	 */
	onInitialized?: (agentCapabilities: unknown) => void | Promise<void>;
}

/**
 * MCP server config threaded to the ACP adapter, matching the INSTALLED SDK
 * (v1) wire schema — every field the adapter requires is required here too. This
 * matters: a conformant adapter deserializes the list with `vecSkipError` and
 * SILENTLY DROPS any entry that doesn't validate, so a config missing (say)
 * `headers` yields a session with no tools and NO error anywhere. In v1 the
 * `http`/`sse` variants are `type`-tagged; `stdio` is the UNTAGGED union
 * fallback (no `type` field) — do not add one, a strict adapter could reject it.
 * The `as never` at the two wire sites bridges only the v1↔v2-draft nesting
 * disagreement in the vendored declarations, not a shape difference.
 */
export type McpServerConfig =
	| { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
	| { type: "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> }
	| { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

/**
 * Minimal async queue mirroring the SDK ActiveSession update stream. The SDK's
 * `attachSession` is private in the installed declarations, so loaded sessions
 * route `session/update` notifications through this queue via the public
 * `onNotification` API instead.
 */
class AcpUpdateQueue {
	private values: ActiveSessionMessage[] = [];
	private waiters: Array<{ resolve: (message: ActiveSessionMessage) => void; reject: (error: unknown) => void }> = [];
	private failure: unknown;
	private failed = false;

	push(message: ActiveSessionMessage): void {
		if (this.failed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(message);
		else this.values.push(message);
	}

	fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	next(): Promise<ActiveSessionMessage> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve(value);
		if (this.failed) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}
}

interface PromptTurnSession {
	prompt(promptText: string): unknown;
	nextUpdate(): Promise<ActiveSessionMessage>;
}

interface AcpSessionConfigClient {
	request(method: string, params: { sessionId: string; configId: string; value: string }): Promise<unknown>;
}

/**
 * Apply a declared `modelOverride.sessionConfig` via ACP
 * `session/set_config_option` after the session exists and before the prompt.
 * Spawn-time env/args cannot reach in-process adapters such as pi-acp (shared
 * daemon; `createAgentSession` ignores argv). Combined env+sessionConfig is
 * intentional: env (`PI_ACP_MODEL_OVERRIDE`) is a no-op compat key so older
 * in-memory runners accept the file; this path still applies sessionConfig
 * exactly once. Pi overrides only take effect in sessions started after this
 * runner change — a live session must restart to pick up the new code.
 */
async function applySessionConfigOverride(
	cx: AcpSessionConfigClient,
	sessionId: string,
	def: AgentDef,
	setConfigOptionMethod: string,
	advertisedValues?: readonly string[],
): Promise<void> {
	const sessionConfig = def.modelOverride?.sessionConfig;
	if (!sessionConfig) return;
	let value = sessionConfig.value;
	if (advertisedValues && advertisedValues.length > 0) {
		const resolved = resolveExactSessionConfigValue(value, advertisedValues);
		if (!resolved) {
			const lower = value.trim().toLowerCase();
			const idHits = !value.includes("/")
				? advertisedValues.filter((entry) => {
						const slash = entry.lastIndexOf("/");
						const id = slash === -1 ? entry : entry.slice(slash + 1);
						return id.toLowerCase() === lower;
					})
				: [];
			throw new AcpModelOverrideError(
				idHits.length > 1
					? `ACP adapter advertises ${idHits.length} models named "${value}"; pass a provider/id (${idHits.join(", ")})`
					: `ACP adapter does not advertise model "${value}" for session/set_config_option (${sessionConfig.configId})`,
			);
		}
		value = resolved;
	}
	try {
		const response = (await cx.request(setConfigOptionMethod, {
			sessionId,
			configId: sessionConfig.configId,
			value,
		})) as { configOptions?: Array<{ id?: string; currentValue?: unknown }> };
		const current = response.configOptions?.find((option) => option.id === sessionConfig.configId)?.currentValue;
		if (typeof current === "string" && !resolveExactSessionConfigValue(sessionConfig.value, [current])) {
			throw new AcpModelOverrideError(
				`ACP adapter applied "${current}" instead of requested model "${sessionConfig.value}"`,
			);
		}
	} catch (error) {
		if (error instanceof AcpModelOverrideError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new AcpModelOverrideError(
			`ACP adapter failed to apply model override via ${setConfigOptionMethod} (${sessionConfig.configId}=${value}): ${detail}`,
		);
	}
}

/**
 * The bounded prompt/update loop shared by fresh (`session/new`) and loaded
 * (`session/load`) sessions: identical text/tool-call caps either way.
 */
async function collectPromptTurn(
	session: PromptTurnSession,
	task: string,
	onText: (text: string) => void,
	onPromptSubmitted?: () => void,
	onToolCall?: (info: { toolCallId?: string; title?: string; kind?: string; status?: string }) => void,
	onThought?: () => void,
	isStale?: () => boolean,
	kill?: () => void,
	peekKey?: string,
) {
	let text = "";
	const toolCalls: string[] = [];
	const throwIfStale = () => {
		if (!isStale?.()) return;
		kill?.();
		throw new AcpStaleGenerationError("ACP delegation was superseded by a newer fleet generation");
	};

	throwIfStale();
	session.prompt(task);
	if (peekKey) getLanePeekStore().beginTurn(peekKey);
	onPromptSubmitted?.();

	for (;;) {
		const msg = await session.nextUpdate();
		throwIfStale();
		if (msg.kind === "stop") {
			const usage = normalizeAcpUsage(msg.response.usage);
			if (peekKey) {
				const peekUsage: PeekUsage = {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cachedReadTokens: usage.cachedReadTokens,
					cachedWriteTokens: usage.cachedWriteTokens,
					thoughtTokens: usage.thoughtTokens,
				};
				if (usage.cost !== undefined) peekUsage.cost = usage.cost;
				getLanePeekStore().noteUsage(peekKey, peekUsage);
			}
			return {
				text,
				toolCalls,
				stopReason: msg.response.stopReason,
				usage,
			};
		}
		const update = msg.update;
		if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
			text = appendBoundedUtf8(text, update.content.text, ACP_TEXT_TAIL_BYTES);
			onText(text);
			if (peekKey) getLanePeekStore().noteAssistant(peekKey, text);
		} else if (update?.sessionUpdate === "agent_thought_chunk") {
			// The child is reasoning — signal it so the Loom shows ∴ beads. We don't
			// retain the thought text (it's the model's private chain-of-thought).
			onThought?.();
		} else if (update?.sessionUpdate === "tool_call") {
			onToolCall?.({
				toolCallId: update.toolCallId,
				title: update.title,
				kind: update.kind,
				status: update.status,
			});
			if (peekKey) {
				getLanePeekStore().noteTool(
					peekKey,
					typeof update.kind === "string" && update.kind ? update.kind : "tool",
					typeof update.title === "string" ? update.title : String(update.toolCallId ?? ""),
				);
			}
			const entry = appendBoundedUtf8(
				"",
				`${update.status ?? "?"}: ${update.title ?? update.toolCallId ?? "tool call"}`,
				2048,
			);
			if (toolCalls.length < MAX_TOOL_CALL_SUMMARIES && !toolCalls.includes(entry)) toolCalls.push(entry);
		}
		throwIfStale();
	}
}

export async function runDelegation({
	def,
	cwd,
	task,
	timeoutMs,
	signal,
	onText,
	policy,
	isStale,
	trackWorkerExit,
	resumeSessionId,
	continuityMode = "auto",
	onSessionEstablished,
	onPromptSubmitted,
	onToolCall,
	onThought,
	mcpServers = [],
	onInitialized,
	peekKey,
}: RunOptions) {
	// The SDK is only needed when an ACP delegation actually runs. Keeping it
	// out of the extension startup path saves module parse/load work in sessions
	// that only use native agents.
	if (isStale?.()) throw new AcpStaleGenerationError("ACP delegation was superseded before startup");
	if (signal?.aborted) throw new Error("Delegation was aborted before startup");
	const acp = await import("@agentclientprotocol/sdk");
	if (isStale?.()) throw new AcpStaleGenerationError("ACP delegation was superseded before startup");
	if (signal?.aborted) throw new Error("Delegation was aborted before startup");
	const proc = spawn(def.command, def.args ?? [], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: buildChildEnv(def),
		detached: true, // own process group, so kill(-pid) reaches descendants
	});

	await new Promise<void>((resolve, reject) => {
		proc.once("spawn", () => resolve());
		proc.once("error", reject);
	});

	let stderr = "";
	// Session IDs for this delegation: scrubbed from every boundary they could
	// reach — stderr, adapter text, final output, generic errors.
	const sensitiveIds = new Set<string>();
	if (resumeSessionId) sensitiveIds.add(resumeSessionId);
	const establish = (info: AcpSessionEstablished) => {
		sensitiveIds.add(info.sessionId);
		onSessionEstablished?.(info);
	};
	const safeText = (text: string) => redactExact(text, sensitiveIds);
	const adapterInfo = resolveAdapterPackageInfo(def.command);
	logPolicy(
		`spawn ${basename(def.command)} ${formatAdapterLabel(adapterInfo) || "adapter=unknown"}`,
	);
	if (peekKey) getLanePeekStore().noteAdapter(peekKey, adapterInfo);

	// Stderr is accumulated raw (byte-bounded) and scrubbed in one final pass
	// at the return boundary: per-chunk scrubbing cannot catch a session ID
	// split across two pipe chunks, and a fresh ID echoed during session/new
	// predates `establish()`.
	proc.stderr?.on("data", (d) => {
		stderr = appendBoundedUtf8(stderr, String(d), STDERR_TAIL_BYTES);
	});

	let timedOut = false;
	let killed = false;
	let exited = proc.exitCode !== null || proc.signalCode !== null;
	let escalationTimer: NodeJS.Timeout | undefined;
	let workerExitSignaled = false;
	const reportWorkerExit = trackWorkerExit?.();
	const onProcExit = () => {
		if (workerExitSignaled) return;
		workerExitSignaled = true;
		exited = true;
		if (escalationTimer) clearTimeout(escalationTimer);
		reportWorkerExit?.();
	};
	if (exited) onProcExit();
	else proc.once("exit", onProcExit);
	const kill = () => {
		if (killed || exited) return;
		killed = true;
		try {
			process.kill(-proc.pid!, "SIGTERM");
		} catch {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		escalationTimer = setTimeout(() => {
			if (exited) return;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}, 3000);
		escalationTimer.unref();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeoutMs);
	timer.unref();

	const onAbort = () => kill();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (isStale?.()) {
			kill();
			throw new AcpStaleGenerationError("ACP delegation was superseded before prompting");
		}
		if (signal?.aborted) {
			kill();
			throw new Error("Delegation was aborted");
		}
		const boundedStdout = proc.stdout.pipe(createBoundedLineTransform(MAX_ACP_PROTOCOL_LINE_BYTES));
		const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(boundedStdout));

		// Loaded sessions bypass the SDK ActiveSession (which only wraps
		// session/new), so session/update notifications for the resumed ID are
		// routed through a local queue. Routing starts only after session/load
		// succeeds: adapters replay conversation history during load, and replayed
		// chunks must not surface as new output.
		const loadedUpdates = new AcpUpdateQueue();
		let routeSessionId: string | null = null;
		// Whether a usable session existed before the failure: mid-turn failures
		// after this point taint the lane (M2); failures before it do not.
		let sessionEstablished = false;
		// Load failed and we rotated to fresh (M1): if the fresh path also fails,
		// the stored lane is stale and must be invalidated.
		let rotated = false;

		const client = acp
			.client({ name: "pi" })
			.onRequest(acp.methods.client.session.requestPermission, (c) => policy.requestPermission(c.params))
			.onNotification(acp.methods.client.session.update, (c) => {
				if (routeSessionId !== null && c.params.sessionId === routeSessionId) {
					loadedUpdates.push({ kind: "session_update", notification: c.params, update: c.params.update });
				}
			})
			.connectWith(stream, async (cx) => {
				const initialized = await cx.request(acp.methods.agent.initialize, {
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: {},
				});
				if (onInitialized) {
					// A probe/observer callback must never perturb the delegation:
					//  - Clone before handing it out. The capability gate below reads the
					//    SAME `agentCapabilities` object a few lines down (`loadSession`);
					//    a callback that mutated the live object would silently flip
					//    continuity planning. (`agentCapabilities` is the field name in the
					//    installed v1 SDK; a future v2 bump renames it to `capabilities`,
					//    which would make both this AND the gate read `undefined` together.)
					//  - Swallow a sync throw AND an async rejection — an `async` callback
					//    whose promise rejects would otherwise become an unhandled rejection
					//    and, under Node's default, tear down the whole host process.
					try {
						const caps = (initialized as { agentCapabilities?: unknown }).agentCapabilities;
						const snapshot = caps === undefined ? undefined : structuredClone(caps);
						const r: unknown = onInitialized(snapshot);
						if (r && typeof (r as { then?: unknown }).then === "function") void Promise.resolve(r).catch(() => {});
					} catch {
						/* observer error is never the delegation's problem */
					}
				}

				// Capability gate: resume only what the adapter actually advertised.
				const canLoad = initialized.agentCapabilities?.loadSession === true;
				const plan = planRunnerContinuity(canLoad, resumeSessionId !== undefined, continuityMode);
				if (plan.action === "fail") {
					if (plan.reason === "load-unsupported") {
						throw new AcpResumeUnsupportedError(
							'This ACP adapter does not advertise the loadSession capability, so continuity "require" cannot resume the conversation. Use continuity "auto" or "fresh".',
						);
					}
					throw new Error('continuity "require" reached the ACP runner without a stored session to resume');
				}

				let loadedSessionId: string | undefined;
				let loadedConfigOptions: unknown;
				if (plan.action === "load" && resumeSessionId !== undefined) {
					try {
						const loadedResult = await cx.request(acp.methods.agent.session.load, {
							sessionId: resumeSessionId,
							cwd,
							// `?? []` — a caller passing null (not undefined) would skip the
							// destructuring default and put `null` on the wire.
							mcpServers: (mcpServers ?? []) as never,
						});
						loadedSessionId = resumeSessionId;
						loadedConfigOptions = (loadedResult as { configOptions?: unknown }).configOptions;
					} catch {
						if (continuityMode === "require") {
							// Deliberately generic: adapter error text could echo the
							// session ID into model-visible output.
							throw new AcpSessionUnusableError(
								'ACP session/load failed: the stored conversation is no longer resumable. Use continuity "auto" or "fresh" to start a new one.',
							);
						}
						// auto: rotate to a fresh conversation below — unless the failure
						// was our own timeout/abort kill during load, which proves
						// nothing about the stored session (P1: keep it resumable).
						if (!timedOut && !signal?.aborted) rotated = true;
					}
				}

				if (loadedSessionId !== undefined) {
					const loaded = loadedSessionId;
					const sessionConfigId = def.modelOverride?.sessionConfig?.configId;
					await applySessionConfigOverride(
						cx,
						loaded,
						def,
						acp.methods.agent.session.setConfigOption,
						sessionConfigId ? advertisedSessionConfigValues(loadedConfigOptions, sessionConfigId) : undefined,
					);
					sessionEstablished = true;
					establish({ sessionId: loaded, continuity: "loaded" });
					routeSessionId = loaded;
					const promptSession: PromptTurnSession = {
							prompt: (promptText) => {
								void cx
									.request(acp.methods.agent.session.prompt, {
										sessionId: loaded,
										prompt: [{ type: "text", text: promptText }],
									})
									.then(
										(response) =>
											loadedUpdates.push({ kind: "stop", response, stopReason: response.stopReason }),
										(error) => loadedUpdates.fail(error),
									);
							},
							nextUpdate: () => loadedUpdates.next(),
						};
					const safeOnText = (text: string) => onText(safeText(text));
					const turn = await collectPromptTurn(
						promptSession,
						task,
						safeOnText,
						onPromptSubmitted,
						onToolCall,
						onThought,
						isStale,
						kill,
						peekKey,
					);
					return { ...turn, sessionId: loaded, continuity: "loaded" as RunnerContinuity };
				}

				const freshContinuity: RunnerContinuity = plan.action === "load" ? "rotated" : plan.continuity;
				return cx.buildSession({ cwd, mcpServers: (mcpServers ?? []) as never }).withSession(async (session) => {
					const sessionConfigId = def.modelOverride?.sessionConfig?.configId;
					await applySessionConfigOverride(
						cx,
						session.sessionId,
						def,
						acp.methods.agent.session.setConfigOption,
						sessionConfigId
							? advertisedSessionConfigValues(session.newSessionResponse.configOptions, sessionConfigId)
							: undefined,
					);
					sessionEstablished = true;
					establish({ sessionId: session.sessionId, continuity: freshContinuity });
					const safeOnText = (text: string) => onText(safeText(text));
					const turn = await collectPromptTurn(
						session,
						task,
						safeOnText,
						onPromptSubmitted,
						onToolCall,
						onThought,
						isStale,
						kill,
						peekKey,
					);
					return { ...turn, sessionId: session.sessionId, continuity: freshContinuity };
				});
			});

		// A timeout/abort kill tears the connection down, so the SDK's generic
		// connection-closed rejection would otherwise mask the real cause. Typed
		// lane errors keep priority: they carry invalidation semantics.
		let turnResult: Awaited<typeof client>;
		try {
			turnResult = await client;
		} catch (error) {
			if (error instanceof AcpSessionUnusableError || error instanceof AcpResumeUnsupportedError) throw error;
			if (error instanceof AcpStaleGenerationError || error instanceof AcpModelOverrideError) throw error;
			// M1: a real load failure followed by a FAILED fresh creation leaves the
			// old lane pointing at a dead session — invalidate it. A successful
			// session/new (sessionEstablished) must not invalidate: timeout/abort
			// on the new conversation keep it resumable, exactly like loaded
			// sessions.
			if (rotated && !sessionEstablished) {
				throw new AcpSessionUnusableError("ACP session rotation failed; the stored lane is stale");
			}
			if (timedOut) throw new Error(`Delegation timed out after ${Math.round(timeoutMs / 1000)}s`);
			if (isStale?.()) {
				kill();
				throw new AcpStaleGenerationError("ACP delegation was superseded by a newer fleet generation");
			}
			if (signal?.aborted) throw new Error("Delegation was aborted");
			// M2: any other failure after a session was established (loaded or
			// fresh) happened at an uncertain point mid-turn; the session may be
			// partially mutated, so the lane is tainted rather than resumed.
			// Surface the adapter's verbatim error + pinned versions (Cyra's
			// version-lag 400 was previously replaced with a generic string).
			const failure = formatAcpFailure({
				established: sessionEstablished,
				error,
				stderr,
				adapter: adapterInfo,
				safeText,
			});
			if (peekKey) getLanePeekStore().noteError(peekKey, failure);
			if (sessionEstablished) throw new AcpTurnUncertainError(failure);
			// Pre-establishment: same surfacing as post-establish (error + stderr
			// + versions), always through safeText so an unread session id is scrubbed.
			throw new Error(failure);
		}
		const { text, toolCalls, stopReason, sessionId, continuity, usage } = turnResult;

		if (timedOut) throw new Error(`Delegation timed out after ${Math.round(timeoutMs / 1000)}s`);
		if (isStale?.()) {
			kill();
			throw new AcpStaleGenerationError("ACP delegation was superseded by a newer fleet generation");
		}
		if (signal?.aborted) throw new Error("Delegation was aborted");

		return {
			text: safeText(text),
			toolCalls,
			stopReason: stopReason ?? "unknown",
			stderr: safeText(stderr.slice(-2000)),
			timedOut,
			sessionId,
			continuity,
			usage: usage ?? normalizeAcpUsage(undefined),
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		kill();
	}
}
