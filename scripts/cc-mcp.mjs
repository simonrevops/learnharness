#!/usr/bin/env node
// The LearnHarness MCP server Claude Code launches for a lesson (Claude Code
// engine, docs/claude-code-engine.md). A thin stdio proxy: every tool lives in
// the LearnHarness server (src/server/cc/tools.ts) and runs there against the
// real stores; this process only speaks MCP's newline-delimited JSON-RPC.
//
// env: LH_URL (the LearnHarness server), LH_CHAT_ID (the lesson's chat).

import readline from "node:readline";

const LH_URL = process.env.LH_URL ?? "http://127.0.0.1:3000";
const CHAT_ID = process.env.LH_CHAT_ID ?? "";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch JSON, riding out a LearnHarness restart (dev reloads) with retries. */
async function lh(path, init) {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(`${LH_URL}${path}`, init);
			if (res.status >= 500 && attempt < 20) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} catch (err) {
			if (attempt >= 20) throw err;
			await sleep(Math.min(5000, 500 * (attempt + 1)));
		}
	}
}

async function callTool(name, args) {
	const out = await lh("/api/cc/tools/call", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chatId: CHAT_ID, name, arguments: args ?? {} }),
	});
	return out.result ?? { content: [{ type: "text", text: out.error ?? "LearnHarness returned nothing" }], isError: true };
}

async function handle(msg) {
	const { id, method, params } = msg;
	if (method === "initialize") {
		return reply(id, {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "learnharness", version: "0.1.0" },
		});
	}
	if (method?.startsWith("notifications/")) return;
	if (method === "ping") return reply(id, {});
	if (method === "tools/list") {
		try {
			const out = await lh(`/api/cc/tools?chatId=${encodeURIComponent(CHAT_ID)}`);
			return reply(id, { tools: out.tools ?? [] });
		} catch (err) {
			return fail(id, -32603, `LearnHarness is not reachable at ${LH_URL}: ${err.message}`);
		}
	}
	if (method === "tools/call") {
		try {
			return reply(id, await callTool(params?.name, params?.arguments));
		} catch (err) {
			return reply(id, { content: [{ type: "text", text: `LearnHarness is not reachable: ${err.message}` }], isError: true });
		}
	}
	if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	void handle(msg);
});
