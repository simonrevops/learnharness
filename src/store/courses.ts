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

function courseFile(id: string): string {
	if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(COURSES_DIR, `${id}.json`);
}

export function getCourse(id: string): Course | null {
	try {
		return JSON.parse(fs.readFileSync(courseFile(id), "utf-8")) as Course;
	} catch {
		return null;
	}
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
	fs.writeFileSync(courseFile(course.id), JSON.stringify(course, null, "\t"), "utf-8");
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
