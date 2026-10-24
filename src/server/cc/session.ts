import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../../config.ts";
import {
	CC_MCP_SERVER,
	CC_SESSIONS_DIR,
	CC_TOOL_PREFIX,
	CC_WORKSPACE,
	CLAUDE_BIN,
	CLAUDE_HOME,
	lhBaseUrl,
} from "./env.ts";
import { openTab, shellQuote, typeInto, focusTab, keyInto } from "./terminal.ts";
import { launchSpecFor } from "./launch.ts";
import { GRAPH_EXTRACTOR_AGENT } from "./stage.ts";

/**
 * One LearnHarness chat ↔ one Claude Code session, launched in a Terminal tab
 * the learner can see. The mapping persists (data/claude-code/sessions/
 * <chatId>.json) so a closed tab resumes the same conversation.
 */

export interface CcSessionRecord {
	chatId: string;
	ccSessionId: string;
	createdAt: string;
	/** Set once Claude Code has registered the session at least once — the
	 *  next launch must --resume instead of creating it again. */
	started?: boolean;
	tty?: string;
}

export interface CcLiveProcess {
	pid: number;
	/** Claude Code's own state: "busy" while a turn runs, "idle" when it waits. */
	status: string;
	statusUpdatedAt: number;
	tty: string | null;
}

function recordFile(chatId: string): string {
	return path.join(CC_SESSIONS_DIR, `${chatId}.json`);
}

export function readSessionRecord(chatId: string): CcSessionRecord | null {
	try {
		return JSON.parse(fs.readFileSync(recordFile(chatId), "utf-8")) as CcSessionRecord;
	} catch {
		return null;
	}
}

function writeSessionRecord(rec: CcSessionRecord): void {
	fs.mkdirSync(CC_SESSIONS_DIR, { recursive: true });
	fs.writeFileSync(recordFile(rec.chatId), JSON.stringify(rec, null, 2));
}

export function sessionRecordFor(chatId: string): CcSessionRecord {
	const existing = readSessionRecord(chatId);
	if (existing) return existing;
	const rec: CcSessionRecord = { chatId, ccSessionId: randomUUID(), createdAt: new Date().toISOString() };
	writeSessionRecord(rec);
	return rec;
}

/** Give the id a new Claude Code conversation, unless its session is running
 *  (a re-run then continues in the open tab). */
