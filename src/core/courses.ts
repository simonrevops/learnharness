/**
 * Blocks and courses (fork, stage 2 — docs/blocks-and-courses.md). Pure:
 * the course shape a Claude Code setup run saves, and the date folds the
 * home screen and the tutor prompt read (current week, next assessment,
 * the one suggested next step). Dates are ISO day strings (YYYY-MM-DD),
 * compared as strings.
 */

export interface CourseWeek {
	week: number;
	/** The Monday the teaching week starts (YYYY-MM-DD). */
	startsOn: string;
	/** Short, in the course's own words and section numbers. */
	topics: string;
	/** Where the week's material lives, relative to the course folder. */
	material?: string;
}

export type AssessmentAids = "none" | "some" | "all";
export type AssessmentKind = "exam" | "quiz" | "assignment" | "other";

export interface CourseAssessment {
	name: string;
	kind: AssessmentKind;
	date: string;
	time?: string;
	/** Share of the grade in percent; absent when the folder doesn't say. */
	weight?: number;
	aids: AssessmentAids;
	/** One line: length, setting, what is handed in. */
	format?: string;
}

export interface Course {
	id: string;
	name: string;
	/** Absolute path of the course folder. */
	folder: string;
	/** What the course is and what its assessments reward — one paragraph. */
	summary: string;
	weeks: CourseWeek[];
	assessments: CourseAssessment[];
	/** Files a tutor reads first in any session, relative to the folder. */
	readFirst: string[];
	draftedAt: string;
}

/** The block: a folder whose subfolders are the courses. */
export interface BlockConfig {
	folder: string;
	/** The block folder's parent (archived courses, shared notes, the
	 *  learner's own tutoring notes). Defaults to the parent directory. */
	root?: string;
	updatedAt: string;
}

/** The session's course link (ChatRecord.course). */
export interface SessionCourse {
	id: string;
	/** The course name when the session started (the sidebar shows it). */
	name?: string;
	week: number | null;
}

/** A course id from its folder name: lowercase, hyphenated, filename-safe. */
export function courseIdFromFolder(folderName: string): string {
	const slug = folderName
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "course";
}

