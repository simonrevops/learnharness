import fs from "node:fs";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../../core/native-messages.ts";
import { newHandoffMessage } from "../../core/native-messages.ts";
import { CC_TOOL_PREFIX, MAINTENANCE_PREFIX } from "./env.ts";
import { lookupToolResult } from "./results.ts";
import { isQuestionTool } from "./tools.ts";

/**
 * Claude Code transcript → LearnHarness record messages.
 *
 * STATELESS: the whole transcript converts on every read (a lesson's
 * transcript is small), and every message id derives from the transcript —
 * the same entry always yields the same record message, so "new" is simply
 * "an id the record doesn't hold yet".
 *
 * WHAT ENTERS THE RECORD: the teacher's assistant turns (text, thinking, and
 * calls to LearnHarness's own tools) and the results of those tool calls.
 * What never does: the learner's prompts (LearnHarness wrote those itself,
 * write-ahead, before typing them into the terminal), Claude Code's built-in
 * tools (Read, web search, subagents — the lesson record is the teaching,
 * not the machinery), and maintenance turns (LearnHarness asking Claude Code
 * to update the graph).
 *
 * Claude Code writes one transcript entry per content block; blocks of one
 * API response share `message.id`, so entries group back into one assistant
 * message by that id.
 */

interface CcBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

export interface CcEntry {
	type: string;
	uuid?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	timestamp?: string;
	/** Who produced a user entry: absent/"human" for a typed prompt; Claude
	 *  Code's own injections (task notifications, subagent hand-backs) say so. */
	origin?: { kind?: string };
	subtype?: string;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		content?: string | CcBlock[];
		stop_reason?: string | null;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
}

/** Read and parse a transcript; corrupt or partial lines (a write in
 *  progress) are skipped — the next read picks them up whole. */
export function readTranscript(file: string): CcEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: CcEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as CcEntry);
		} catch {
			/* partial line */
		}
	}
	return out;
}

/** The learner-facing text of a user entry (string prompt or text blocks). */
function userText(entry: CcEntry): string | null {
	const c = entry.message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const texts = c.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text!);
		if (texts.length > 0 && !c.some((b) => b.type === "tool_result")) return texts.join("\n");
	}
	return null;
}

/** A user entry that is a real prompt — typed into the session — not a tool
 *  result and not one of Claude Code's own injections (meta nudges, task
 *  notifications, subagent hand-backs). */
function isPrompt(entry: CcEntry): boolean {
	if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
	if (entry.origin?.kind !== undefined && entry.origin.kind !== "human") return false;
	return userText(entry) !== null;
}

function lhToolName(ccName: string | undefined): string | null {
	return ccName && ccName.startsWith(CC_TOOL_PREFIX) ? ccName.slice(CC_TOOL_PREFIX.length) : null;
}

function stopReason(raw: string | null | undefined): AssistantMessage["stopReason"] {
	if (raw === "tool_use") return "toolUse";
	if (raw === "max_tokens") return "length";
	return "stop";
}

function usageOf(u: NonNullable<CcEntry["message"]>["usage"]): Usage {
	const input = u?.input_tokens ?? 0;
	const output = u?.output_tokens ?? 0;
	const cacheRead = u?.cache_read_input_tokens ?? 0;
	const cacheWrite = u?.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		// Subscription-backed: no per-token charge to show.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => (b && typeof b === "object" && (b as CcBlock).type === "text" ? ((b as CcBlock).text ?? "") : ""))
			.join("");
	}
	return "";
}

export interface ConvertedTranscript {
	messages: LhMessage[];
	/** The id of the latest assistant message that is still receiving blocks
	 *  (the transcript ends inside it) — not yet final. */
	openAssistantId: string | null;
	/** Tool-use ids of LearnHarness tool calls with no result yet. */
	danglingCalls: Array<{ id: string; name: string }>;
	/** True when the transcript currently ends inside a maintenance turn. */
	inMaintenance: boolean;
	/** Every real prompt Claude Code received, in order. */
	prompts: string[];
}