export function freshSession(chatId: string): void {
	const existing = readSessionRecord(chatId);
	if (existing && liveProcess(existing.ccSessionId)) return;
	writeSessionRecord({ chatId, ccSessionId: randomUUID(), createdAt: new Date().toISOString() });
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ttyOf(pid: number): string | null {
	try {
		const t = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf-8" }).trim();
		return t && t !== "??" ? `/dev/${t}` : null;
	} catch {
		return null;
	}
}

/** The running Claude Code process for a session, from Claude Code's own live
 *  registry (~/.claude/sessions/<pid>.json). */
export function liveProcess(ccSessionId: string): CcLiveProcess | null {
	const dir = path.join(CLAUDE_HOME, "sessions");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	for (const f of files) {
		try {
			const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as {
				pid?: number;
				sessionId?: string;
				status?: string;
				statusUpdatedAt?: number;
			};
			if (s.sessionId !== ccSessionId || typeof s.pid !== "number" || !alive(s.pid)) continue;
			return { pid: s.pid, status: s.status ?? "idle", statusUpdatedAt: s.statusUpdatedAt ?? 0, tty: ttyOf(s.pid) };
		} catch {
			/* a registry file mid-write */
		}
	}
	return null;
}

/** Where Claude Code writes this session's transcript. */
export function transcriptPath(ccSessionId: string): string {
	const encoded = CC_WORKSPACE.replace(/[^a-zA-Z0-9]/g, "-");
	const direct = path.join(CLAUDE_HOME, "projects", encoded, `${ccSessionId}.jsonl`);
	if (fs.existsSync(direct)) return direct;
	try {
		for (const d of fs.readdirSync(path.join(CLAUDE_HOME, "projects"))) {
			const p = path.join(CLAUDE_HOME, "projects", d, `${ccSessionId}.jsonl`);
			if (fs.existsSync(p)) return p;
		}
	} catch {
		/* no projects dir yet */
	}
	return direct;
}

/** Write the launch files: the shared workspace (with the graph-extractor
 *  subagent), this session's system prompt, and its MCP + settings. */
function writeLaunchFiles(chatId: string): { mcp: string; settings: string; prompt: string; addDirs: string[]; editFiles: string[] } {
	fs.mkdirSync(path.join(CC_WORKSPACE, ".claude", "agents"), { recursive: true });
	fs.writeFileSync(path.join(CC_WORKSPACE, ".claude", "agents", "graph-extractor.md"), GRAPH_EXTRACTOR_AGENT);
	const spec = launchSpecFor(chatId);
	fs.mkdirSync(CC_SESSIONS_DIR, { recursive: true });
	const prompt = path.join(CC_SESSIONS_DIR, `${chatId}.prompt.md`);
	fs.writeFileSync(prompt, spec.prompt);
	const mcp = path.join(CC_SESSIONS_DIR, `${chatId}.mcp.json`);
	fs.writeFileSync(
		mcp,
		JSON.stringify(
			{
				mcpServers: {
					[CC_MCP_SERVER]: {
						command: process.execPath,
						args: [path.join(PATHS.root, "scripts", "cc-mcp.mjs")],
						env: { LH_URL: lhBaseUrl(), LH_CHAT_ID: chatId },
					},
				},
			},
			null,
			2,
		),
	);
	const settings = path.join(CC_SESSIONS_DIR, `${chatId}.settings.json`);
	fs.writeFileSync(
		settings,
		JSON.stringify(
			{
				permissions: {
					allow: [
						`mcp__${CC_MCP_SERVER}`,
						"Read",
						"Glob",
						"Grep",
						"WebSearch",
						"WebFetch",
						"Agent",
						// Write-back (opt-in): only these existing files. "//" anchors
						// a rule at the filesystem root.
						...(spec.editFiles ?? []).map((f) => `Edit(/${f})`),
					],
					deny: ["Bash", "Write", "NotebookEdit", ...((spec.editFiles ?? []).length > 0 ? [] : ["Edit"])],
				},
			},
			null,
			2,
		),
	);
	return { mcp, settings, prompt, addDirs: spec.addDirs.filter((d) => fs.existsSync(d)), editFiles: spec.editFiles ?? [] };
}

function launchCommand(rec: CcSessionRecord, title: string): string {
	const files = writeLaunchFiles(rec.chatId);
	const args = [
		rec.started ? `--resume ${rec.ccSessionId}` : `--session-id ${rec.ccSessionId}`,
		// The tutor session sees none of the learner's own Claude Code setup:
		// no user CLAUDE.md, memory, hooks, plugins, or other MCP servers.
		"--setting-sources project,local",
		`--settings ${shellQuote(files.settings)}`,
		"--strict-mcp-config",
		`--mcp-config ${shellQuote(files.mcp)}`,
		`--system-prompt-file ${shellQuote(files.prompt)}`,
		files.editFiles.length > 0
			? // Write-back sessions get Edit, and anything not allowed is refused
				// without asking (no prompt in a tab nobody watches).
				"--tools Read,Glob,Grep,WebSearch,WebFetch,Agent,Edit --permission-mode dontAsk"
			: "--tools Read,Glob,Grep,WebSearch,WebFetch,Agent",
		// Course sessions read the learner's course folders (read-only: the
		// settings deny every writing tool).
		...files.addDirs.map((d) => `--add-dir ${shellQuote(d)}`),
		`-n ${shellQuote(`LearnHarness · ${title}`.slice(0, 80))}`,
		...(process.env.LH_CC_MODEL ? [`--model ${shellQuote(process.env.LH_CC_MODEL)}`] : []),
	];
	// MCP_TOOL_TIMEOUT: a question tool waits as long as the learner thinks.
	return `cd ${shellQuote(CC_WORKSPACE)} && MCP_TOOL_TIMEOUT=86400000 ${shellQuote(CLAUDE_BIN)} ${args.join(" ")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CcNotReadyError extends Error {
	override name = "CcNotReadyError";
}

/** Make sure the chat's Claude Code session is running; launches (or resumes)
 *  it in a new Terminal tab when it isn't. */
export async function ensureRunning(chatId: string, title: string): Promise<CcLiveProcess> {
	const rec = sessionRecordFor(chatId);
	const live = liveProcess(rec.ccSessionId);
	if (live) return live;
	if (!rec.started && fs.existsSync(transcriptPath(rec.ccSessionId))) rec.started = true;
	rec.tty = await openTab(launchCommand(rec, title));
	writeSessionRecord(rec);
	// Up to 5 minutes: the first launch sits on Claude Code's folder-trust
	// prompt until the learner answers it in the tab.
	for (let i = 0; i < 600; i++) {
		await sleep(500);
		const p = liveProcess(rec.ccSessionId);
		if (p) {
			rec.started = true;
			writeSessionRecord(rec);
			return p;
		}
	}
	throw new CcNotReadyError(
		"Claude Code did not start. Check its Terminal tab — the first launch asks you to trust the LearnHarness folder.",
	);
}

/** Wait until Claude Code is idle (ready for a prompt). */
export async function waitIdle(ccSessionId: string, timeoutMs: number): Promise<CcLiveProcess> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const p = liveProcess(ccSessionId);
		if (p && p.status !== "busy") return p;
		if (Date.now() > until) throw new CcNotReadyError("Claude Code is still busy in its Terminal tab.");
		await sleep(300);
	}
}

/** Type a prompt into the chat's session (launching it first if needed).
 *  Resolves to the delivery time — turn-end detection compares Claude Code's
 *  status timestamps against it. */
export async function deliver(chatId: string, title: string, text: string): Promise<number> {
	const rec = sessionRecordFor(chatId);
	await ensureRunning(chatId, title);
	const p = await waitIdle(rec.ccSessionId, 60_000);
	if (!p.tty) throw new CcNotReadyError("Could not find the Claude Code Terminal tab.");
	const at = Date.now();
	if (!(await typeInto(p.tty, text))) throw new CcNotReadyError("The Claude Code Terminal tab was closed.");
	return at;
}

/** Interrupt the running turn (the remote abort). */
export async function interrupt(chatId: string): Promise<void> {
	const rec = readSessionRecord(chatId);
	const p = rec ? liveProcess(rec.ccSessionId) : null;
	if (p?.tty) await keyInto(p.tty, "\u001b");
}

export async function focus(chatId: string): Promise<boolean> {
	const rec = readSessionRecord(chatId);
	const p = rec ? liveProcess(rec.ccSessionId) : null;
	return p?.tty ? focusTab(p.tty) : false;
}

export { CC_TOOL_PREFIX };
