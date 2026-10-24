import fs from "node:fs";
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
import { blockFolders, blockRoot, getBlock, getCourse, listCourses, notesImportedAt, recordNotesImport, writeBackEnabled, writeBackFiles } from "../store/courses.ts";
import { readSetup, setupIdFor } from "./cc/setups.ts";
import { importStatus, importViaClaudeCode, ImportBusyError } from "./cc/notes-import.ts";
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
			importing: (() => {
				const st = importStatus(`course-${courseId}`);
				return st?.running ? { done: st.done, total: st.total } : null;
			})(),
			notesImportedAt: notesImportedAt(courseId),
			writeBack: writeBackEnabled(courseId),
			graphPoints: course ? courseNodes(courseId).map((n) => ({ id: n.id, name: n.name, statement: n.statement })) : [],
			writeBackFiles: course ? writeBackFiles(course).map((f) => path.relative(course.folder, f)) : [],
		};
	});
	const courses = cards.map((c) => c.course).filter((c): c is Course => c !== null);
	return { block: { ...block, root: blockRoot(block) }, today, week: blockWeek(courses, today), cards };
}

/** The graph's propositions that belong to a course (stage 3): those that
 *  came up in the course's sessions or in notes imported from its folder.
 *  Newest first. The graph stays one graph — this is a lens on it. */
export function courseNodes(courseId: string) {
	const course = getCourse(courseId);
	if (!course) return [];
	const chats = new Set(stores.chatStore.listChats().filter((c) => c.course?.id === courseId).map((c) => c.id));
	const prefix = course.folder.endsWith(path.sep) ? course.folder : course.folder + path.sep;
	const sources = new Set(stores.graphStore.readSources().filter((src) => src.filePath.startsWith(prefix)).map((src) => src.id));
	return stores.graphStore
		.readNodes()
		.filter((n) => n.provenance.some((p) => chats.has(p.chatId) || sources.has(p.chatId)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The course link a new session carries: the course and its current week. */
export function sessionCourseFor(courseId: string, now: Date = new Date()): SessionCourse | undefined {
	const course = getCourse(courseId);
	if (!course) return undefined;
	return { id: course.id, name: course.name, week: currentWeek(course, isoDay(now))?.week ?? null };
}

export { listCourses };

const NOTE_EXTENSIONS = new Set([".md", ".txt", ".tex", ".qmd", ".rmd", ".r"]);
const NOTE_DIRS = ["Notes", path.join("Solutions", "Mine")];
const MAX_NOTE_BYTES = 200_000;

function walk(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (NOTE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(p);
	}
}

/** The learner's own notes for a course (stage 3): text files under the
 *  course's Notes and Solutions/Mine folders, plus the block root's shared
 *  notes. Lecture PDFs and textbooks stay out — they are the course's
 *  material, not what he has worked through. */
export function courseNotesFiles(course: Course, root: string | null): string[] {
	const out: string[] = [];
	for (const d of NOTE_DIRS) walk(path.join(course.folder, d), out);
	if (root) walk(path.join(root, "_shared"), out);
	return out.filter((f) => {
		try {
			return fs.statSync(f).size <= MAX_NOTE_BYTES;
		} catch {
			return false;
		}
	});
}

/** Import a course's notes into the graph through its Claude Code worker.
 *  Returns at once; the panel follows progress through blockOverview. */
export function startCourseImport(courseId: string): { started: boolean; files: number; error?: string } {
	const course = getCourse(courseId);
	if (!course) return { started: false, files: 0, error: "Unknown course" };
	const block = getBlock();
	const files = courseNotesFiles(course, block ? blockRoot(block) : null);
	if (files.length === 0) return { started: false, files: 0, error: "No notes found under Notes/ or Solutions/Mine/" };
	if (importStatus(`course-${courseId}`)?.running) return { started: false, files: files.length, error: "Already importing" };
	const notes = files.map((filePath) => ({ filePath, text: fs.readFileSync(filePath, "utf-8") }));
	void importViaClaudeCode(`course-${courseId}`, `Import notes · ${course.name}`, notes)
		.then(() => recordNotesImport(courseId, new Date().toISOString()))
		.catch((err: unknown) => {
			if (!(err instanceof ImportBusyError)) console.error(`[courses] notes import for ${courseId} failed:`, err);
		});
	return { started: true, files: files.length };
}
