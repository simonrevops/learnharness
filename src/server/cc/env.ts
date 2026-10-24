import path from "node:path";
import os from "node:os";
import { PATHS } from "../../../config.ts";

/**
 * THE CLAUDE CODE ENGINE (fork: docs/claude-code-engine.md). With
 * LH_ENGINE=claude-code the teaching conversation runs inside the learner's
 * own interactive Claude Code session (a Terminal tab, signed in with their
 * subscription) instead of LearnHarness's pi agent loop. Claude Code is the
 * agent; LearnHarness keeps its record, tools, graph, and UI.
 */
export const CC_ENGINE =
	process.env.LH_ENGINE === "claude-code" || process.env.NEXT_PUBLIC_LH_ENGINE === "claude-code";

/** Everything the engine keeps lives under data/claude-code. */
export const CC_DIR = path.join(PATHS.data, "claude-code");
/** One shared working directory for every lesson session — Claude Code asks
 *  to trust a folder once, so a per-chat folder would ask every lesson. */
export const CC_WORKSPACE = path.join(CC_DIR, "workspace");
/** Per-chat launch files (mcp config, settings) + the chat→session map. */
export const CC_SESSIONS_DIR = path.join(CC_DIR, "sessions");

/** The MCP server name Claude Code sees: tool `quiz` arrives as mcp__lh__quiz. */
export const CC_MCP_SERVER = "lh";
export const CC_TOOL_PREFIX = `mcp__${CC_MCP_SERVER}__`;

/** Claude Code's own state, read-only to us: live session registry + transcripts. */
export const CLAUDE_HOME = path.join(os.homedir(), ".claude");
export const CLAUDE_BIN = process.env.LH_CLAUDE_BIN ?? "claude";

/** The URL the MCP proxy (a child of Claude Code) calls back on. */
export function lhBaseUrl(): string {
	return process.env.LH_CC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** The maintenance-turn marker: a user prompt starting with this is LearnHarness
 *  talking to Claude Code (e.g. "update the graph"), never the learner — the
 *  transcript converter drops the whole turn from the lesson record. */
export const MAINTENANCE_PREFIX = "[LearnHarness maintenance]";
