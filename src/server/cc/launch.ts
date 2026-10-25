import { courseBrief, isoDay, isTopic, mockBrief, topicBrief } from "../../core/courses.ts";
import { blockRoot, getBlock, getCourse, writeBackEnabled, writeBackFiles } from "../../store/courses.ts";
import { stores } from "../stores.ts";
import { composeClaudeCodeInstructions, composeCourseSetupInstructions, composeImportWorkerInstructions } from "./prompt.ts";
import { isImportWorkerId, isSetupId, readSetup } from "./setups.ts";

/**
 * What a Claude Code session launches with: its system prompt and the extra
 * folders it may read. A lesson's prompt depends on its kind (teach or
 * practice) and its course; a course-reading run gets its own prompt.
 * Recomposed on every launch, so a resumed session picks up today's week.
 */

export interface LaunchSpec {
	prompt: string;
	addDirs: string[];
	/** Existing files the session may edit (write-back, opt-in per course). */
	editFiles?: string[];
}

export function launchSpecFor(chatId: string): LaunchSpec {
	const today = isoDay();
	if (isImportWorkerId(chatId)) return { prompt: composeImportWorkerInstructions(), addDirs: [] };
	if (isSetupId(chatId)) {
		const setup = readSetup(chatId);
		if (!setup) throw new Error(`No course-reading run is registered for ${chatId}`);
		return {
			prompt: composeCourseSetupInstructions(setup.folder, setup.root, today),
			addDirs: [setup.folder, ...(setup.root ? [setup.root] : [])],
		};
	}
	const record = stores.chatStore.getChat(chatId);
	const prompt = composeClaudeCodeInstructions(record?.kind === "practice" ? "practice" : "teach");
	const course = record?.course ? getCourse(record.course.id) : null;
	if (!course) return { prompt, addDirs: [] };
	// A topic (Courses & Topics): its goal, its folder if it has one.
	if (isTopic(course)) return { prompt: `${prompt}\n\n---\n\n${topicBrief(course)}`, addDirs: course.folder ? [course.folder] : [] };
	const block = getBlock();
	const root = block ? blockRoot(block) : null;
	// Write-back (opt-in): never in a mock exam.
	const editFiles = writeBackEnabled(course.id) && !record?.mock ? writeBackFiles(course) : [];
	const mock = record?.mock ? `\n\n---\n\n${mockBrief(record.mock, course.assessments.find((a) => a.name === record.mock!.assessment))}` : "";
	return {
		prompt: `${prompt}\n\n---\n\n${courseBrief(course, today, root, editFiles)}${mock}`,
		addDirs: [course.folder, ...(root ? [root] : [])],
		...(editFiles.length > 0 ? { editFiles } : {}),
	};
}
