import path from "node:path";
import {
	blockWeek,
	courseIdFromFolder,
	currentWeek,
	isoDay,
	nextAssessment,
	suggestNext,
	type BlockOverview,
	type Course,
	type CourseCard,
	type SessionCourse,
} from "../core/courses.ts";
import { blockFolders, blockRoot, getBlock, getCourse, listCourses } from "../store/courses.ts";
import { readSetup, setupIdFor } from "./cc/setups.ts";
import { stores } from "./stores.ts";

/**
 * The block overview the home screen draws (docs/blocks-and-courses.md
 * decision 9): one entry per course folder — read or not yet — with the
 * week, the next assessment, this week's sessions and the suggested step.
 */

/** A run counts as reading for 15 minutes after it was asked, until its
 *  course lands. */
const READ_WINDOW_MS = 15 * 60_000;

export function blockOverview(now: Date = new Date()): BlockOverview {
	const today = isoDay(now);
	const block = getBlock();
	if (!block) return { block: null, today, week: { week: null, of: 0 }, cards: [] };
	const chats = stores.chatStore.listChats();
	const cards: CourseCard[] = blockFolders(block).map((folder) => {
		const courseId = courseIdFromFolder(path.basename(folder));
		const course = getCourse(courseId);
		const setup = readSetup(setupIdFor(courseId));
		const reading =
			setup !== null &&
			!setup.error &&
			now.getTime() - Date.parse(setup.requestedAt) < READ_WINDOW_MS &&
			(!course || course.draftedAt < setup.requestedAt);
		const cw = course ? currentWeek(course, today) : null;
		const mine = chats.filter((c) => c.course?.id === courseId && cw !== null && c.course.week === cw.week);
		const lessonsThisWeek = mine.filter((c) => c.kind !== "practice").length;
		return {
			folder,
			folderName: path.basename(folder),
			courseId,
			course,
			reading,
			...(setup?.error ? { readError: setup.error } : {}),
			currentWeek: cw,
			next: course ? nextAssessment(course, today) : null,
			lessonsThisWeek,
			practiceThisWeek: mine.length - lessonsThisWeek,
			suggestion: course ? suggestNext(course, today, lessonsThisWeek) : null,
		};
	});
	const courses = cards.map((c) => c.course).filter((c): c is Course => c !== null);
	return { block: { ...block, root: blockRoot(block) }, today, week: blockWeek(courses, today), cards };
}

/** The course link a new session carries: the course and its current week. */
export function sessionCourseFor(courseId: string, now: Date = new Date()): SessionCourse | undefined {
	const course = getCourse(courseId);
	if (!course) return undefined;
	return { id: course.id, name: course.name, week: currentWeek(course, isoDay(now))?.week ?? null };
}

export { listCourses };
