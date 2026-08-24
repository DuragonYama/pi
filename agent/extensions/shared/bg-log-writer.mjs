#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, fstatSync, ftruncateSync, readSync, writeSync } from "node:fs";

const LOG_FD = 3;
const command = process.argv[2];
const activeMax = Number(process.argv[3]);
const finalMax = Number(process.argv[4]);

if (!command || !Number.isSafeInteger(activeMax) || activeMax < 1 || !Number.isSafeInteger(finalMax) || finalMax < 1) {
	process.exit(64);
}

let size = fstatSync(LOG_FD).size;
let closed = false;

function writeAll(buffer, position) {
	let offset = 0;
	while (offset < buffer.length) {
		offset += writeSync(LOG_FD, buffer, offset, buffer.length - offset, position + offset);
	}
}

function retainTail(maxBytes) {
	const keep = Math.min(size, maxBytes);
	const tail = Buffer.alloc(keep);
	let read = 0;
	while (read < keep) {
		const count = readSync(LOG_FD, tail, read, keep - read, size - keep + read);
		if (count === 0) break;
		read += count;
	}
	ftruncateSync(LOG_FD, 0);
	if (read > 0) writeAll(tail.subarray(0, read), 0);
	size = read;
}

function append(chunk) {
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	if (buffer.length >= activeMax) {
		ftruncateSync(LOG_FD, 0);
		const tail = buffer.subarray(buffer.length - activeMax);
		writeAll(tail, 0);
		size = tail.length;
		return;
	}
	if (size + buffer.length > activeMax) retainTail(Math.min(finalMax, activeMax - buffer.length));
	writeAll(buffer, size);
	size += buffer.length;
}

function finish(code) {
	if (closed) return;
	closed = true;
	try {
		retainTail(finalMax);
		closeSync(LOG_FD);
	} catch {
		process.exitCode = 1;
		return;
	}
	process.exitCode = typeof code === "number" ? code : 1;
}

let child;
try {
	child = spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
	append(Buffer.from(`Failed to start command: ${error instanceof Error ? error.message : String(error)}\n`));
	finish(127);
}

if (child) {
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	child.on("error", (error) => {
		append(Buffer.from(`Failed to start command: ${error.message}\n`));
	});
	child.on("close", (code) => finish(code));
}
