/**
 * Shared dangerous-command detection.
 *
 * Single source of truth for bash-guard.ts (pi's own bash tool) and the ACP
 * permission policy (external subagents). Pure logic, no pi imports, so it is
 * also importable from node-based tests.
 *
 * Heuristic, not a security boundary (see below). Command-anchored patterns
 * require the command to appear at a command boundary (start, or after
 * whitespace/`;`/`&`/`|`/`(`) so that quoted text like
 * `echo 'rm -rf is dangerous'` is not flagged. Path-qualified executables
 * (`/bin/rm`) and common wrappers (`command`, `env`) are matched. This remains
 * heuristic; quoted operands with spaces are not fully modeled.
 */

export interface Pattern {
	re: RegExp;
	label: string;
}

/** Start of a command: beginning of input or after a command separator. */
const CMD = String.raw`(?:^|[\s;&|(])`;
/** Optional path qualifier: `/bin/rm`, `./script`, `/usr/bin/env sh`. */
const BIN = String.raw`(?:\S*\/)?`;

export const DANGEROUS_PATTERNS: Pattern[] = [
	{ re: new RegExp(CMD + BIN + String.raw`sudo\b`), label: "sudo" },
	{ re: new RegExp(CMD + BIN + String.raw`(chmod|chown)\b[^|;&\n]*777`), label: "chmod/chown 777" },
	{ re: new RegExp(CMD + BIN + String.raw`chmod\s+-R\b`), label: "recursive chmod" },
	{
		// Git global options before the subcommand, space- or =-valued:
		//   git -C /x reset --hard | git --git-dir /repo/.git reset --hard
		// Clean with any flag arrangement: git clean -x -f -d
		// Force push incl. forced refspec: git push origin +main:main
		re: new RegExp(
			CMD +
				BIN +
				String.raw`git\s+(?:-[a-zA-Z]+(?:\s+\S+)?\s+|--[a-z-]+(?:=(?:\S+)|(?:\s+\S+))?\s+)*(?:reset\s+--hard|clean\b[^|;&\n]*?(?:\s-[a-z]*[fd][a-z]*\b|\s--force\b)|push\b[^|;&\n]*(?:--force|-f\b|--force-with-lease|--delete|\+\S*:))`,
			"i",
		),
		label: "destructive git",
	},
	{
		re: new RegExp(
			CMD +
				BIN +
				String.raw`(curl|wget)\b[^;&\n]*\|(?:[^;&\n|]*\|)*\s*` +
				BIN +
				String.raw`(ba|da|z|k)?sh\b`,
		),
		label: "curl|wget piped to shell",
	},
	{ re: new RegExp(CMD + BIN + String.raw`(?:mkfs\b|diskutil\s+eraseDisk\b|fdisk\b|parted\b)`), label: "disk formatting" },
	{ re: new RegExp(CMD + BIN + String.raw`dd\s+[^|;&\n]*of=\/dev\/`, "i"), label: "dd writing to /dev" },
	{ re: new RegExp(CMD + BIN + String.raw`(shutdown|reboot|halt|poweroff)\b`), label: "power state change" },
	{ re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}/, label: "fork bomb" },
];

/**
 * SSRF / local-resource reach patterns for network requests (fetch/web).
 *
 * Deliberately NOT part of DANGEROUS_PATTERNS: bash-guard governs the user's own
 * shell, where hitting localhost during development is normal and must not be
 * flagged. These are consulted ONLY by the ACP sub-agent permission policy, where
 * a sub-agent (an untrusted, prompt-injectable process) reaching a loopback,
 * link-local, cloud-metadata, private-network, or file:// target is the classic
 * SSRF/exfiltration vector and should never silently auto-allow.
 */
