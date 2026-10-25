import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	blockWeek,
	courseIdFromFolder,
	currentWeek,
	isoDay,
	isTopic,
	nextAssessment,
	topicIdFromName,
	suggestNext,
	type BlockOverview,
	type Course,
	type CourseCard,
	type LibraryEntry,
	type LibraryOverview,
	type SessionCourse,
} from "../core/courses.ts";
import {
	blockFolders,
	blockRoot,
	expandPath,
	getBlock,
	getCourse,
	listCourses,
	notesImportedAt,
	recordNotesImport,
	saveCourse,
	writeBackEnabled,
	writeBackFiles,
} from "../store/courses.ts";
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
	const sources = new Set(
		course.folder ? stores.graphStore.readSources().filter((src) => src.filePath.startsWith(prefix)).map((src) => src.id) : [],
	);
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

// ─── Courses & Topics (fork) ─────────────────────────────────────────────────

/**
 * The Courses & Topics page: this block's course cards (the home panel's
 * overview), every earlier course kept in data/courses, and the topics.
 * Earlier courses are the drafted courses whose folder is no longer one of
 * the block's — their records and points stay when a block ends.
 */
export function libraryOverview(now: Date = new Date()): LibraryOverview {
	const block = blockOverview(now);
	const current = new Set(block.cards.map((c) => c.courseId));
	const chats = stores.chatStore.listChats();
	const entry = (c: Course): LibraryEntry => {
		const mine = chats.filter((s) => s.course?.id === c.id);
		const practice = mine.filter((s) => s.kind === "practice").length;
		return {
			id: c.id,
			kind: isTopic(c) ? "topic" : "course",
			name: c.name,
			folder: c.folder,
			summary: c.summary,
			lessons: mine.length - practice,
			practice,
			lastActive: mine.reduce<string | null>((m, s) => (m === null || s.updatedAt > m ? s.updatedAt : m), null),
			assessments: { total: c.assessments.length, done: c.assessments.filter((a) => a.done).length },
			graphPoints: courseNodes(c.id).map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
		};
	};
	const all = listCourses();
	return {
		block,
		past: all.filter((c) => !isTopic(c) && !current.has(c.id)).map(entry),
		topics: all.filter(isTopic).map(entry),
	};
}

export class LibraryError extends Error {
	override name = "LibraryError";
}

/** A folder name a learner typed: one path segment, visible, not too long. */
function cleanFolderName(name: string): string {
	const n = name.trim().replace(/\s+/g, " ");
	if (!n) throw new LibraryError("Give the course a name.");
	if (n.length > 80) throw new LibraryError("Keep the name under 80 characters.");
	if (/[/\\:]/.test(n) || n.startsWith(".") || n.startsWith("_")) {
		throw new LibraryError("The name can't contain / \\ or :, or start with . or _.");
	}
	return n;
}

/** Open a folder in Finder (macOS). Best effort: the page says where it is. */
function revealFolder(folder: string): void {
	if (process.platform !== "darwin" || process.env.NODE_ENV === "test") return;
	execFile("open", [folder], (err) => {
		if (err) console.error(`[courses] could not open ${folder} in Finder:`, err.message);
	});
}

/**
 * Add a course: a new, empty folder in the block, opened in Finder so the
 * learner can drop the course's files in. The block panel then shows it
 * unread, with "Read course". The one thing LearnHarness creates outside
 * its own data.
 */
export function createCourseFolder(name: string): { folder: string } {
	const block = getBlock();
	if (!block) throw new LibraryError("Choose the block folder first (on the home screen).");
	const folder = path.join(block.folder, cleanFolderName(name));
	if (fs.existsSync(folder)) throw new LibraryError(`${folder} already exists — it is already one of the block's courses.`);
	fs.mkdirSync(folder);
	revealFolder(folder);
	return { folder };
}

/** Create a topic: a name, a goal and an optional folder it may read. */
export function createTopic(input: { name: string; goal: string; folder?: string }): Course {
	const name = input.name.trim().replace(/\s+/g, " ");
	const goal = input.goal.trim();
	if (!name) throw new LibraryError("Give the topic a name.");
	if (name.length > 80) throw new LibraryError("Keep the name under 80 characters.");
	if (!goal) throw new LibraryError("Say in a line what you want to be able to do.");
	let folder = "";
	if (input.folder?.trim()) {
		folder = expandPath(input.folder);
		if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new LibraryError(`No folder at ${folder}.`);
	}
	const id = topicIdFromName(name);
	if (getCourse(id)) throw new LibraryError(`There is already a topic called ${getCourse(id)!.name}.`);
	const topic: Course = {
		id,
		kind: "topic",
		name,
		folder,
		summary: goal,
		weeks: [],
		assessments: [],
		readFirst: [],
		draftedAt: new Date().toISOString(),
	};
	saveCourse(topic);
	return topic;
}

/** Link a session to a course or topic (null unlinks). The week is the
 *  course's week when the session started, as if it had been started from
 *  the course card. */
export function linkSession(chatId: string, courseId: string | null): SessionCourse | null {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) throw new LibraryError("No such session.");
	if (courseId === null) {
		stores.chatStore.setCourse(chatId, null);
		return null;
	}
	const course = getCourse(courseId);
	if (!course) throw new LibraryError("No such course or topic.");
	const link: SessionCourse = {
		id: course.id,
		name: course.name,
		week: currentWeek(course, isoDay(new Date(chat.createdAt)))?.week ?? null,
	};
	stores.chatStore.setCourse(chatId, link);
	return link;
}

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
