import fs from "node:fs";
import path from "node:path";
import { CC_SESSIONS_DIR } from "./env.ts";

/**
 * Course-reading runs (docs/blocks-and-courses.md decision 2): each run is a
 * Claude Code session keyed `course_<courseId>` — the same session machinery
 * a lesson uses, with no chat record behind it. This file remembers which
 * folder a run reads and when it was asked to.
 */

export const SETUP_PREFIX = "course_";

export interface SetupRecord {
	id: string;
	courseId: string;
	folder: string;
	root: string | null;
	requestedAt: string;
	/** Why the run could not start, when it couldn't. */
	error?: string;
}

export function isSetupId(id: string): boolean {
	return id.startsWith(SETUP_PREFIX);
}

export function setupIdFor(courseId: string): string {
	return `${SETUP_PREFIX}${courseId}`;
}

function file(id: string): string {
	return path.join(CC_SESSIONS_DIR, `${id}.setup.json`);
}

export function readSetup(id: string): SetupRecord | null {
	try {
		return JSON.parse(fs.readFileSync(file(id), "utf-8")) as SetupRecord;
	} catch {
		return null;
	}
}

export function writeSetup(rec: SetupRecord): void {
	fs.mkdirSync(CC_SESSIONS_DIR, { recursive: true });
	fs.writeFileSync(file(rec.id), JSON.stringify(rec, null, 2));
}
