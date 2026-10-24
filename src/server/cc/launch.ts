import { courseBrief, isoDay } from "../../core/courses.ts";
import { blockRoot, getBlock, getCourse } from "../../store/courses.ts";
import { stores } from "../stores.ts";
import { composeClaudeCodeInstructions, composeCourseSetupInstructions } from "./prompt.ts";
import { isSetupId, readSetup } from "./setups.ts";

/**
 * What a Claude Code session launches with: its system prompt and the extra
 * folders it may read. A lesson's prompt depends on its kind (teach or
 * practice) and its course; a course-reading run gets its own prompt.
 * Recomposed on every launch, so a resumed session picks up today's week.
 */

export interface LaunchSpec {
	prompt: string;
	addDirs: string[];
}

export function launchSpecFor(chatId: string): LaunchSpec {
	const today = isoDay();
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
	const block = getBlock();
	const root = block ? blockRoot(block) : null;
	return {
		prompt: `${prompt}\n\n---\n\n${courseBrief(course, today, root)}`,
		addDirs: [course.folder, ...(root ? [root] : [])],
	};
}
