/**
 * Bounded UTF-8 helpers — one place for head/tail/append truncation.
 * Never splits a multi-byte code unit.
 */

/** Last N UTF-8 bytes. */
export function utf8TailWithin(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

/** First N UTF-8 bytes. */
export function utf8HeadWithin(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Append `chunk` and keep the last `maxBytes` of the result. */
export function appendBoundedUtf8(current: string, chunk: string, maxBytes: number): string {
	return utf8TailWithin(current + chunk, maxBytes);
}

/** Head-truncate with an ellipsis so the result is ≤ maxBytes. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "…";
	const target = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	return `${utf8HeadWithin(text, target)}${marker}`;
}
