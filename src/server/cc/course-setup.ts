import path from "node:path";
import { Type, type Static } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { courseIdFromFolder, isoDay, type Course } from "../../core/courses.ts";
import { blockRoot, getBlock, saveCourse } from "../../store/courses.ts";
import { deliver, freshSession } from "./session.ts";
import { readSetup, setupIdFor, writeSetup, type SetupRecord } from "./setups.ts";
import type { McpCallResult, McpToolDef } from "./tools.ts";

/**
 * The course-reading run (docs/blocks-and-courses.md decision 2): a sealed
 * Claude Code session reads one course folder and saves the course through
 * `course_save`. Repeatable — a re-read overwrites the draft.
 */

const day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" });

export const courseSaveInput = Type.Object({
	name: Type.String({ minLength: 1, description: "The course name as the course states it." }),
	summary: Type.String({
		minLength: 1,
		description: "One paragraph: what the course is, how it is assessed, what the assessments reward.",
	}),
	weeks: Type.Array(
		Type.Object({
			week: Type.Integer({ minimum: 1 }),
			startsOn: { ...day, description: "The Monday the teaching week starts, YYYY-MM-DD." },
			topics: Type.String({ minLength: 1, description: "Short, in the course's own words and section numbers." }),
			material: Type.Optional(Type.String({ description: "Where this week's material sits, relative to the course folder." })),
		}),
		{ minItems: 1 },
	),
	assessments: Type.Array(
		Type.Object({
			name: Type.String({ minLength: 1 }),
			kind: Type.Union([Type.Literal("exam"), Type.Literal("quiz"), Type.Literal("assignment"), Type.Literal("other")]),
			date: day,
			time: Type.Optional(Type.String({ description: "e.g. 14:15–16:15, when stated" })),
			weight: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "Percent of the grade, when stated." })),
			aids: Type.Union([Type.Literal("none"), Type.Literal("some"), Type.Literal("all")]),
			format: Type.Optional(Type.String({ description: "One line: length, setting, what is handed in." })),
		}),
	),
	readFirst: Type.Array(Type.String(), {
		description: "Files a tutor should read first in any session, relative to the course folder.",
	}),
});

export type CourseSaveInput = Static<typeof courseSaveInput>;

const courseSaveTool = {
	name: "course_save",
	label: "course_save",
	description:
		"Save the course you read: name, summary, teaching weeks, assessments, and the files to read first. Call once, when you have everything; an error result says what to fix.",
	parameters: courseSaveInput,
};

export function courseToolList(): McpToolDef[] {
	return [
		{
			name: courseSaveTool.name,
			description: courseSaveTool.description,
			inputSchema: JSON.parse(JSON.stringify(courseSaveInput)),
		},
	];
}

function text(t: string, isError = false): McpCallResult {
	return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** Build the stored course from a validated submission (pure: the seam tests pin). */
export function courseFromSubmission(courseId: string, folder: string, input: CourseSaveInput, now: string): Course {
	const weeks = [...input.weeks].sort((a, b) => a.week - b.week);
	return {
		id: courseId,
		name: input.name.trim(),
		folder,
		summary: input.summary.trim(),
		weeks: weeks.map((w) => ({
			week: w.week,
			startsOn: w.startsOn,
			topics: w.topics.trim(),
			...(w.material?.trim() ? { material: w.material.trim() } : {}),
		})),
		assessments: input.assessments.map((a) => ({
			name: a.name.trim(),
			kind: a.kind,
			date: a.date,
			...(a.time?.trim() ? { time: a.time.trim() } : {}),
			...(typeof a.weight === "number" ? { weight: a.weight } : {}),
			aids: a.aids,
			...(a.format?.trim() ? { format: a.format.trim() } : {}),
		})),
		readFirst: input.readFirst.map((f) => f.trim()).filter(Boolean),
		draftedAt: now,
	};
}

export async function callCourseTool(setupId: string, name: string, args: unknown): Promise<McpCallResult> {
	if (name !== courseSaveTool.name) return text(`Unknown tool: ${name}`, true);
	const setup = readSetup(setupId);
	if (!setup) return text("This course-reading run is not registered with LearnHarness.", true);
	let input: CourseSaveInput;
	try {
		input = validateToolArguments(courseSaveTool as never, {
			type: "toolCall",
			id: "course_save",
			name: courseSaveTool.name,
			arguments: args as never,
		}) as CourseSaveInput;
	} catch (err) {
		return text(err instanceof Error ? err.message : String(err), true);
	}
	const dup = input.weeks.find((w, i) => input.weeks.findIndex((x) => x.week === w.week) !== i);
	if (dup) return text(`Week ${dup.week} appears twice — give each teaching week once.`, true);
	const course = courseFromSubmission(setup.courseId, setup.folder, input, new Date().toISOString());
	saveCourse(course);
	return text(
		`Saved ${course.name}: ${course.weeks.length} weeks, ${course.assessments.length} assessments. You're done — reply with one line and stop.`,
	);
}

/** Start (or re-run) the course-reading run for one course folder. Returns
 *  at once: the run opens in a Terminal tab, and the course appears when
 *  `course_save` lands (a launch failure is kept on the run's record). */
export function startCourseRead(folder: string): SetupRecord {
	const courseId = courseIdFromFolder(path.basename(folder));
	const block = getBlock();
	const id = setupIdFor(courseId);
	const rec: SetupRecord = { id, courseId, folder, root: block ? blockRoot(block) : null, requestedAt: new Date().toISOString() };
	writeSetup(rec);
	// A re-read starts from a clean conversation unless the run is still open.
	freshSession(id);
	void deliver(id, `Read course · ${path.basename(folder)}`, `Read the course folder and save the course (today is ${isoDay()}).`).catch(
		(err: unknown) => writeSetup({ ...rec, error: err instanceof Error ? err.message : String(err) }),
	);
	return rec;
}