/** Today as YYYY-MM-DD in local time. */
export function isoDay(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function sortedWeeks(course: Pick<Course, "weeks">): CourseWeek[] {
	return [...course.weeks].sort((a, b) => a.week - b.week);
}

/** The latest week that has started; null before the first. Breaks are
 *  just gaps between start dates, so a break week reads as the week
 *  before it. */
export function currentWeek(course: Pick<Course, "weeks">, today: string): CourseWeek | null {
	let hit: CourseWeek | null = null;
	for (const w of sortedWeeks(course)) if (w.startsOn <= today) hit = w;
	return hit;
}

/** The week number shown for the block: the highest current week across
 *  its courses, out of the highest week number any course has. */
export function blockWeek(courses: readonly Pick<Course, "weeks">[], today: string): { week: number | null; of: number } {
	let week: number | null = null;
	let of = 0;
	for (const c of courses) {
		const cw = currentWeek(c, today);
		if (cw && (week === null || cw.week > week)) week = cw.week;
		for (const w of c.weeks) of = Math.max(of, w.week);
	}
	return { week, of };
}

/** The nearest assessment today or later, with whole days left. */
export function nextAssessment(
	course: Pick<Course, "assessments">,
	today: string,
): { assessment: CourseAssessment; daysLeft: number } | null {
	const upcoming = course.assessments.filter((a) => a.date >= today).sort((a, b) => a.date.localeCompare(b.date));
	const a = upcoming[0];
	return a ? { assessment: a, daysLeft: daysBetween(today, a.date) } : null;
}

export const EXAM_PREP_DAYS = 14;

export interface CourseSuggestion {
	mode: "teach" | "practice";
	/** The button label. */
	label: string;
	/** The session's opening message (becomes its title). */
	prompt: string;
}

function weeksSoFar(course: Pick<Course, "weeks">, cw: CourseWeek | null): string {
	return cw ? (cw.week === 1 ? "week 1" : `weeks 1–${cw.week}`) : "the course so far";
}

/** The one suggested next step for a course (decision 9). */
export function suggestNext(course: Course, today: string, lessonsThisWeek: number): CourseSuggestion {
	const cw = currentWeek(course, today);
	const next = nextAssessment(course, today);
	if (next && next.daysLeft <= EXAM_PREP_DAYS) {
		const { assessment: a, daysLeft } = next;
		const when = daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
		if (a.kind === "assignment") {
			return {
				mode: "teach",
				label: `Get ready for ${a.name}`,
				prompt: `${course.name}: ${a.name} is due ${when} (${a.date}). Teach me the ideas it needs, so I can do it myself.`,
			};
		}
		if (a.aids === "all") {
			return {
				mode: "practice",
				label: `Old exam problems for ${a.name}`,
				prompt: `${course.name}: ${a.name} is ${when} (${a.date}), all aids allowed. Practise with old exam problems from my course folder, the way the exam asks them.`,
			};
		}
		return {
			mode: "practice",
			label: `Recall practice for ${a.name}`,
			prompt: `${course.name}: ${a.name} is ${when} (${a.date}), ${a.aids === "none" ? "no aids" : "limited aids"}. Recall practice across ${weeksSoFar(course, cw)}, from memory.`,
		};
	}
	if (cw && lessonsThisWeek === 0) {
		return {
			mode: "teach",
			label: `Lesson: week ${cw.week}`,
			prompt: `${course.name}, week ${cw.week}: ${cw.topics}`,
		};
	}
	return {
		mode: "practice",
		label: "Practise the weeks so far",
		prompt: `${course.name}: practise ${weeksSoFar(course, cw)}.`,
	};
}

/** The course section of a course session's tutor prompt (decision 7). */
export function courseBrief(course: Course, today: string, root: string | null): string {
	const cw = currentWeek(course, today);
	const lines: string[] = [`# This session's course: ${course.name}`, "", course.summary.trim(), ""];
	lines.push(`Today is ${today}.${cw ? ` The course is in week ${cw.week} (started ${cw.startsOn}).` : " Teaching hasn't started yet."}`);
	lines.push("", "## Weeks", "");
	for (const w of sortedWeeks(course)) {
		const mark = cw && w.week === cw.week ? " ← this week" : cw && w.week < cw.week ? "" : " (coming)";
		lines.push(`- Week ${w.week} (from ${w.startsOn}): ${w.topics}${w.material ? ` — material: ${w.material}` : ""}${mark}`);
	}
	const upcoming = course.assessments.filter((a) => a.date >= today).sort((a, b) => a.date.localeCompare(b.date));
	const past = course.assessments.filter((a) => a.date < today);
	if (course.assessments.length > 0) {
		lines.push("", "## Assessments", "");
		const fmt = (a: CourseAssessment) =>
			`- ${a.name} — ${a.date}${a.time ? ` ${a.time}` : ""}${a.weight != null ? `, ${a.weight}% of the grade` : ""}, ${
				a.aids === "none" ? "NO aids" : a.aids === "all" ? "all aids allowed" : "some aids allowed"
			}${a.format ? `. ${a.format}` : ""}`;
		for (const a of upcoming) lines.push(`${fmt(a)} (in ${daysBetween(today, a.date)} days)`);
		for (const a of past) lines.push(`${fmt(a)} (done)`);
	}
	lines.push("", "## The course's own files", "");
	lines.push(`The course folder is \`${course.folder}\`; you can read everything in it.`);
	if (course.readFirst.length > 0) {
		lines.push(`Before your first reply, read these — they tell you where he is and what is hard for him: ${course.readFirst.map((f) => `\`${f}\``).join(", ")}.`);
	}
	if (root) {
		lines.push(
			`His other course material lives under \`${root}\` (earlier courses, shared notes) — look there for prerequisites before re-deriving them. If \`${root}/CLAUDE.md\` exists, read it first: it is his own calibration of how he wants to be tutored. Where it differs from the method above on pacing, how much help to give, or style, his notes win; the session mechanics (the probe, the plan map, the question and practice tools) stay.`,
		);
	}
	lines.push(
		"",
		"Teach the way this course teaches: its notation, its section numbers, its syllabus boundaries (leave out what the course marks as not examined). Ground problems in the course's own exercises and old exams when they exist, and say which file and problem. Shape practice to the assessment ahead: no aids means fluent recall; all aids means working exam problems efficiently with his own notes. You can read his files but never change them.",
	);
	return lines.join("\n");
}

/** The home screen's block overview (src/server/courses.ts builds it). */
export interface CourseCard {
	folder: string;
	folderName: string;
	courseId: string;
	course: Course | null;
	/** A course-reading run is waiting for its result. */
	reading: boolean;
	readError?: string;
	currentWeek: CourseWeek | null;
	next: { assessment: CourseAssessment; daysLeft: number } | null;
	lessonsThisWeek: number;
	practiceThisWeek: number;
	suggestion: CourseSuggestion | null;
}

export interface BlockOverview {
	block: (BlockConfig & { root: string }) | null;
	today: string;
	week: { week: number | null; of: number };
	cards: CourseCard[];
}

