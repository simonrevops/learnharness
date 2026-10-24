/**
 * Course + block store (fork, stage 2 — docs/blocks-and-courses.md): one
 * JSON file per course in data/courses/, the block config in
 * data/block.json. Same idioms as the chat store: sync fs, id-guarded
 * filenames, tab-indented JSON.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { BlockConfig, Course } from "../core/courses.ts";

const COURSES_DIR = path.join(PATHS.data, "courses");
const BLOCK_FILE = path.join(PATHS.data, "block.json");
/** What the learner marked done, per course — apart from the drafted course
 *  files, which a re-read overwrites. */
const PROGRESS_FILE = path.join(PATHS.data, "course-progress.json");

type Progress = Record<string, { done: string[]; notesImportedAt?: string; writeBack?: boolean }>;

function readProgress(): Progress {
	try {
		return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8")) as Progress;
	} catch {
		return {};
	}
}

export function setAssessmentDone(courseId: string, name: string, done: boolean): void {
	const p = readProgress();
	const set = new Set(p[courseId]?.done ?? []);
	if (done) set.add(name);
	else set.delete(name);
	p[courseId] = { ...p[courseId], done: [...set].sort() };
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, "\t"), "utf-8");
}

export function recordNotesImport(courseId: string, at: string): void {
	const p = readProgress();
	p[courseId] = { ...p[courseId], done: p[courseId]?.done ?? [], notesImportedAt: at };
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, "\t"), "utf-8");
}

/** The learner's opt-in: course sessions may update his own progress files
 *  (stage 4 — off unless he turns it on). */
export function setWriteBack(courseId: string, on: boolean): void {
	const p = readProgress();
	p[courseId] = { done: p[courseId]?.done ?? [], ...p[courseId], writeBack: on };
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, "\t"), "utf-8");
}

export function writeBackEnabled(courseId: string): boolean {
	return readProgress()[courseId]?.writeBack === true;
}

/** The files write-back may edit: the course's read-first files that sit
 *  inside its folder and exist (never anything outside it, never new files). */
export function writeBackFiles(course: Course): string[] {
	const prefix = course.folder.endsWith(path.sep) ? course.folder : course.folder + path.sep;
	return course.readFirst
		.map((f) => path.resolve(course.folder, f))
		.filter((f) => f.startsWith(prefix) && fs.existsSync(f));
}

export function notesImportedAt(courseId: string): string | null {
	return readProgress()[courseId]?.notesImportedAt ?? null;
}

function courseFile(id: string): string {
	if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(COURSES_DIR, `${id}.json`);
}

export function getCourse(id: string): Course | null {
	let course: Course;
	try {
		course = JSON.parse(fs.readFileSync(courseFile(id), "utf-8")) as Course;
	} catch {
		return null;
	}
	const done = new Set(readProgress()[id]?.done ?? []);
	return { ...course, assessments: course.assessments.map((a) => (done.has(a.name) ? { ...a, done: true } : a)) };
}

export function listCourses(): Course[] {
	try {
		return fs
			.readdirSync(COURSES_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getCourse(f.slice(0, -5)))
			.filter((c): c is Course => c !== null)
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

export function saveCourse(course: Course): void {
	fs.mkdirSync(COURSES_DIR, { recursive: true });
	const stored = { ...course, assessments: course.assessments.map(({ done: _done, ...a }) => a) };
	fs.writeFileSync(courseFile(course.id), JSON.stringify(stored, null, "\t"), "utf-8");
}

/** `~` and relative paths resolve against the home directory. */
export function expandPath(p: string): string {
	const t = p.trim();
	if (t === "~") return os.homedir();
	if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2));
	return path.resolve(os.homedir(), t);
}

export function getBlock(): BlockConfig | null {
	try {
		return JSON.parse(fs.readFileSync(BLOCK_FILE, "utf-8")) as BlockConfig;
	} catch {
		return null;
	}
}

export function saveBlock(folder: string, root?: string): BlockConfig {
	const block: BlockConfig = {
		folder: expandPath(folder),
		...(root?.trim() ? { root: expandPath(root) } : {}),
		updatedAt: new Date().toISOString(),
	};
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(BLOCK_FILE, JSON.stringify(block, null, "\t"), "utf-8");
	return block;
}

/** The block's root: the configured one, else the block folder's parent. */
export function blockRoot(block: BlockConfig): string {
	return block.root ?? path.dirname(block.folder);
}

/** The course folders in the block (visible subdirectories, sorted). */
export function blockFolders(block: BlockConfig): string[] {
	try {
		return fs
			.readdirSync(block.folder, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
			.map((d) => path.join(block.folder, d.name))
			.sort();
	} catch {
		return [];
	}
}
