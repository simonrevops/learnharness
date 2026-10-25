/**
 * Courses & Topics (fork, docs/blocks-and-courses.md decisions 19–23): topics,
 * adding a course folder, linking a session after the fact, and the page's
 * overview (this block, earlier courses, topics). Runs under an isolated
 * LH_DATA_DIR, so every app-module import is dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { createCourseFolder, createTopic, libraryOverview, linkSession, LibraryError } = await import("../src/server/courses.ts");
const { saveBlock, saveCourse } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { launchSpecFor } = await import("../src/server/cc/launch.ts");
const { topicBrief } = await import("../src/core/courses.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const block = path.join(TMP, "School", "Active");
fs.mkdirSync(path.join(block, "Finance 1"), { recursive: true });
saveBlock(block);
const course = (id: string, folder: string) => ({
	id,
	name: id,
	folder,
	summary: "s",
	weeks: [{ week: 7, startsOn: "2026-10-19", topics: "t" }],
	assessments: [{ name: "Exam", kind: "exam" as const, date: "2026-11-05", aids: "all" as const, done: true }],
	readFirst: [],
	draftedAt: "2026-10-24T00:00:00Z",
});
saveCourse(course("finance-1", path.join(block, "Finance 1")));
saveCourse(course("mathematical-statistics", path.join(TMP, "School", "Archive", "Mathematical Statistics")));

describe("Courses & Topics", () => {
	it("a topic is a name, a goal and an optional folder, with no weeks or assessments", () => {
		const material = path.join(TMP, "Books");
		fs.mkdirSync(material);
		const t = createTopic({ name: "  Investing ", goal: "Read a fund factsheet and judge it", folder: material });
		assert.equal(t.id, "topic-investing");
		assert.equal(t.kind, "topic");
		assert.equal(t.folder, material);
		assert.deepEqual([t.weeks, t.assessments], [[], []]);
		assert.throws(() => createTopic({ name: "Investing", goal: "again" }), LibraryError);
		assert.throws(() => createTopic({ name: "Chess", goal: "" }), /what you want/);
		assert.throws(() => createTopic({ name: "Chess", goal: "g", folder: path.join(TMP, "nope") }), /No folder/);
		const brief = topicBrief(t);
		assert.match(brief, /Read a fund factsheet/);
		assert.match(brief, /list_sessions/);
		assert.ok(brief.includes(material));
	});

	it("add course makes one new folder in the block and refuses anything else", () => {
		const { folder } = createCourseFolder(" Life Insurance 1 ");
		assert.equal(folder, path.join(block, "Life Insurance 1"));
		assert.ok(fs.statSync(folder).isDirectory());
		assert.throws(() => createCourseFolder("Life Insurance 1"), /already exists/);
		for (const bad of ["a/b", ".hidden", "_shared", "", "x:y"]) assert.throws(() => createCourseFolder(bad), LibraryError, bad);
	});

	it("link to: a session joins a course at the week it started in, or a topic; unlink removes it", () => {
		const chat = chatStore.createChat("Finance 1 course");
		const linked = linkSession(chat.id, "finance-1");
		assert.equal(linked?.id, "finance-1");
		assert.equal(chatStore.getChat(chat.id)?.course?.id, "finance-1");
		assert.equal(linkSession(chat.id, "topic-investing")?.week, null);
		assert.equal(linkSession(chat.id, null), null);
		assert.equal("course" in chatStore.getChat(chat.id)!, false);
		assert.throws(() => linkSession(chat.id, "no-such-course"), LibraryError);
		assert.throws(() => linkSession("chat_missing", "finance-1"), LibraryError);
	});

	it("a topic session launches with the topic brief and reads only the topic's folder", () => {
		const chat = chatStore.createChat("Investing: what is a factor");
		linkSession(chat.id, "topic-investing");
		const spec = launchSpecFor(chat.id);
		assert.match(spec.prompt, /This session's topic: Investing/);
		assert.deepEqual(spec.addDirs, [path.join(TMP, "Books")]);
		assert.equal(spec.editFiles, undefined);
	});

	it("the overview: block courses as cards, drafted courses outside the block as earlier ones, topics with their sessions", () => {
		const practice = chatStore.createChat("Investing practice", "practice");
		linkSession(practice.id, "topic-investing");
		const lib = libraryOverview();
		assert.deepEqual(lib.block.cards.map((c) => c.folderName), ["Finance 1", "Life Insurance 1"]);
		assert.deepEqual(lib.past.map((e) => e.id), ["mathematical-statistics"]);
		assert.deepEqual(lib.past[0]!.assessments, { total: 1, done: 0 });
		const t = lib.topics.find((e) => e.id === "topic-investing")!;
		assert.equal(t.kind, "topic");
		assert.deepEqual([t.lessons, t.practice], [1, 1]);
		assert.ok(t.lastActive);
	});
});
