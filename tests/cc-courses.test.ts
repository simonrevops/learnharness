/**
 * Blocks and courses (docs/blocks-and-courses.md) — the date folds the home
 * screen and the tutor prompt read, the course a reading run saves, and the
 * Claude Code engine's practice plumbing (what reaches Claude Code as the
 * learner's input; a posed problem ending the turn in the record).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	blockWeek,
	courseBrief,
	courseIdFromFolder,
	currentWeek,
	nextAssessment,
	suggestNext,
	type Course,
} from "../src/core/courses.ts";
import { courseFromSubmission } from "../src/server/cc/course-setup.ts";
import { learnerInput } from "../src/server/cc/agent.ts";
import { convertTranscript, type CcEntry } from "../src/server/cc/transcript.ts";
import { concludedByDismissalPair, newNextMessage, newProblemDismissedMarker, newThinkingMessage } from "../src/core/native-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const finance: Course = {
	id: "finance-1",
	name: "Finance 1",
	folder: "/x/Finance 1",
	summary: "Payment streams, portfolios, options.",
	weeks: [
		{ week: 1, startsOn: "2026-08-31", topics: "Payment streams" },
		{ week: 6, startsOn: "2026-10-05", topics: "Binomial model" },
		// Autumn break: no week starts 2026-10-12.
		{ week: 7, startsOn: "2026-10-19", topics: "Stochastic interest rates" },
		{ week: 8, startsOn: "2026-10-26", topics: "Q&A" },
	],
	assessments: [{ name: "Exam", kind: "exam", date: "2026-11-05", weight: 100, aids: "all" }],
	readFirst: ["_COURSE_INDEX.md"],
	draftedAt: "2026-10-24T00:00:00Z",
};

const regression: Course = {
	...finance,
	id: "regression",
	name: "Regression",
	weeks: [
		{ week: 1, startsOn: "2026-08-31", topics: "Linear models" },
		{ week: 6, startsOn: "2026-10-05", topics: "Survival analysis" },
	],
	assessments: [
		{ name: "Quiz 1", kind: "quiz", date: "2026-09-23", aids: "none" },
		{ name: "Assignment 2", kind: "assignment", date: "2026-10-27", weight: 25, aids: "all" },
		{ name: "Quiz 2", kind: "quiz", date: "2026-11-02", weight: 40, aids: "none" },
	],
};

test("course ids are filename-safe slugs of the folder name", () => {
	assert.equal(courseIdFromFolder("Finance 1"), "finance-1");
	assert.equal(courseIdFromFolder("Sandsynlighedsteori 2"), "sandsynlighedsteori-2");
	assert.equal(courseIdFromFolder("Økonomi & Ret"), "konomi-ret");
	assert.equal(courseIdFromFolder("___"), "course");
});

test("the current week is the latest started; a break reads as the week before it", () => {
	assert.equal(currentWeek(finance, "2026-08-30"), null);
	assert.equal(currentWeek(finance, "2026-08-31")?.week, 1);
	assert.equal(currentWeek(finance, "2026-10-14")?.week, 6, "the break week stays in week 6");
	assert.equal(currentWeek(finance, "2026-10-24")?.week, 7);
	assert.equal(currentWeek(finance, "2026-12-01")?.week, 8);
	assert.deepEqual(blockWeek([finance, regression], "2026-10-24"), { week: 7, of: 8 });
	assert.deepEqual(blockWeek([], "2026-10-24"), { week: null, of: 0 });
});

test("the next assessment is the nearest one today or later", () => {
	assert.deepEqual(nextAssessment(regression, "2026-10-24")?.assessment.name, "Assignment 2");
	assert.equal(nextAssessment(regression, "2026-10-24")?.daysLeft, 3);
	assert.equal(nextAssessment(regression, "2026-11-02")?.daysLeft, 0);
	assert.equal(nextAssessment(regression, "2026-11-03"), null);
});

test("the suggestion: exam prep inside 14 days, shaped by the assessment; else this week's lesson; else practice", () => {
	// All-aids exam 12 days out → old exam problems.
	const fin = suggestNext(finance, "2026-10-24", 0);
	assert.equal(fin.mode, "practice");
	assert.match(fin.label, /Old exam problems/);
	// An assignment is next → a lesson on what it needs (never doing it for him).
	const reg = suggestNext(regression, "2026-10-24", 0);
	assert.equal(reg.mode, "teach");
	assert.match(reg.label, /Get ready for Assignment 2/);
	// The no-aids quiz once the assignment is in → recall practice.
	const quiz = suggestNext(regression, "2026-10-28", 0);
	assert.equal(quiz.mode, "practice");
	assert.match(quiz.prompt, /no aids/);
	// Far from any assessment: this week's lesson first, then practice.
	const early = suggestNext(finance, "2026-09-01", 0);
	assert.equal(early.mode, "teach");
	assert.match(early.prompt, /week 1: Payment streams/);
	assert.equal(suggestNext(finance, "2026-09-01", 1).mode, "practice");
});

test("the tutor brief carries the week, the assessments and the folders", () => {
	const brief = courseBrief(regression, "2026-10-24", "/x");
	assert.match(brief, /# This session's course: Regression/);
	assert.match(brief, /Week 6 \(from 2026-10-05\): Survival analysis ← this week/);
	assert.match(brief, /Quiz 2 — 2026-11-02, 40% of the grade, NO aids \(in 9 days\)/);
	assert.match(brief, /Quiz 1 — 2026-09-23, NO aids \(done\)/);
	assert.match(brief, /`\/x\/CLAUDE.md`/);
	assert.doesNotMatch(courseBrief(regression, "2026-10-24", null), /CLAUDE\.md/);
});

test("a reading run's submission becomes a sorted, trimmed course", () => {
	const c = courseFromSubmission(
		"finance-1",
		"/x/Finance 1",
		{
			name: " Finance 1 ",
			summary: "S",
			weeks: [
				{ week: 2, startsOn: "2026-09-07", topics: " B ", material: " " },
				{ week: 1, startsOn: "2026-08-31", topics: "A", material: "Lectures/Uge 01" },
			],
			assessments: [{ name: "Exam", kind: "exam", date: "2026-11-05", aids: "all", time: " " }],
			readFirst: [" _COURSE_INDEX.md ", ""],
		},
		"2026-10-24T00:00:00Z",
	);
	assert.equal(c.name, "Finance 1");
	assert.deepEqual(c.weeks.map((w) => w.week), [1, 2]);
	assert.equal(c.weeks[1]!.material, undefined, "a blank material is dropped");
	assert.equal(c.assessments[0]!.time, undefined);
	assert.equal(c.assessments[0]!.weight, undefined, "no weight stated → none stored");
	assert.deepEqual(c.readFirst, ["_COURSE_INDEX.md"]);
});

// ─── practice under the Claude Code engine ──────────────────────────────────

function assistantCall(id: string, name: string): LhMessage {
	return {
		id: `a_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		api: "anthropic-messages",
		provider: "claude-code",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	} as LhMessage;
}
function result(id: string, name: string): LhMessage {
	return { id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as LhMessage;
}

test("practice input: thinking and next-problem markers reach Claude Code as the learner's message", () => {
	const posed = [assistantCall("p1", "problem"), result("p1", "problem")];
	assert.equal(learnerInput([...posed, newThinkingMessage("p1", "x = 2")]), "Your thinking:\nx = 2");
	assert.match(learnerInput([...posed, newNextMessage()])!, /^\[NEXT PROBLEM\]/);
	assert.equal(learnerInput(posed), null, "nothing new from the learner");
});

test("practice input: a dismissed problem is said in words; its synthesized conclude is skipped", () => {
	const msgs: LhMessage[] = [
		assistantCall("p1", "problem"),
		result("p1", "problem"),
		newProblemDismissedMarker("p1"),
		...concludedByDismissalPair("p1"),
		{ id: "u1", role: "user", content: "why does that work?", timestamp: 0 } as LhMessage,
	];
	const text = learnerInput(msgs)!;
	assert.match(text, /discarded the problem/);
	assert.match(text, /why does that work\?$/);
});

test("practice input: the opening map context goes with the first message; answers to questions do not pass here", () => {
	const ctx = { id: "c", role: "custom", customType: "graph-context", content: "[Session context] picks", display: true, timestamp: 0 } as unknown as LhMessage;
	const first = { id: "u", role: "user", content: "practise CAPM", timestamp: 0 } as LhMessage;
	assert.equal(learnerInput([ctx, first]), "[Session context] picks\n\npractise CAPM");
	assert.equal(learnerInput([assistantCall("q", "quiz"), result("q", "quiz")]), null);
	// The probe→teach handoff marker is not the learner's: it stops the fold.
	const handoff = { id: "h", role: "custom", customType: "steer", content: "handoff", display: false, timestamp: 0 } as unknown as LhMessage;
	assert.equal(learnerInput([handoff, first]), "practise CAPM");
});

let n = 0;
const ts = () => new Date(Date.UTC(2026, 9, 24, 12, 0, n++)).toISOString();
const block = (msgId: string, b: Record<string, unknown>, stop = "end_turn"): CcEntry => ({
	type: "assistant",
	uuid: `a${n}`,
	timestamp: ts(),
	message: { id: msgId, role: "assistant", model: "m", content: [b as never], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } },
});

test("a posed problem keeps its result in the record and ends the turn there", () => {
	const out = convertTranscript(
		[
			{ type: "user", uuid: "u0", timestamp: ts(), message: { role: "user", content: "practise" } },
			block("m1", { type: "tool_use", id: "p1", name: "mcp__lh__problem", input: { statement: "s" } }, "tool_use"),
			{
				type: "user",
				uuid: "r1",
				timestamp: ts(),
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", content: [{ type: "text", text: "Problem posed — end your turn" }] }] },
			},
			block("m2", { type: "text", text: "Over to you!" }),
		],
		"chat_cc_courses_test",
	);
	assert.deepEqual(out.messages.map((m) => m.role), ["assistant", "toolResult"], "chatter after the pose is dropped");
	assert.equal((out.messages[1] as { toolName: string }).toolName, "problem");
});
