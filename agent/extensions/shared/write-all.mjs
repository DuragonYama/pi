import { writeSync } from "node:fs";

/**
 * Drain `buffer` to `fd`. When `position` is a number, write at that offset
 * (and subsequent bytes); otherwise write at the current file position.
 * Used by bg.ts (current-position) and the detached bg-log-writer (positioned).
 */
export function writeAll(fd, buffer, position) {
	let offset = 0;
	while (offset < buffer.length) {
		const at = position === undefined ? undefined : position + offset;
		offset += writeSync(fd, buffer, offset, buffer.length - offset, at);
	}
}
