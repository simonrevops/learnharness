import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { SubmitAgentSpec } from "../../agent/subagents/submit-agent.ts";
import { auditorGraphTools } from "../../agent/tools/graph.ts";
import { stores } from "../stores.ts";
import type { McpCallResult, McpToolDef } from "./tools.ts";

/**
 * THE GRAPH UPDATE, RUN BY CLAUDE CODE. LearnHarness's extraction pipeline
 * stays exactly as it is — coverage, batching, the source digest, serialized
 * audits, the deterministic merger, layout settling. Only its two model
 * stages change hands: where the pi engine would run a submit-agent loop
 * (extractor, auditor), the pipeline posts the stage as a JOB, and the
 * chat's Claude Code session works it through a `graph-extractor` subagent:
 *
 *   graph_next_job → the stage's own instructions + input + submit schema
 *   graph_find / graph_list_* → the auditor's own exploration tools
 *   graph_submit → the stage's own heal → schema check → fill → validate;
 *                  a problem returns as an error the subagent fixes and
 *                  re-submits, exactly like the pi loop's error-back
 *
 * The subagent keeps the work out of the lesson's context.
 */

interface StageJob {
	id: string;
	spec: SubmitAgentSpec<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

interface ChatStages {
	queue: StageJob[];
	/** The pipeline run finished: the subagent can stop. */
	done: boolean;
	summary?: string;
	waiters: Set<() => void>;
}

const g = globalThis as { __lhCcStages?: Map<string, ChatStages>; __lhCcStageRoutes?: Map<string, string> };
const stages = (g.__lhCcStages ??= new Map());
/** Source id → the session that works its stages (notes imports have no
 *  lesson session of their own). */
const routes = (g.__lhCcStageRoutes ??= new Map());

export function routeStages(sourceId: string, ownerId: string): void {
	routes.set(sourceId, ownerId);
}

export function unrouteStages(sourceId: string): void {
	routes.delete(sourceId);
}

function chatStages(chatId: string): ChatStages {
	let s = stages.get(chatId);
	if (!s) {
		s = { queue: [], done: true, waiters: new Set() };
		stages.set(chatId, s);
	}
	return s;
}

function wake(s: ChatStages): void {
	for (const w of [...s.waiters]) w();
}

/** Mark a graph update as starting/finished for a chat (the route calls this
 *  around runExtraction). */
export function beginStages(chatId: string): void {
	const s = chatStages(chatId);
	s.done = false;
	s.summary = undefined;
}

export function finishStages(chatId: string, summary: string): void {
	const s = chatStages(chatId);
	s.done = true;
	s.summary = summary;
	for (const job of s.queue.splice(0)) job.reject(new Error("graph update finished"));
	wake(s);
}

/** The pipeline's submit runner under this engine: post the stage, await the
 *  subagent's accepted submit. The source id is the chat id for chat runs. */
export function claudeCodeSubmitRunner<T>(spec: SubmitAgentSpec<T>): Promise<T> {
	const chatId = spec.chatId ?? "";
	// A notes import's stages go to the Claude Code session working it.
	const s = chatStages(routes.get(chatId) ?? chatId);
	return new Promise<T>((resolve, reject) => {
		// Nobody is working this update (it finished, or Claude Code could not
		// be reached): fail fast instead of waiting forever.
		if (s.done) {
			reject(new Error("No Claude Code session is working this graph update"));
			return;
		}
		const job: StageJob = {
			id: `job_${crypto.randomUUID().slice(0, 8)}`,
			spec: spec as SubmitAgentSpec<unknown>,
			resolve: resolve as (v: unknown) => void,
			reject,
		};
		s.queue.push(job);
		spec.signal?.addEventListener("abort", () => {
			const i = s.queue.indexOf(job);
			if (i >= 0) s.queue.splice(i, 1);
			const err = new Error("aborted");
			err.name = "AbortError";
			reject(err);
		});
		wake(s);
	});
}

const STAGE_TOOLS = ["graph_next_job", "graph_submit", "graph_find", "graph_list_sessions", "graph_list_propositions"];

export function isStageTool(name: string): boolean {
	return STAGE_TOOLS.includes(name);
}

function explore(): Record<string, AgentTool<any>> {
	return auditorGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore });
}

export function stageToolList(): McpToolDef[] {
	const ex = explore();
	return [
		{
			name: "graph_next_job",
			description:
				"Graph update: fetch the next extraction job (or learn that the update is finished). Waits up to 20 seconds for a job to appear.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "graph_submit",
			description:
				"Graph update: submit the deliverable for the current job. `payload` must match the job's submit schema. An error result lists what to fix — fix it and submit again.",
			inputSchema: {
				type: "object",
				properties: { job_id: { type: "string" }, payload: { type: "object" } },
				required: ["job_id", "payload"],
			},
		},
		...(["find", "list_sessions", "list_propositions"] as const).map((n) => ({
			name: `graph_${n}`,
			description: `Graph update (linking jobs): ${ex[n]!.description}`,
			inputSchema: JSON.parse(JSON.stringify(ex[n]!.parameters)),
		})),
	];
}