// Only the cases the host normalizer (findSsrf) does NOT resolve on its own —
// bare host IP literals in any encoding are the normalizer's job, and doing them
// here as substrings would false-positive on userinfo (127.0.0.1@public-host).
export const SSRF_PATTERNS: Pattern[] = [
	{ re: /\bfile:\/\//i, label: "file:// URL" },
	{ re: /\bgopher:\/\//i, label: "gopher:// URL" },
	{ re: /\bmetadata\.(?:google\.internal|goog|azure\.com)\b/i, label: "cloud-metadata host" },
	// An internal IP embedded as a hostname LABEL — wildcard-DNS SSRF services
	// (nip.io / sslip.io / xip.io) resolve `<internal-ip>.rest` to that IP. The
	// trailing `.<label-char>` distinguishes this from a bare host IP and from
	// userinfo (an IP before `@`), so it doesn't re-introduce that false positive.
	{
		re: /\b(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\.[a-z0-9-]/i,
		label: "internal-IP hostname label",
	},
];

/** Parse one IPv4 octet allowing decimal, 0x-hex, and 0-octal (inet_aton). */
function parseOctet(p: string): number | null {
	if (/^0x[0-9a-f]+$/i.test(p)) return Number.parseInt(p, 16);
	if (/^0[0-7]+$/.test(p)) return Number.parseInt(p, 8);
	if (/^\d+$/.test(p)) return Number.parseInt(p, 10);
	return null;
}

/**
 * Resolve a host string to a 32-bit IPv4 int under inet_aton rules — the same
 * lenient parsing libc/`fetch` use, so `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`
 * and `127.1` all resolve to 127.0.0.1. Returns null if it isn't an IPv4 literal.
 */
function inetAton(host: string): number | null {
	const parts = host.split(".");
	if (parts.length === 0 || parts.length > 4) return null;
	const nums: number[] = [];
	for (const p of parts) {
		const n = parseOctet(p);
		if (n === null || n < 0) return null;
		nums.push(n);
	}
	let ip: number;
	if (nums.length === 1) ip = nums[0];
	else if (nums.length === 2) {
		if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
		ip = nums[0] * 2 ** 24 + nums[1];
	} else if (nums.length === 3) {
		if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
		ip = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2];
	} else {
		if (nums.some((n) => n > 0xff)) return null;
		ip = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2] * 2 ** 8 + nums[3];
	}
	if (ip < 0 || ip > 0xffffffff) return null;
	return ip >>> 0;
}

/** Range label for a 32-bit IPv4 int, or null if it's an ordinary public address. */
function ipv4Label(ip: number): string | null {
	const a = (ip >>> 24) & 0xff;
	const b = (ip >>> 16) & 0xff;
	if (a === 127 || a === 0) return "loopback";
	if (a === 10) return "private";
	if (a === 192 && b === 168) return "private";
	if (a === 172 && b >= 16 && b <= 31) return "private";
	if (a === 169 && b === 254) return "link-local/metadata";
	return null;
}

/** Expand and classify an IPv6 host (incl. ::1, ::ffff:127.x, fe80::, fc00::/7). */
function ipv6Label(raw: string): string | null {
	let h = raw
		.replace(/^\[|\]$/g, "")
		.split("%")[0]
		.toLowerCase();
	if (!h.includes(":")) return null;
	let v4: number | null = null;
	const m = h.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
	if (m) {
		v4 = inetAton(m[1]);
		if (v4 === null) return null;
		h = h.slice(0, h.length - m[1].length);
	}
	const halves = h.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
	const groups: string[] = [];
	if (v4 !== null) tail.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
	if (halves.length === 2) {
		const missing = 8 - head.length - tail.length;
		if (missing < 0) return null;
		groups.push(...head, ...Array(missing).fill("0"), ...tail);
	} else {
		if (head.length !== 8) return null;
		groups.push(...head);
	}
	if (groups.length !== 8) return null;
	const v = groups.map((g) => Number.parseInt(g || "0", 16));
	if (v.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
	if (v.slice(0, 7).every((x) => x === 0) && v[7] === 1) return "loopback"; // ::1
	if (v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0 && v[4] === 0 && v[5] === 0xffff) {
		const lbl = ipv4Label(((v[6] << 16) | v[7]) >>> 0); // ::ffff:a.b.c.d
		if (lbl) return lbl;
	}
	if ((v[0] & 0xffc0) === 0xfe80) return "link-local/metadata"; // fe80::/10
	if ((v[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
	return null;
}

/** Classify a bare host (hostname or IP literal in any encoding) as internal. */
function hostLabel(rawHost: string): string | null {
	let h = rawHost.trim();
	try {
		h = decodeURIComponent(h);
	} catch {
		/* keep raw on malformed escapes */
	}
	h = h.toLowerCase();
	if (h.startsWith("[") || (h.includes(":") && h.split(":").length > 2)) return ipv6Label(h);
	h = h.replace(/\.$/, ""); // a fully-qualified trailing dot resolves the same
	if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
	if (h === "metadata.google.internal" || h === "metadata.goog" || h.endsWith(".internal")) return "link-local/metadata";
	const ip = inetAton(h);
	return ip === null ? null : ipv4Label(ip);
}

/**
 * First SSRF/local-resource hit in the text (ACP policy only).
 *
 * Two layers: literal substring patterns (catch an internal IP embedded in a
 * hostname, e.g. `127.0.0.1.nip.io`, and `file://`), plus a real host normalizer
 * that resolves every URL's host under inet_aton / IPv6 rules so encoded
 * bypasses — decimal (`2130706433`), hex (`0x7f.0.0.1`), octal (`0177.0.0.1`),
 * short (`127.1`), percent-encoded, backslash- or newline-obfuscated, and
 * IPv4-mapped IPv6 (`[::ffff:7f00:1]`) — all resolve to the same block.
 */
export function findSsrf(text: string): Pattern | undefined {
	// Normalize the obfuscations `fetch`/browsers tolerate: backslashes act as
	// slashes; whitespace (incl. embedded newlines) inside a URL is ignored.
	const norm = text.replace(/\\/g, "/");
	const stripped = norm.replace(/\s+/g, "");
	for (const p of SSRF_PATTERNS) {
		if (p.re.test(norm) || p.re.test(stripped)) return p;
	}
	const urlRe = /(?:https?|ftp):\/\/(?:[^/@\s]*@)?(\[[^\]]+\]|[^/:?#\s]+)/gi;
	for (const src of [norm, stripped]) {
		urlRe.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = urlRe.exec(src)) !== null) {
			const label = hostLabel(m[1]);
			if (label) return { re: /ssrf/, label: `${label} URL` };
		}
	}
	return undefined;
}

const RM_BIN = /^(\S*\/)?rm$/;

function unwrapCommonWrapper(segment: string): string | undefined {
	const tokens = segment.trim().split(/\s+/);
	if (tokens.length < 2) return undefined;
	let commandIndex = 0;
	const wrapperName = (tokens[commandIndex] ?? "").split("/").pop();
	if (wrapperName === "command") {
		commandIndex++;
		while ((tokens[commandIndex] ?? "").startsWith("-")) commandIndex++;
	}
	const envName = (tokens[commandIndex] ?? "").split("/").pop();
	if (envName === "env") {
		commandIndex++;
		while (commandIndex < tokens.length) {
			const token = tokens[commandIndex] ?? "";
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				commandIndex++;
				continue;
			}
			if (token === "--") {
				commandIndex++;
				break;
			}
			if (["-u", "--unset", "-C", "--chdir"].includes(token)) {
				commandIndex += 2;
				continue;
			}
			if (token === "-S" || token === "--split-string") {
				commandIndex++;
				break;
			}
			if (token.startsWith("--split-string=")) {
				tokens[commandIndex] = token.slice("--split-string=".length);
				break;
			}
			if (token.startsWith("-")) {
				commandIndex++;
				continue;
			}
			break;
		}
	}
	if (commandIndex === 0 || commandIndex >= tokens.length) return undefined;
	return tokens
		.slice(commandIndex)
		.join(" ")
		.replace(/^["']+/, "")
		.replace(/["']+$/, "")
		.replace(/\\ /g, " ");
}

/**
 * Recursive rm: scans every segment of the command for an `rm` invocation and
 * flags it when a recursive flag (`-r` in any token, or `--recursive`) is
 * present — regardless of flag grouping, order, or operand position
 * (`rm build -rf` is covered). Interactive `-i`/`--interactive` neutralizes
 * the flag only while no `-f`/`--force` is also present (`rm -ri -f` is
 * flagged, `rm -ri` is not).
 */
function isRecursiveRm(command: string): boolean {
	const segments = command.split(/[;&|]/);
	for (const segment of segments) {
		const tokens = segment.trim().split(/\s+/);
		if (tokens.length < 2) continue;
		let commandIndex = 0;
		const wrapperName = (tokens[commandIndex] ?? "").split("/").pop();
		if (wrapperName === "command") {
			commandIndex++;
			while ((tokens[commandIndex] ?? "").startsWith("-")) commandIndex++;
		}
		const envName = (tokens[commandIndex] ?? "").split("/").pop();
		if (envName === "env") {
			commandIndex++;
			while (commandIndex < tokens.length) {
				const token = tokens[commandIndex] ?? "";
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					commandIndex++;
					continue;
				}
				if (token === "--") {
					commandIndex++;
					break;
				}
				if (["-u", "--unset", "-C", "--chdir"].includes(token)) {
					commandIndex += 2;
					continue;
				}
				if (token === "-S" || token === "--split-string") {
					// env parses the following split string as the command plus args.
					commandIndex++;
					break;
				}
				if (token.startsWith("--split-string=")) {
					tokens[commandIndex] = token.slice("--split-string=".length);
					break;
				}
				if (token.startsWith("-")) {
					commandIndex++;
					continue;
				}
				break;
			}
		}
		const normalizeSplitToken = (token: string) => token.replace(/^["']+/, "").replace(/["'\\]+$/, "");
		if (!RM_BIN.test(normalizeSplitToken(tokens[commandIndex] ?? ""))) continue;

		const flags = tokens.slice(commandIndex + 1).map(normalizeSplitToken);
		const hasR = flags.some((f) => f === "--recursive" || (/^-[a-zA-Z]+$/.test(f) && f.includes("r")));
		const hasF = flags.some((f) => f === "--force" || (/^-[a-zA-Z]+$/.test(f) && f.includes("f")));
		const hasI = flags.some((f) => f === "--interactive" || (/^-[a-zA-Z]+$/.test(f) && f.includes("i")));

		if (hasR && !(hasI && !hasF)) return true;
	}
	return false;
}

/** Returns the first dangerous pattern matching the command, if any. */
export function findDangerous(command: string): Pattern | undefined {
	if (isRecursiveRm(command)) {
		return { re: /rm/, label: "recursive rm" };
	}
	const direct = DANGEROUS_PATTERNS.find((p) => p.re.test(command));
	if (direct) return direct;
	for (const segment of command.split(/[;&|]/)) {
		const unwrapped = unwrapCommonWrapper(segment);
		if (!unwrapped) continue;
		if (isRecursiveRm(unwrapped)) return { re: /rm/, label: "recursive rm" };
		const hit = DANGEROUS_PATTERNS.find((pattern) => pattern.re.test(unwrapped));
		if (hit) return hit;
	}
	return undefined;
}

/** Scan structured ACP tool input without destroying command boundaries via JSON serialization. */
export function findDangerousInValue(value: unknown, seen = new Set<object>()): Pattern | undefined {
	if (typeof value === "string") return findDangerous(value);
	if (value === null || typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) {
			const hit = findDangerousInValue(entry, seen);
			if (hit) return hit;
		}
		return undefined;
	}
	for (const entry of Object.values(value as Record<string, unknown>)) {
		const hit = findDangerousInValue(entry, seen);
		if (hit) return hit;
	}
	return undefined;
}
