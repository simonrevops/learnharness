import { coverageOf } from "../../core/coverage.ts";
import { stores } from "../stores.ts";
import { beginTurn, endTurn } from "../turn-liveness.ts";
import { extraction } from "../chat-handler.ts";
import { extractionStatuses } from "../../agent/subagents/extraction.ts";
import { MAINTENANCE_PREFIX } from "./env.ts";
import { deliver, liveProcess, sessionRecordFor, CcNotReadyError } from "./session.ts";
import { beginStages, finishStages } from "./stage.ts";
import { getCourse, writeBackEnabled, writeBackFiles } from "../../store/courses.ts";

/**
 * "Update the graph" for a lesson (the session's Extract action). The
 * pipeline starts and posts its stage jobs; Claude Code is asked — with a
 * maintenance prompt the lesson record never shows — to work them through
 * the graph-extractor subagent. The chat's turn lock is held for the whole
 * update, so the learner can't type into a busy session meanwhile.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startGraphUpdate(chatId: string): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (extractionStatuses().some((r) => r.kind === "chat" && r.chatId === chatId)) {
		return Response.json({ error: "A graph update is already running for this session" }, { status: 409 });
	}
	if (coverageOf(record.messages, stores.graphStore.readCoverage(), chatId).uncovered.length === 0) {
		return Response.json({ started: false, reason: "nothing new to add" }, { status: 200 });
	}
	if (!beginTurn(chatId)) {
		return Response.json({ error: "The lesson is mid-turn — try again when the teacher has finished" }, { status: 409 });
	}
	beginStages(chatId);
	const run = extraction
		.runExtraction(chatId)
		.then((s) => finishStages(chatId, `Added ${s.nodes} node(s) and ${s.chains ?? 0} chain(s).`))
		.catch((err: unknown) => finishStages(chatId, `The update failed: ${err instanceof Error ? err.message : String(err)}`));
	// Write-back (opt-in, stage 4): the same maintenance turn keeps his
	// progress files current.
	const course = record.course && writeBackEnabled(record.course.id) && !record.mock ? getCourse(record.course.id) : null;
	const files = course ? writeBackFiles(course) : [];
	const writeBack =
		files.length > 0
			? ` After that, update his progress files (${files.map((f) => `\`${f}\``).join(", ")}) from this lesson, the way your instructions describe, and mention it in the same one line.`
			: "";
	try {
		await deliver(
			chatId,
			record.title ?? "Lesson",
			`${MAINTENANCE_PREFIX} Update the knowledge graph now: run the graph-extractor agent (Agent tool, subagent_type "graph-extractor") and wait until it reports DONE. Then reply with its one-line summary only.${writeBack}`,
		);
	} catch (err) {
		finishStages(chatId, "Claude Code could not be reached.");
		endTurn(chatId);
		const message = err instanceof CcNotReadyError ? err.message : "Could not reach Claude Code";
		return Response.json({ error: message }, { status: 503 });
	}
	// Release the lesson once the pipeline has settled and Claude Code is idle.
	void (async () => {
		await run;
		const id = sessionRecordFor(chatId).ccSessionId;
		for (let i = 0; i < 600; i++) {
			const p = liveProcess(id);
			if (!p || p.status !== "busy") break;
			await sleep(500);
		}
		endTurn(chatId);
	})();
	return Response.json({ started: true }, { status: 202 });
}

