import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createProberTools, createTeacherTools, quizMechanics } from "../../agent/tools.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";

/** Learner-answered tools (the free-recall pair included). */
export function isQuestionTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name) || name === "recall" || name === "explain";
}
import { hasProbeDone } from "../../core/native-messages.ts";
import { graphToolsEnabled } from "../../core/settings-resolution.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { hasToolSuccess, storeToolResult } from "./results.ts";
import { liveMessages } from "./live.ts";
import { stageToolList, callStageTool, isStageTool } from "./stage.ts";
import { callCourseTool, courseToolList } from "./course-setup.ts";
import { concludeTool, problemTool, type PracticeGate } from "../../agent/tools/practice.ts";
import { proberGraphTools } from "../../agent/tools/graph.ts";
import { healToolRecord } from "../../agent/tools/heal.ts";
import { activeProblemOf, type LhMessage } from "../../core/native-messages.ts";
import { isSetupId } from "./setups.ts";

/**
 * LearnHarness's own tools, served to Claude Code through the MCP proxy
 * (scripts/cc-mcp.mjs → /api/cc/tools*). The tools are the pi engine's
 * AgentTools, built over the same stores and run through the same
 * prepare → validate → execute steps pi's loop runs — nothing is
 * reimplemented.
 *
 * Question tools keep the pi engine's protocol: a valid question is POSED
 * (the call returns at once and tells Claude Code to end its turn), the
 * record ends at the unanswered call so the dock shows it, and the learner's
 * answer opens the next turn — agent.ts types it into the session. (A tool
 * call that waits for the answer instead is not an option: Claude Code moves
 * any MCP call still running after two minutes into the background.)
 */

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
}

export interface McpCallResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

type Phase = "probe" | "teach" | "practice";

const PROBE_TOOLS = ["probe", "recall", "ask_user_question", "probe_done", "list_sessions", "list_propositions"];
const TEACH_TOOLS = ["quiz", "explain", "ask_user_question", "plan_init"];

const noop = () => undefined;

/** The practice gate, per chat, across calls (the pi engine keeps it per
 *  turn in a closure; here each MCP call rebuilds the registry, and the record
 *  lags the transcript, so the gate lives server-side). Reseeded from the
 *  record at every turn start (agent.ts), which carries any dismissal. */
const gates = ((globalThis as { __lhCcPracticeGates?: Map<string, PracticeGate> }).__lhCcPracticeGates ??= new Map());

export function reseedPracticeGate(chatId: string, messages: readonly LhMessage[]): void {
	gates.set(chatId, { problemActive: activeProblemOf(messages) !== null });
}

function practiceGate(chatId: string): PracticeGate {
	let gate = gates.get(chatId);
	if (!gate) {
		const record = stores.chatStore.getChat(chatId);
		gate = { problemActive: record ? activeProblemOf(record.messages) !== null : false };
		gates.set(chatId, gate);
	}
	return gate;
}

/** A practice session's registry (docs/blocks-and-courses.md decision 10):
 *  the practice agent's own tools; the read and job tools are Claude Code's. */
function practiceRegistry(chatId: string): Map<string, { tool: AgentTool<any>; phases: Phase[] }> {
	const effective = effectiveSettings();
	const gate = practiceGate(chatId);
	const tools = healToolRecord({
		problem: problemTool(gate, () => stores.graphStore.readNodes()),
		conclude: concludeTool(gate),
		...(graphToolsEnabled(effective) ? proberGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore }) : {}),
	});
	const out = new Map<string, { tool: AgentTool<any>; phases: Phase[] }>();
	for (const name of ["problem", "conclude", "list_sessions", "list_propositions"]) {
		if (tools[name]) out.set(name, { tool: tools[name], phases: ["practice"] });
	}
	return out;
}

function isPractice(chatId: string): boolean {
	return stores.chatStore.getChat(chatId)?.kind === "practice";
}

/** The union registry for one chat: each tool tagged with the phase(s) it
 *  belongs to. Built per call — the tools read live settings and the record. */
