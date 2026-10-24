import fs from "node:fs";
import path from "node:path";
import { CC_SESSIONS_DIR } from "./env.ts";

/**
 * The tool-result side channel. Claude Code's transcript keeps only the text a
 * tool returned; LearnHarness tool results also carry `details` the UI reads
 * (plan_init's full tree drives the plan window). The MCP call never learns
 * Claude Code's tool_use id, so results are keyed by tool name + canonical
 * arguments — the transcript's tool_use block carries the same arguments.
 */

interface StoredResult {
	name: string;
	key: string;
	text: string;
	details?: unknown;
	isError: boolean;
}

const g = globalThis as { __lhCcResults?: Map<string, StoredResult[]> };
const cache = (g.__lhCcResults ??= new Map());

function file(chatId: string): string {
	return path.join(CC_SESSIONS_DIR, `${chatId}.results.jsonl`);
}

/** Key-order-independent JSON, so the same arguments always key the same. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function load(chatId: string): StoredResult[] {
	const hit = cache.get(chatId);
	if (hit) return hit;
	const rows: StoredResult[] = [];
	try {
		for (const line of fs.readFileSync(file(chatId), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as StoredResult);
			} catch {
				/* skip */
			}
		}
	} catch {
		/* none yet */
	}
	cache.set(chatId, rows);
	return rows;
}

export function storeToolResult(chatId: string, name: string, args: unknown, text: string, details: unknown, isError: boolean): void {
	const row: StoredResult = { name, key: canonicalJson(args), text, isError, ...(details !== undefined ? { details } : {}) };
	load(chatId).push(row);
	fs.mkdirSync(CC_SESSIONS_DIR, { recursive: true });
	fs.appendFileSync(file(chatId), `${JSON.stringify(row)}\n`);
}

export function hasToolSuccess(chatId: string, name: string): boolean {
	return load(chatId).some((r) => r.name === name && !r.isError);
}

/** The latest stored result for this call; prefers an exact text match (a
 *  retried call with identical arguments can have produced two results). */
export function lookupToolResult(chatId: string, name: string, args: unknown, text: string): StoredResult | undefined {
	const key = canonicalJson(args ?? {});
	const rows = load(chatId).filter((r) => r.name === name && r.key === key);
	return rows.findLast((r) => r.text === text) ?? rows.at(-1);
}
