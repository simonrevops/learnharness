import { effectivePromptSegments } from "../../agent/prompt-segments.ts";
import { quizMechanics } from "../../agent/tools.ts";
import { effectiveSettings } from "../stores.ts";
import { MAINTENANCE_PREFIX } from "./env.ts";
import { NEXT_PROBLEM_TEXT, THINKING_LABEL } from "../../core/contracts/chat.ts";

/**
 * The Claude Code session's system prompt. The pi engine runs two agents
 * (prober, then teacher) with two prompts; a Claude Code session is one
 * conversation, so both doctrines compose into one prompt with phase
 * headings. Every fragment is LearnHarness's own (overrides honored); only
 * the engine notes below are new, plus a learner-files note for Claude
 * Code's built-in file tools.
 *
 * Left out for stage 1: the teacher's job/demo fragments — research, demo,
 * visual, and pdf dispatch are not wired to this engine.
 */

const TEACHER_SKIP = new Set(["teacher/40-jobs.md", "teacher/50-demos.md"]);
const SHARED_REPLACE: Record<string, string> = {
	"shared/30-learner-files.md": `## Learner files

His files live on his machine, referenced by path, name, or description — locating and reading them is your job; never ask him to paste contents. Use Glob to find a file by name, Grep for the right passage, and Read to inspect it (Read handles PDFs directly). All read-only.`,
};

function engineNotes(): string {
	const mech = quizMechanics(effectiveSettings().agent.tools);
	const probeQ = mech === "free" ? "recall" : "probe";
	const teachQ = mech === "free" ? "explain" : "quiz";
	return `# How this session runs

You run inside Claude Code, but you are not a coding assistant here: you are the LearnHarness teacher described below. The learner talks to you through the LearnHarness window, which renders your Markdown and LaTeX — never through this terminal. Your messages are what he reads.

**Tools.** Your teaching tools come from the \`lh\` server: wherever these instructions name a tool (\`quiz\`, \`probe_done\`, \`plan_init\`, …) you call it as \`mcp__lh__<name>\`. Probe phase: \`${probeQ}\`, \`ask_user_question\`, \`probe_done\`, \`list_sessions\`, \`list_propositions\`. Teach phase: \`${teachQ}\`, \`ask_user_question\`, \`plan_init\`. A tool from the wrong phase is refused. There is no \`research\`, \`pdf\`, \`demo\`, or \`visual\` tool in this session: verify facts with WebSearch/WebFetch yourself when it matters, and read PDFs with Read.

**Questions.** A question tool puts the question on his screen and returns at once; end your turn right after it, as the instructions say. His graded answer arrives as his next message, starting "My answer to your … question:".

**App messages.** A prompt that starts with \`${MAINTENANCE_PREFIX}\` comes from the LearnHarness app, not the learner: do exactly what it asks, and keep any reply to one line.`;
}

export function composeClaudeCodeInstructions(kind: "teach" | "practice" = "teach"): string {
	if (kind === "practice") return composePracticeInstructions();
	const switches = effectiveSettings().agent.prompts ?? {};
	const text = (s: { enabled: boolean; overrideText: string | null; sourceText: string }) =>
		(s.enabled ? s.overrideText! : s.sourceText).trim();
	const prober = effectivePromptSegments("prober", switches);
	const teacher = effectivePromptSegments("teacher", switches);
	const base = prober.find((s) => s.path === "system-prompt.md");
	const shared = teacher.filter((s) => s.path.startsWith("shared/"));
	const own = (segs: typeof prober, dir: string) =>
		segs.filter((s) => s.path.startsWith(`${dir}/`) && !TEACHER_SKIP.has(s.path)).map(text).filter(Boolean);

	return [
		base ? text(base) : "",
		engineNotes(),
		`# PHASE 1 — THE PROBE (from the session's start until probe_done succeeds)\n\n${own(prober, "prober").join("\n\n---\n\n")}`,
		`# PHASE 2 — TEACHING (after probe_done succeeds)\n\n${own(teacher, "teacher").join("\n\n---\n\n")}`,
		...shared.map((s) => SHARED_REPLACE[s.path] ?? text(s)),
	]
		.filter(Boolean)
		.join("\n\n---\n\n");
}

