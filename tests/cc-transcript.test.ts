/**
 * Claude Code engine — transcript → record conversion (src/server/cc/transcript.ts).
 *
 * Synthetic transcripts in Claude Code's on-disk shape: one entry per content
 * block, blocks of one response sharing message.id. Pins what enters the
 * lesson record (teacher text, LearnHarness tool calls and results) and what
 * never does (learner prompts, built-in tools, chatter after a posed
 * question, maintenance turns, Claude Code's own injected prompts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { convertTranscript, type CcEntry } from "../src/server/cc/transcript.ts";
import { MAINTENANCE_PREFIX } from "../src/server/cc/env.ts";

const CHAT = "chat_cc_transcript_test";
let n = 0;
const ts = () => new Date(Date.UTC(2026, 9, 24, 12, 0, n++)).toISOString();

function prompt(text: string, extra: Partial<CcEntry> = {}): CcEntry {
	return { type: "user", uuid: `u${n}`, timestamp: ts(), message: { role: "user", content: text }, ...extra };
}
function block(msgId: string, b: Record<string, unknown>, stop = "end_turn"): CcEntry {
	return {
		type: "assistant",
		uuid: `a${n}`,
		timestamp: ts(),
		message: { id: msgId, role: "assistant", model: "claude-test", content: [b as never], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 2 } },
	};
}
function result(id: string, text: string, isError = false): CcEntry {
	return {
		type: "user",
		uuid: `r${n}`,
		timestamp: ts(),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
	};
}
const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });

test("blocks of one response group into one assistant message; prompts and built-in tools stay out", () => {
	const out = convertTranscript(
		[
			prompt("I want to learn X"),
			block("m1", { type: "thinking", thinking: "hmm" }, "tool_use"),
			block("m1", { type: "text", text: "Let me check your map." }, "tool_use"),
			block("m1", use("t1", "mcp__lh__list_sessions"), "tool_use"),
			result("t1", "The knowledge graph is empty."),
			block("m2", use("t2", "Read", { file_path: "/x" }), "tool_use"),
			result("t2", "file contents"),
			block("m3", { type: "text", text: "Here is the idea." }),
		],
		CHAT,
	);
	assert.deepEqual(
		out.messages.map((m) => m.role),
		["assistant", "toolResult", "assistant"],
	);
	const first = out.messages[0] as { content: Array<{ type: string; name?: string }> };
	assert.deepEqual(first.content.map((c) => c.type), ["thinking", "text", "toolCall"]);
	assert.equal(first.content[2]!.name, "list_sessions", "the lh tool name loses its mcp__lh__ prefix");
	assert.equal(out.messages[0]!.id, "msg_cc_m1", "ids derive from the transcript");
});

test("a posed question: the record ends at the unanswered call; chatter after it is dropped", () => {
	const out = convertTranscript(
		[
			prompt("go"),
			block("m1", { type: "text", text: "Step one, explained." }, "tool_use"),
			block("m1", use("q1", "mcp__lh__quiz", { question: "?" }), "tool_use"),
			result("q1", "Question posed — it is on the learner's screen now."),
			prompt("[Your previous response had no visible output.]", { isMeta: true }),
			block("m2", { type: "text", text: "I've put a question on your screen." }),
		],
		CHAT,
	);
	assert.equal(out.messages.length, 1);
	const last = out.messages.at(-1) as { role: string; content: Array<{ type: string }> };
	assert.equal(last.role, "assistant");
	assert.equal(last.content.at(-1)!.type, "toolCall");
});

test("a refused question keeps its error result (the model retries, as under pi)", () => {
	const out = convertTranscript(
		[
			prompt("go"),
			block("m1", use("q1", "mcp__lh__quiz", { question: "?" }), "tool_use"),
			result("q1", "Invalid tool input", true),
			block("m2", use("q2", "mcp__lh__quiz", { question: "fixed?" }), "tool_use"),
			result("q2", "Question posed"),
		],
		CHAT,
	);
	assert.deepEqual(out.messages.map((m) => m.role), ["assistant", "toolResult", "assistant"]);
	assert.equal((out.messages[1] as { isError: boolean }).isError, true);
});

test("maintenance turns are invisible, including Claude Code's notices inside them", () => {
	const out = convertTranscript(
		[
			prompt("go"),
			block("m1", { type: "text", text: "Teaching." }),
			prompt(`${MAINTENANCE_PREFIX} Update the knowledge graph now.`),
			block("m2", use("a1", "Agent", { subagent_type: "graph-extractor" }), "tool_use"),
			result("a1", "launched"),
			block("m3", { type: "text", text: "Graph update is running." }),
			prompt("<task-notification>done</task-notification>", { origin: { kind: "task-notification" } }),
			block("m4", { type: "text", text: "Knowledge graph updated." }),
		],
		CHAT,
	);
	assert.deepEqual(out.messages.map((m) => m.id), ["msg_cc_m1"]);
	assert.equal(out.inMaintenance, true);
	const after = convertTranscript(
		[
			prompt(`${MAINTENANCE_PREFIX} Update.`),
			block("m1", { type: "text", text: "Done." }),
			prompt("My answer to your quiz question: {}"),
			block("m2", { type: "text", text: "Right." }),
		],
		CHAT,
	);
	assert.deepEqual(after.messages.map((m) => m.id), ["msg_cc_m2"], "the next real prompt ends maintenance");
});

test("a successful probe_done is followed by the handoff marker, once", () => {
	const out = convertTranscript(
		[
			prompt("go"),
			block("m1", use("p1", "mcp__lh__probe_done", { strands: [] }), "tool_use"),
			result("p1", "Assessment recorded"),
			block("m2", { type: "text", text: "Probe done." }),
		],
		CHAT,
	);
	assert.deepEqual(
		out.messages.map((m) => m.role),
		["assistant", "toolResult", "custom", "assistant"],
	);
	assert.equal(out.messages[2]!.id, `steer_probe_${CHAT}`);
	assert.deepEqual(out.prompts, ["go"]);
});
