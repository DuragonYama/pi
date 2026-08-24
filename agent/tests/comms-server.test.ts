/**
 * Agent-comms Phase 2 — comms MCP server: loop-safety guard + the server-side
 * authorization boundary (token → identity, unknown token rejected, tool
 * dispatch carries the AUTHENTICATED caller, never trusts caller-supplied id).
 */

import assert from "node:assert/strict";
import { loopGuard, startCommsServer, type CommsDeps } from "../extensions/subagent/comms-server.ts";

// --- loopGuard (pure) -------------------------------------------------------
{
	const empty = new Set<string>();
	assert.equal(loopGuard(empty, "A", "B", "B"), null, "A→B with nothing in flight is allowed");
	assert.equal(loopGuard(empty, "A", "A", "A") !== null, true, "self-message is refused");

	// Depth-1: A is mid-message (in reentrant) → A may not originate another.
	const aBusy = new Set<string>(["A"]);
	assert.equal(loopGuard(aBusy, "A", "C", "C") !== null, true, "a message-reached agent cannot originate (depth cap)");

	// Cycle: target already handling a message in this chain.
	const bBusy = new Set<string>(["B"]);
	assert.equal(loopGuard(bBusy, "A", "B", "B") !== null, true, "messaging an agent already in the chain is refused");

	// The depth cap alone makes A→B→A impossible: once A messages B, B ∈ reentrant,
	// so B→anyone is refused before it could reach A.
	const chain = new Set<string>(["B"]); // B is executing A's message
	assert.equal(loopGuard(chain, "B", "A", "A") !== null, true, "B (reached from A) cannot message A back");
	assert.equal(loopGuard(chain, "B", "C", "C") !== null, true, "B (reached from A) cannot message C either");
}

// --- server auth + dispatch (end-to-end over loopback HTTP) ------------------
{
	const calls: Array<{ tool: string; args: any }> = [];
	const live = new Set<string>(["loom-caller"]);
	const deps: CommsDeps = {
		nameOf: (loomId) => (loomId === "loom-caller" ? "Caller" : undefined),
		isLiveAgent: (loomId) => live.has(loomId),
		async messageAgent(args) {
			calls.push({ tool: "message_agent", args });
			return { text: "reply-from-target" };
		},
		readHistory(args) {
			calls.push({ tool: "read_history", args });
			return { text: "some-history" };
		},
	};

	const server = await startCommsServer(deps);
	const cfg = server.mcpServerFor("loom-caller") as { url: string; headers: Array<{ name: string; value: string }> };
	const token = cfg.headers.find((h) => h.name === "x-pi-token")!.value;

	const post = (body: unknown, tok?: string) =>
		fetch(server.url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", ...(tok ? { "x-pi-token": tok } : {}) },
			body: JSON.stringify(body),
		});

	try {
		// Unknown / missing token → 403 before any routing.
		assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "initialize" })).status, 403, "missing token is rejected");
		assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, "deadbeef")).status, 403, "unknown token is rejected");

		// initialize with a valid token.
		const initRes = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, token);
		assert.equal(initRes.status, 200);
		const init = await initRes.json();
		assert.equal(init.result.serverInfo.name, "pi-comms");

		// tools/list exposes exactly the two comms tools.
		const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);
		const list = await listRes.json();
		const names = list.result.tools.map((t: any) => t.name).sort();
		assert.deepEqual(names, ["message_agent", "read_history"], "both comms tools are listed");

		// message_agent dispatch carries the AUTHENTICATED identity (from the token,
		// NOT from tool args) and strips a leading @ on the target.
		const mRes = await post(
			{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message_agent", arguments: { name: "@Onyx", text: "do the thing" } } },
			token,
		);
		const m = await mRes.json();
		assert.equal(m.result.content[0].text, "reply-from-target");
		assert.equal(m.result.isError, false);
		const mc = calls.find((c) => c.tool === "message_agent")!;
		assert.equal(mc.args.callerLoomId, "loom-caller", "caller loomId comes from the token");
		assert.equal(mc.args.callerName, "Caller", "caller name is resolved server-side");
		assert.equal(mc.args.targetName, "Onyx", "leading @ is stripped from the target");
		assert.equal(mc.args.text, "do the thing");

		// message_agent input validation: empty target / text is a tool error.
		const bad = await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "message_agent", arguments: { name: "", text: "x" } } }, token)).json();
		assert.equal(bad.result.isError, true, "empty target name is a tool error, not a crash");

		// read_history routes with the caller identity too.
		const hRes = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_history", arguments: {} } }, token);
		const h = await hRes.json();
		assert.equal(h.result.content[0].text, "some-history");
		assert.equal(calls.find((c) => c.tool === "read_history")!.args.callerLoomId, "loom-caller");

		// A stable token per loomId: a second mcpServerFor reuses it, with a unique name.
		const cfg2 = server.mcpServerFor("loom-caller") as { name: string; headers: Array<{ name: string; value: string }> };
		assert.equal(cfg2.headers.find((h) => h.name === "x-pi-token")!.value, token, "token is stable per agent");
		assert.equal(cfg2.name.startsWith("pi-comms-"), true, "server name embeds the token (unique per agent)");

		// Liveness: a token for an agent that is NOT live is rejected before routing.
		const deadCfg = server.mcpServerFor("loom-dead") as { headers: Array<{ name: string; value: string }> };
		const deadToken = deadCfg.headers.find((h) => h.name === "x-pi-token")!.value;
		assert.equal((await post({ jsonrpc: "2.0", id: 9, method: "initialize" }, deadToken)).status, 403, "token for a non-live agent is rejected");

		// Revoke kills a live agent's token (e.g. on /kill): further requests 403.
		server.revoke("loom-caller");
		assert.equal((await post({ jsonrpc: "2.0", id: 10, method: "tools/list" }, token)).status, 403, "revoked token can no longer route");
	} finally {
		await server.close();
	}
}

console.log("ALL COMMS-SERVER TESTS PASSED");
