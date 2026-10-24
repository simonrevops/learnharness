# The Claude Code engine (fork)

LearnHarness normally calls a model with your API key. This fork adds a second engine: the lesson runs in **your own Claude Code session**, signed in with your Claude subscription, in a Terminal tab you can watch. Claude Code does the teaching. LearnHarness keeps everything else: the lesson record, its own teaching tools, the plan map, the knowledge graph and its screens.

Stage 1 covers one complete lesson: the probe, the plan, teaching with quizzes, and updating the knowledge graph afterwards.

## Run it

```bash
LH_ENGINE=claude-code NEXT_PUBLIC_LH_ENGINE=claude-code PORT=3417 LH_CC_URL=http://127.0.0.1:3417 npx next dev -p 3417
```

Then start a lesson in the app. The first message opens a Terminal tab running Claude Code. The very first time, Claude Code asks you to trust its folder (`data/claude-code/workspace`); answer it in that tab. You don't need any model setup or API key.

To add a lesson to your knowledge graph, use **Extract** in the session's right-click menu. Claude Code then works through the graph update in a helper agent, and the record of the lesson never shows it.

Optional: `LH_CC_MODEL=<model>` picks Claude Code's model; `LH_CLAUDE_BIN` points at a different `claude` binary.

## Why it's built this way

Anthropic's terms allow a Claude subscription only inside Anthropic's own apps, Claude Code included. Passing the subscription login to another app, including through the Agent SDK, is not allowed. So here Claude Code stays the agent, running its own loop, and LearnHarness reaches it only through supported means: a Terminal tab that gets typed into, Claude Code's transcript file, an MCP tool server, and a subagent definition. Claude Code's own credentials never leave it.

## Decisions

1. **One Claude Code session per lesson.** It runs in a visible Terminal tab, and `data/claude-code/sessions/<chatId>.json` maps the chat to the session, so a closed tab resumes the same conversation (`--resume`).
2. **The tutor session is sealed off from your own setup.** `--setting-sources project,local`, `--strict-mcp-config`, and a full `--system-prompt-file` mean it loads none of your own CLAUDE.md, memory, hooks, plugins or other MCP servers. Built-in tools are limited to Read, Glob, Grep, WebSearch, WebFetch and Agent, and Bash and file edits are denied.
3. **One shared working folder** (`data/claude-code/workspace`). Claude Code asks to trust each new folder, so a folder per lesson would ask every time.
4. **One combined system prompt.** Under the API-key engine, two agents (prober, then teacher) run with two prompts. Here both of LearnHarness's own doctrines are combined under phase headings, with short engine notes (`src/server/cc/prompt.ts`). The teacher's job and demo sections are left out for stage 1.
5. **LearnHarness's tools, unchanged, served over MCP.** `scripts/cc-mcp.mjs` is a thin stdio proxy. Every tool runs in the LearnHarness server (`src/server/cc/tools.ts`) through the same prepare, validate and execute steps the original agent loop uses. Calling a tool from the wrong phase is refused.
6. **Questions end the teacher's turn, as in LearnHarness.** A valid question returns straight away. The record ends at the unanswered call, so the question dock shows it, and the learner's answer is typed into Claude Code as the next message. A tool call that waits for the answer can't work, because Claude Code moves any MCP call still running after two minutes into the background.
7. **The lesson record is rebuilt from Claude Code's transcript** (`src/server/cc/transcript.ts`). The conversion rebuilds everything from the transcript on each read, and message ids come from the transcript itself. It drops learner prompts (LearnHarness wrote those first), Claude Code's built-in tools, teacher chatter after a posed question, maintenance turns, and Claude Code's own injected prompts (meta nudges, task notifications, subagent hand-backs).
8. **The original turn machinery stays.** `ClaudeCodeAgent` (`src/server/cc/agent.ts`) presents the surface the original turn runner expects: subscribe, continue, abort, steer, and the message state. So saving input before the turn, turn liveness, the live view, saving the finished turn and the events channel all work unchanged. A turn ends when Claude Code reports itself idle.
9. **The probe-to-teach handoff is sent once.** After a successful `probe_done`, the engine types LearnHarness's own handoff text into the session, but only if the transcript doesn't already hold it.
10. **Tool details the screens need go through a side channel.** Claude Code's transcript keeps only a tool's text, so results that carry UI details (plan_init's tree) are stored by tool name and arguments (`src/server/cc/results.ts`) and joined back in.
11. **The graph update keeps LearnHarness's whole pipeline.** That covers coverage, batching, the source digest, serialized audits, the deterministic merger and layout. Only its two model stages change hands: the pipeline posts each stage as a job, and Claude Code's `graph-extractor` subagent fetches it, explores the graph and submits. Each submission goes through the stage's own repair, schema check, fill and validate steps, with errors sent back for a retry (`src/server/cc/stage.ts`, plus a `submitRunner` option on the extraction pipeline).
12. **The graph updates only when you ask.** The update after every turn is off for this engine, because typing maintenance prompts into a lesson behind the learner's back would collide with the learner's own messages.
13. **The setup gates step aside.** The model setup and API-key prompts turn off when `NEXT_PUBLIC_LH_ENGINE=claude-code` (`src/core/engine.ts`).

## Not in stage 1

- Practice sessions and notes import (both return 501 under this engine).
- Research, demo, visual and PDF jobs. The teacher uses WebSearch and Read directly instead.
- Messages typed straight into the Terminal tab reach the teacher, but don't appear in the app's record.
- Steering mid-turn is basic: the text is typed into the busy session and Claude Code queues it.
- The automatic macOS Terminal driver is macOS-only (AppleScript, the same approach as the Factory UI).
