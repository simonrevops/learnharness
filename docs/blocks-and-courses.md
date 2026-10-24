# Blocks and courses (fork, stage 2)

University terms here run in blocks: two courses at a time over about eight weeks of teaching, each ending in its own assessments (exams, quizzes, hand-ins). Stage 2 makes LearnHarness aware of that. Lessons and practice belong to a course and a week, and the home screen says what to do this week in each course. Claude Code can read the course's own files.

This works with the Claude Code engine (docs/claude-code-engine.md).

## Decisions

1. **The course folders are the source of truth.** A block is a folder on disk whose subfolders are the courses (for example `~/School/Active/Finance 1`). The learner never retypes what the folders already say.
2. **A one-off Claude Code run drafts each course.** "Read course" opens a sealed Claude Code session in a Terminal tab, with read access to the course folder. It reads whatever the folder offers (an index or syllabus, lecture plans, exam info) and saves a structured course through one tool, `course_save`. The run is repeatable: re-reading overwrites the draft.
3. **What a course holds:** name, a one-paragraph summary of what the course is and what its assessments reward, the weeks (number, start date, topics, where that week's material lives), the assessments (name, date, weight, aids allowed, format), and the files worth reading first at the start of any session. It is stored in `data/courses/<id>.json`.
4. **The current week comes from the course's own week dates**, not a block start date plus arithmetic. Breaks (for example an autumn break) simply show up as a gap between week start dates. The block's week number is the highest current week across its courses.
5. **Lessons and practice sessions carry their course and week** (`course: {id, week}` on the session record). The knowledge graph stays one graph: the two courses share foundations (linear algebra under both Finance and Regression), so a course is a lens on the graph, not a partition of it.
6. **A course session's Claude Code gets read access** (`--add-dir`) to the course folder and to the block's parent folder. The parent folder covers archived earlier courses and shared references, which are the prerequisites. Everything stays read-only: Bash and file edits are still denied.
7. **A course session's prompt carries the course.** That means the course summary, this week and the weeks around it, the coming assessments with their aids rules, the folder paths and the files to read first. The tutor is told to teach the way the course teaches: its notation and its syllabus boundaries. It grounds problems in the course's own exercises and old exams, citing the file.
8. **The learner's own tutoring notes are honoured.** If the block's parent folder has a `CLAUDE.md`, the tutor reads it. Where it differs from LearnHarness's method on pacing, amount of help or style, the learner's notes win. LearnHarness's mechanics (probe, plan map, question tools, practice problems) stay.
9. **The home screen shows the block.** It shows the week number and one card per course: this week's topics, the next assessment with days left and its aids rule, lessons done this week, and one suggested next step. The suggestion is a fixed rule:
   - If an assessment is within 14 days, the step is exam practice. A no-aids assessment means recall practice; an all-aids one means working old exam problems.
   - Otherwise, if no lesson has happened this week, the step is a lesson on this week's topics.
   - Otherwise, the step is practice on the weeks so far.
10. **Practice sessions run under the Claude Code engine.** Claude Code itself does the practising, not a separate model call. The practice tools (`problem`, `conclude`) are served over MCP like the teaching tools. A posed problem ends Claude Code's turn, the same as a posed question. The learner's thinking, the next-problem signal and dismissals reach Claude Code as typed messages.
11. **No writes to the course folders.** The learner's own handoff and scorecard files stay theirs. LearnHarness's continuity is its knowledge graph and session records.

## Stage 3 — exam prep

12. **Assessments can be marked done.** The mark lives apart from the drafted course (`data/course-progress.json`), so re-reading a course keeps it. A done assessment drops out of the next step.
13. **Notes import runs on Claude Code.** An import gets a Claude Code worker session of its own (`import_<key>`, a Terminal tab). LearnHarness's pipeline runs unchanged, its extractor and auditor jobs go to the worker, and the worker's graph-extractor subagent works them. A job nobody is working fails at once instead of hanging. This serves both the existing "Import notes" button and a per-course import of the learner's own notes: text files under `Notes/` and `Solutions/Mine/`, plus the block root's `_shared/`. Lecture PDFs and textbooks stay out, because they are the course's material, not what the learner has worked through.
14. **A course's points** are the propositions that came up in its sessions or in notes imported from its folder. A course practice session with nothing picked opens on up to 64 of them, newest first, so practice stays inside the course. The course card's "N points in the graph" puts them in the chain table, picked.
15. **Mock exams.** "Mock exam" appears on a course card when an exam or quiz is within 14 days. It starts a practice session with the assessment's length, read from its format line (two hours if the line doesn't say). The whole paper is posed as one problem, there are no hints during the mock, and the marking per sub-question is the verdict at the end. The clock starts when the paper is posed: the header shows minutes used, and each learner message carries the clock for Claude Code.
16. **The graph updates itself after a lesson.** Once a teaching session has been quiet for 15 minutes, its graph update runs, as a maintenance turn the record never shows. It runs only while the lesson's Claude Code tab is still open, so a closed tab is never reopened for it. Any new turn resets the wait. Extract still works on demand.

## Stage 4 — continuity

17. **Write-back is opt-in, per course.** This revises decision 11. When the learner ticks "Let sessions update my …" on a course card, that course's sessions (never mock exams) may edit the course's read-first files that already exist inside its folder, and nothing else. Claude Code gets the Edit tool with one allow rule per file and runs in `dontAsk` mode, so anything not allowed is refused without a prompt (checked against a real Claude Code session). The tutor updates them when the learner says he is done, and in the after-lesson maintenance turn.

## Stage 5 — the next block

18. **A new block is a new folder.** "change" on the panel points LearnHarness at the next block's folder; each course there is read once. Earlier courses' records stay in `data/courses/`, and their points stay in the graph.

## Not built

- Editing a course's weeks by hand in the app (re-read the folder instead, or edit `data/courses/<id>.json`).
- Highlighting a course's points on the graph canvas itself (the course lens uses the chain table).
- Research, demo, visual and PDF jobs under the Claude Code engine: Claude Code reads PDFs and searches the web itself, and the interactive demos and visuals aren't wired yet.
- Calendar reminders.
