import { notesSourceId } from "../../agent/subagents/extraction.ts";
import type { EmissionStats } from "../../core/contracts.ts";
import { extraction } from "../chat-handler.ts";
import { deliver } from "./session.ts";
import { beginStages, finishStages, routeStages, unrouteStages } from "./stage.ts";
import { IMPORT_PREFIX } from "./setups.ts";

/**
 * Notes imports under the Claude Code engine (docs/blocks-and-courses.md,
 * stage 3). A notes file has no lesson session to work its extraction
 * stages, so an import gets a Claude Code worker session of its own
 * (`import_<key>`, a Terminal tab like a course-reading run): the pipeline
 * runs unchanged, its stage jobs are routed to the worker, and the worker's
 * graph-extractor subagent works them until the import is done.
 */

export interface NotesFile {
	filePath: string;
	text: string;
}

export interface NotesFileResult {
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
}

export interface ImportStatus {
	key: string;
	running: boolean;
	total: number;
	done: number;
	startedAt: string;
	finishedAt?: string;
	nodes: number;
	chains: number;
	failed: number;
	error?: string;
}

const g = globalThis as { __lhCcImports?: Map<string, ImportStatus> };
const statuses = (g.__lhCcImports ??= new Map());

export function importStatus(key: string): ImportStatus | null {
	return statuses.get(key) ?? null;
}

export class ImportBusyError extends Error {
	override name = "ImportBusyError";
}

/** Import files into the graph through the key's Claude Code worker, one
 *  file at a time. Resolves when every file has been tried. */
export async function importViaClaudeCode(key: string, title: string, files: readonly NotesFile[]): Promise<NotesFileResult[]> {
	if (statuses.get(key)?.running) throw new ImportBusyError("An import is already running for these notes.");
	const workerId = `${IMPORT_PREFIX}${key}`;
	const status: ImportStatus = {
		key,
		running: true,
		total: files.length,
		done: 0,
		startedAt: new Date().toISOString(),
		nodes: 0,
		chains: 0,
		failed: 0,
	};
	statuses.set(key, status);
	const results: NotesFileResult[] = [];
	beginStages(workerId);
	for (const f of files) routeStages(notesSourceId(f.filePath), workerId);
	let unreachable: string | null = null;
	void deliver(
		workerId,
		title,
		'Import into the knowledge graph now: run the graph-extractor agent (Agent tool, subagent_type "graph-extractor") and wait until it reports DONE. Then reply with its one-line summary only.',
	).catch((err: unknown) => {
		unreachable = err instanceof Error ? err.message : String(err);
		finishStages(workerId, "Claude Code could not be reached.");
	});
	try {
		for (const f of files) {
			if (unreachable) {
				results.push({ filePath: f.filePath, ok: false, error: unreachable });
				continue;
			}
			try {
				const stats = await extraction.importNotes(f);
				status.nodes += stats.nodes;
				status.chains += stats.chains ?? 0;
				results.push({ filePath: f.filePath, ok: true, stats });
			} catch (err) {
				status.failed++;
				results.push({ filePath: f.filePath, ok: false, error: err instanceof Error ? err.message : String(err) });
			}
			status.done++;
		}
	} finally {
		finishStages(workerId, `Imported ${status.done - status.failed} of ${files.length} file(s): ${status.nodes} node(s), ${status.chains} chain(s).`);
		for (const f of files) unrouteStages(notesSourceId(f.filePath));
		status.running = false;
		status.finishedAt = new Date().toISOString();
		if (unreachable) status.error = unreachable;
	}
	return results;
}