function text(t: string, isError = false): McpCallResult {
	return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function describeJob(job: StageJob): string {
	const { spec } = job;
	const tools = spec.extraTools ? Object.keys(spec.extraTools) : [];
	return [
		`JOB ${job.id} — stage: ${spec.role}`,
		`Submit with graph_submit { "job_id": "${job.id}", "payload": <${spec.toolName} payload> }.`,
		tools.length > 0
			? `Exploration tools for this job: ${tools.map((t) => `${t} → call graph_${t}`).join(", ")}.`
			: "This job has no exploration tools: read the input and submit.",
		"",
		"=== STAGE INSTRUCTIONS (follow exactly) ===",
		spec.systemPrompt,
		"",
		`=== SUBMIT SCHEMA (${spec.toolName}: ${spec.toolDescription}) ===`,
		JSON.stringify(spec.parameters),
		"",
		"=== INPUT ===",
		spec.prompt,
	].join("\n");
}

async function nextJob(chatId: string): Promise<McpCallResult> {
	const s = chatStages(chatId);
	const until = Date.now() + 20_000;
	while (s.queue.length === 0 && !s.done && Date.now() < until) {
		await new Promise<void>((r) => {
			const w = () => {
				s.waiters.delete(w);
				r();
			};
			s.waiters.add(w);
			setTimeout(w, Math.max(0, until - Date.now()));
		});
	}
	if (s.queue.length > 0) return text(describeJob(s.queue[0]!));
	if (s.done) return text(`DONE — the graph update is finished. ${s.summary ?? ""}`.trim());
	return text("No job yet — the pipeline is still working. Call graph_next_job again.");
}

function submit(chatId: string, args: { job_id?: string; payload?: unknown }): McpCallResult {
	const s = chatStages(chatId);
	const job = s.queue.find((j) => j.id === args.job_id);
	if (!job) return text(`No open job ${args.job_id}. Call graph_next_job.`, true);
	const { spec } = job;
	try {
		const healed = spec.prepareArguments ? spec.prepareArguments(args.payload) : args.payload;
		const valid = validateToolArguments(
			{ name: spec.toolName, description: spec.toolDescription, parameters: spec.parameters } as never,
			{ type: "toolCall", id: job.id, name: spec.toolName, arguments: healed as never },
		);
		const value = spec.fill(valid);
		const problem = spec.validate?.(value);
		if (problem) return text(`Rejected — fix and submit again:\n${problem}`, true);
		s.queue.splice(s.queue.indexOf(job), 1);
		job.resolve(value);
		return text("Accepted. Call graph_next_job for the next job.");
	} catch (err) {
		return text(`Rejected — fix and submit again:\n${err instanceof Error ? err.message : String(err)}`, true);
	}
}

export async function callStageTool(chatId: string, name: string, args: unknown): Promise<McpCallResult> {
	if (name === "graph_next_job") return nextJob(chatId);
	if (name === "graph_submit") return submit(chatId, (args ?? {}) as { job_id?: string; payload?: unknown });
	const tool = explore()[name.slice("graph_".length)];
	if (!tool) return text(`Unknown tool: ${name}`, true);
	try {
		const valid = validateToolArguments(tool as never, { type: "toolCall", id: "x", name: tool.name, arguments: args as never });
		const out = await tool.execute(`cc_${crypto.randomUUID()}`, valid as never, undefined);
		return text(out.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
	} catch (err) {
		return text(err instanceof Error ? err.message : String(err), true);
	}
}

/** The subagent Claude Code runs for a graph update (written into the
 *  workspace's .claude/agents). */
export const GRAPH_EXTRACTOR_AGENT = `---
name: graph-extractor
description: Updates the LearnHarness knowledge graph from the lesson. Use only when a LearnHarness maintenance prompt asks for a graph update.
tools: mcp__lh__graph_next_job, mcp__lh__graph_submit, mcp__lh__graph_find, mcp__lh__graph_list_sessions, mcp__lh__graph_list_propositions
model: inherit
---

You work the LearnHarness knowledge-graph update, one job at a time:

1. Call mcp__lh__graph_next_job.
2. If it says DONE, stop and reply with its one-line summary.
3. If it says no job yet, call it again.
4. Otherwise it gives you a JOB: its stage instructions, its submit schema, and its input. Do exactly what the stage instructions say — they are the whole brief; the job is either EXTRACTING propositions and reasoning chains from a lesson passage, or LINKING proposed propositions to the existing graph (use the graph_* exploration tools the job names).
5. Submit the deliverable with mcp__lh__graph_submit { "job_id": ..., "payload": ... }. If it is rejected, fix exactly what the message says and submit again.
6. Go back to step 1.

Never skip a job and never stop before DONE.
`;
