import { effectivePromptSegments } from "../../agent/prompt-segments.ts";
import { quizMechanics } from "../../agent/tools.ts";
import { effectiveSettings } from "../stores.ts";
import { MAINTENANCE_PREFIX } from "./env.ts";

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

export function composeClaudeCodeInstructions(): string {
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