function practiceEngineNotes(): string {
	return `# How this session runs

You run inside Claude Code, but you are not a coding assistant here: you are the LearnHarness practice agent described below. The learner works in the LearnHarness window, which renders your Markdown and LaTeX — never through this terminal. Your messages are what he reads.

**Tools.** \`problem\` and \`conclude\` come from the \`lh\` server: call them as \`mcp__lh__problem\` and \`mcp__lh__conclude\` (the map readers, when present, are \`mcp__lh__list_sessions\` and \`mcp__lh__list_propositions\`). There are no research or pdf job tools in this session: check facts with WebSearch/WebFetch yourself, and read files and PDFs directly with Read, Glob and Grep.

**Posing.** \`problem\` returns at once and tells you to end your turn — end it right there, writing nothing more. His thinking arrives as his next message, starting "${THINKING_LABEL}:". His go-ahead for the next problem arrives as the message "${NEXT_PROBLEM_TEXT}". If he discards a problem, a message says so: treat that problem as concluded with outcome "dismissed" (you call nothing for it).

**App messages.** A prompt that starts with \`${MAINTENANCE_PREFIX}\` comes from the LearnHarness app, not the learner: do exactly what it asks, and keep any reply to one line.`;
}

/** The practice session's prompt: LearnHarness's practice doctrine (its own
 *  directory plus the curated shared fragments), with the engine notes. */
export function composePracticeInstructions(): string {
	const switches = effectiveSettings().agent.prompts ?? {};
	const segs = effectivePromptSegments("practice", switches);
	const text = (s: (typeof segs)[number]) => (s.enabled ? s.overrideText! : s.sourceText).trim();
	const own = segs.filter((s) => s.path.startsWith("practice/")).map(text).filter(Boolean);
	const shared = segs.filter((s) => s.path.startsWith("shared/")).map(text).filter(Boolean);
	return [own[0] ?? "", practiceEngineNotes(), ...own.slice(1), ...shared].filter(Boolean).join("\n\n---\n\n");
}

/** The course-reading run's prompt (docs/blocks-and-courses.md decision 2). */
export function composeCourseSetupInstructions(folder: string, root: string | null, today: string): string {
	return `# Read a course folder for LearnHarness

You run inside Claude Code for LearnHarness, a tutoring app. Your one job in this session: read the course folder \`${folder}\` and save what a tutor needs to know about the course, by calling \`mcp__lh__course_save\` once. Today is ${today}.

You can read the folder (Read, Glob, Grep; Read opens PDFs)${root ? `, and also \`${root}\` — the learner's other course material, which may hold term facts or notes about this course` : ""}. You cannot change any file.

Find:

- **The course name** as the course itself states it.
- **A summary**: one paragraph on what the course is, how it is assessed, and what the assessments reward (for example: no-aids quizzes reward fluent recall; an all-aids exam rewards working problems fast with prepared notes).
- **The teaching weeks**: number, the Monday each week starts (YYYY-MM-DD), the topics in the course's own words and section numbers, and where that week's material sits in the folder. A teaching break is a gap between week start dates — never a week of its own. If only a term start is given, derive the weeks from it and from any break the material mentions.
- **The assessments**: each exam, quiz and hand-in with its date (YYYY-MM-DD), time if stated, weight in percent, aids allowed (none, some, all) and a one-line format.
- **The files a tutor should read first** at the start of any session (an index, a handoff or progress note, a scorecard, a syllabus), as paths relative to the course folder.

Prefer the folder's own index, syllabus or plan files over guessing from file names. Never invent: leave out a weight or a time the folder doesn't state. When you're done, call \`mcp__lh__course_save\` once, then reply with one line saying what you saved, and stop.`;
}

/** The notes-import worker's prompt (stage 3): it only runs the graph
 *  update the app asks for. */
export function composeImportWorkerInstructions(): string {
	return `# LearnHarness import worker

You run inside Claude Code for LearnHarness, a tutoring app, and you have one job: when the app asks you to import into the knowledge graph, run the graph-extractor agent (Agent tool, subagent_type "graph-extractor") and wait until it reports DONE, then reply with its one-line summary only. Do nothing else, and keep every reply to one line.`;
}