function registry(chatId: string): Map<string, { tool: AgentTool<any>; phases: Phase[] }> {
	if (isPractice(chatId)) return practiceRegistry(chatId);
	const effective = effectiveSettings();
	const enabled = effective.agent.tools;
	const prober = createProberTools(
		{
			chatId,
			chatStore: stores.chatStore,
			// The probe→teach wake is the engine's job here (agent.ts delivers
			// the handoff once Claude Code ends its probe turn).
			deliver: noop,
			jobStore: stores.jobStore,
			spawn: noop,
			searchAvailable: () => false,
			...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
		},
		enabled,
	);
	const teacher = createTeacherTools(
		{ chatId, chatStore: stores.chatStore, jobStore: stores.jobStore, spawn: noop, searchAvailable: () => false },
		enabled,
	);
	const out = new Map<string, { tool: AgentTool<any>; phases: Phase[] }>();
	for (const name of PROBE_TOOLS) if (prober[name]) out.set(name, { tool: prober[name], phases: ["probe"] });
	for (const name of TEACH_TOOLS) {
		if (!teacher[name]) continue;
		const hit = out.get(name);
		if (hit) hit.phases.push("teach");
		else out.set(name, { tool: teacher[name], phases: ["teach"] });
	}
	return out;
}

/** probe_done's result reaches the record only once the transcript is read;
 *  the side channel knows the moment it succeeded. */
function phaseOf(chatId: string): Phase {
	if (isPractice(chatId)) return "practice";
	return hasProbeDone(liveMessages(chatId)) || hasToolSuccess(chatId, "probe_done") ? "teach" : "probe";
}

export function listTools(chatId: string): McpToolDef[] {
	if (isSetupId(chatId)) return courseToolList();
	const defs: McpToolDef[] = [];
	for (const [name, { tool, phases }] of registry(chatId)) {
		const tag =
			phases.length === 2 || phases[0] === "practice" ? "" : phases[0] === "probe" ? "[Probe phase only] " : "[Teach phase only] ";
		const description = tag + tool.description;
		defs.push({ name, description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) });
	}
	return [...defs, ...stageToolList()];
}

function text(t: string, isError = false): McpCallResult {
	return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

export type CallOutcome = { result: McpCallResult };

export async function callTool(chatId: string, name: string, args: unknown): Promise<CallOutcome> {
	if (isSetupId(chatId)) return { result: await callCourseTool(chatId, name, args) };
	if (isStageTool(name)) return { result: await callStageTool(chatId, name, args) };
	const entry = registry(chatId).get(name);
	if (!entry) return { result: text(`Unknown tool: ${name}`, true) };
	const phase = phaseOf(chatId);
	if (!entry.phases.includes(phase)) {
		return {
			result: text(
				phase === "probe"
					? `${name} belongs to the teaching phase — the probe is still running. Conclude it with probe_done first.`
					: `${name} belongs to the probe, which is over. Use the teaching tools (${quizMechanics(effectiveSettings().agent.tools) === "free" ? "explain" : "quiz"}, ask_user_question, plan_init).`,
				true,
			),
		};
	}
	const { tool } = entry;
	const toolCallId = `cc_${crypto.randomUUID()}`;
	let validated: unknown;
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
		validated = validateToolArguments(tool as never, { type: "toolCall", id: toolCallId, name, arguments: prepared as never });
	} catch (err) {
		return { result: text(err instanceof Error ? err.message : String(err), true) };
	}
	let out: Awaited<ReturnType<AgentTool<any>["execute"]>>;
	try {
		out = await tool.execute(toolCallId, validated as never, undefined);
	} catch (err) {
		return { result: text(err instanceof Error ? err.message : String(err), true) };
	}
	const resultText = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	const isError = (out as { isError?: boolean }).isError === true;
	if (name === "problem" && !isError) {
		// The record keeps LearnHarness's own "posed" result (the practice dock
		// keys on it); Claude Code is told to end its turn.
		storeToolResult(chatId, name, args, resultText, out.details, isError);
		return {
			result: text(
				"Problem posed — it is on the learner's screen now. End your turn now, writing nothing more: his thinking arrives as his next message.",
			),
		};
	}
	if (isQuestionTool(name) && !isError) {
		return {
			result: text(
				"Question posed — it is on the learner's screen now. End your turn now, writing nothing more: his graded answer arrives as his next message.",
			),
		};
	}
	storeToolResult(chatId, name, args, resultText, out.details, isError);
	return { result: text(resultText, isError) };
}