export function convertTranscript(entries: readonly CcEntry[], chatId: string): ConvertedTranscript {
	const messages: LhMessage[] = [];
	const byResponse = new Map<string, LhMessage & AssistantMessage>();
	const callNames = new Map<string, string>();
	const callArgs = new Map<string, unknown>();
	const answered = new Set<string>();
	let inMaintenance = false;
	// After a posed question the turn is over as far as the lesson goes: the
	// record must END at the unanswered call (the dock and the answer path key
	// on that). Chatter the model adds after posing is dropped; a further
	// question message is kept (parallel questions are legal).
	let posed = false;
	let last: LhMessage | null = null;
	const prompts: string[] = [];

	for (const entry of entries) {
		if (entry.isSidechain) continue;
		if (isPrompt(entry)) {
			prompts.push(userText(entry)!);
			inMaintenance = userText(entry)!.trimStart().startsWith(MAINTENANCE_PREFIX);
			posed = false;
			last = null;
			continue;
		}
		if (inMaintenance) continue;

		if (entry.type === "assistant" && entry.message) {
			const m = entry.message;
			const blocks = Array.isArray(m.content) ? m.content : [];
			const responseId = m.id ?? entry.uuid ?? "";
			let msg = byResponse.get(responseId);
			const parts: AssistantMessage["content"] = [];
			for (const b of blocks) {
				if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
				else if (b.type === "thinking" && b.thinking) parts.push({ type: "thinking", thinking: b.thinking });
				else if (b.type === "tool_use") {
					const name = lhToolName(b.name);
					if (name && b.id) {
						callNames.set(b.id, name);
						callArgs.set(b.id, b.input ?? {});
						parts.push({ type: "toolCall", id: b.id, name, arguments: (b.input ?? {}) as never });
					}
				}
			}
			if (posed && !parts.some((p) => p.type === "toolCall" && isQuestionTool(p.name))) continue;
			if (!msg) {
				if (parts.length === 0) continue;
				msg = {
					id: `msg_cc_${responseId}`,
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "claude-code",
					model: m.model ?? "claude-code",
					usage: usageOf(m.usage),
					stopReason: stopReason(m.stop_reason),
					timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
				};
				byResponse.set(responseId, msg);
				messages.push(msg);
			}
			msg.content.push(...parts);
			msg.usage = usageOf(m.usage);
			msg.stopReason = stopReason(m.stop_reason);
			last = msg;
			continue;
		}

		if (entry.type === "user" && Array.isArray(entry.message?.content)) {
			for (const b of entry.message!.content as CcBlock[]) {
				if (b.type !== "tool_result" || !b.tool_use_id) continue;
				const name = callNames.get(b.tool_use_id);
				if (!name) continue; // a built-in tool's result
				// A posed question's "posed" result is scaffolding: the record ends at
				// the unanswered call (the dock shows it) until the learner's answer —
				// written by the answer path — becomes the call's result. A refused
				// question (invalid input) keeps its error result, as under pi.
				if (isQuestionTool(name) && b.is_error !== true) {
					answered.add(b.tool_use_id);
					posed = true;
					continue;
				}
				answered.add(b.tool_use_id);
				const text = toolResultText(b.content);
				const stored = lookupToolResult(chatId, name, callArgs.get(b.tool_use_id), text);
				const result: LhMessage & ToolResultMessage = {
					id: `res_cc_${b.tool_use_id}`,
					role: "toolResult",
					toolCallId: b.tool_use_id,
					toolName: name,
					// LearnHarness's own result text where it differs from what Claude
					// Code was told (a posed problem's "end your turn now").
					content: [{ type: "text", text: stored?.text ?? text }],
					...(stored?.details !== undefined ? { details: stored.details as never } : {}),
					isError: b.is_error === true || stored?.isError === true,
					timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
				};
				messages.push(result);
				last = result;
				// A posed problem ends the practice turn, as a question does: what
				// Claude Code adds after it is dropped.
				if (name === "problem" && !result.isError) posed = true;
				// The probe→teach seam: the record carries the handoff marker right
				// after a successful probe_done, exactly where the pi engine's wake
				// would have put it (the UI draws its phase divider from it).
				if (name === "probe_done" && !result.isError && !messages.some((x) => x.id === `steer_probe_${chatId}`)) {
					messages.push(newHandoffMessage(chatId));
				}
			}
		}
	}

	const danglingCalls: Array<{ id: string; name: string }> = [];
	for (const [id, name] of callNames) if (!answered.has(id)) danglingCalls.push({ id, name });
	const openAssistantId = last && last.role === "assistant" ? last.id : null;
	// Drop assistant messages that ended up empty (only built-in tool calls).
	return {
		messages: messages.filter((m) => m.role !== "assistant" || (m as AssistantMessage).content.length > 0),
		openAssistantId,
		danglingCalls,
		inMaintenance,
		prompts,
	};
}
