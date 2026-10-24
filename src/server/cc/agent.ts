import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { HANDOFF_TEXT } from "../../core/contracts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { convertTranscript, readTranscript } from "./transcript.ts";
import { deliver, interrupt, liveProcess, sessionRecordFor, transcriptPath } from "./session.ts";
import { typeInto } from "./terminal.ts";
import { registerLive, unregisterLive } from "./live.ts";
import { reseedPracticeGate } from "./tools.ts";
import { mockStartedAt, type MockExam } from "../../core/courses.ts";

/**
 * The pi Agent surface runPiTurn drives (subscribe / continue / abort /
 * steer / state.messages), backed by the chat's Claude Code session instead
 * of a model call. continue() types the turn's input into the Terminal tab —
 * the learner's text, or his answers to the questions the teacher posed —
 * then follows the transcript, emitting each new teacher message as pi
 * events, until Claude Code goes idle.
 *
 * Everything around it is the pi engine's own turn machinery: write-ahead
 * persistence, liveness, the SSE view, persistTurn, the events channel.
 */

const POLL_MS = 300;
const QUESTION_NAMES = new Set<string>([...QUESTION_TOOLS, "recall", "explain"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClaudeCodeAgentOptions {
	chatId: string;
	title: string;
	messages: AgentMessage[];
	onUsage?: (usage: Usage) => void;
	/** A mock exam session: the learner's messages carry the clock. */
	mock?: MockExam;
}

export class ClaudeCodeAgent {
	readonly state: { messages: AgentMessage[] };
	private listeners = new Set<(e: AgentEvent) => void>();
	private aborted = false;
	private open = new Set<string>();
	private billed = new Set<string>();

	constructor(private readonly o: ClaudeCodeAgentOptions) {
		this.state = { messages: [...o.messages] };
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(e: AgentEvent): void {
		for (const l of [...this.listeners]) l(e);
	}

	abort(): void {
		this.aborted = true;
		void interrupt(this.o.chatId);
	}

	/** Composer steering mid-turn: Claude Code queues a prompt typed while it
	 *  is busy, so the steer is typed straight in. */
	steer(message: AgentMessage): void {
		const text = typeof (message as { content?: unknown }).content === "string" ? ((message as { content: string }).content) : "";
		this.state.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
		const p = liveProcess(sessionRecordFor(this.o.chatId).ccSessionId);
		if (p?.tty && text) void typeInto(p.tty, text);
	}

	followUp(message: AgentMessage): void {
		this.steer(message);
	}

	async continue(): Promise<void> {
		const { chatId, title } = this.o;
		const live = { messages: this.state.messages as unknown as LhMessage[] };
		registerLive(chatId, live);
		this.emit({ type: "agent_start" });
		try {
			// The practice gate starts each turn from the record (which carries a
			// dismissal the learner made since the last turn).
			reseedPracticeGate(chatId, this.state.messages as unknown as LhMessage[]);
			// A handoff left undelivered (e.g. Claude Code was closed right after
			// the probe) goes first: the teacher plans before anything else.
			const input = this.pendingInput();
			if (this.handoffDue()) await this.follow(await deliver(chatId, title, HANDOFF_TEXT));
			await this.follow(input ? await deliver(chatId, title, input) : Date.now());
			if (!this.aborted && this.handoffDue()) {
				await this.follow(await deliver(chatId, title, HANDOFF_TEXT));
			}
			for (const id of this.open) this.end(id);
			this.emit({ type: "agent_end", messages: this.state.messages });
		} finally {
			unregisterLive(chatId, live);
		}
	}

	/** What this turn hands Claude Code: the learner's unanswered text, or his
	 *  answers to the posed questions. */
	private pendingInput(): string | null {
		const last = this.state.messages.at(-1) as LhMessage | undefined;
		const learner = learnerInput(this.state.messages as unknown as LhMessage[]);
		if (learner) return this.o.mock ? `${mockClock(this.state.messages as unknown as LhMessage[], this.o.mock)}${learner}` : learner;
		if (last?.role === "toolResult" && QUESTION_NAMES.has(last.toolName)) {
			// The learner answered the question(s) the teacher posed. Under pi the
			// answer is the call's result; here it reaches Claude Code as the next
			// prompt — the same compact record the pi engine shows the model.
			const msgs = this.state.messages as unknown as LhMessage[];
			let i = msgs.length;
			while (i > 0 && msgs[i - 1]!.role === "toolResult") i--;
			const text = msgs
				.slice(i)
				.map((m) => {
					const r = m as Extract<LhMessage, { role: "toolResult" }>;
					return `My answer to your ${r.toolName} question: ${r.content.map((c) => ("text" in c ? c.text : "")).join("")}`;
				})
				.join("\n\n");
			return text;
		}
		return null;
	}

	private known(id: string): number {
		return this.state.messages.findIndex((m) => (m as { id?: string }).id === id);
	}

	private end(id: string): void {
		if (!this.open.delete(id)) return;
		const i = this.known(id);
		if (i < 0) return;
		const message = this.state.messages[i]!;
		this.emit({ type: "message_end", message });
		if (!this.billed.has(id) && (message as { role?: string }).role === "assistant") {
			this.billed.add(id);
			this.o.onUsage?.((message as unknown as AssistantMessage).usage);
		}
	}

	/** Mirror the transcript into the turn until Claude Code is done with it. */
	private async follow(since: number): Promise<void> {
		const { chatId } = this.o;
		const rec = sessionRecordFor(chatId);
		let idleReads = 0;
		for (;;) {
			if (this.aborted) return;
			const conv = convertTranscript(readTranscript(transcriptPath(rec.ccSessionId)), chatId);
			const answered = new Set(
				this.state.messages
					.filter((m) => (m as { role?: string }).role === "toolResult")
					.map((m) => (m as { toolCallId: string }).toolCallId),
			);
			for (const m of conv.messages) {
				const i = this.known(m.id);
				if (i >= 0) {
					const prev = this.state.messages[i] as LhMessage;
					if (m.role === "assistant" && (prev as AssistantMessage).content.length !== m.content.length) {
						this.state.messages[i] = m as unknown as AgentMessage;
						this.emit({ type: "message_update", message: m as never, assistantMessageEvent: undefined as never });
					}
					continue;
				}
				// A result the record already holds for the same call is dropped.
				if (m.role === "toolResult" && answered.has(m.toolCallId)) continue;
				for (const id of [...this.open]) this.end(id);
				this.state.messages.push(m as unknown as AgentMessage);
				this.open.add(m.id);
				this.emit({ type: "message_start", message: m as unknown as AgentMessage });
				if (m.role !== "assistant") this.end(m.id);
			}

			const p = liveProcess(rec.ccSessionId);
			if (!p) return; // the session was closed
			const idle = p.status !== "busy" && p.statusUpdatedAt >= since && !conv.inMaintenance;
			// Two quiet reads in a row: the last entries are flushed before we stop.
			idleReads = idle ? idleReads + 1 : 0;
			if (idleReads >= 2) return;
			await sleep(POLL_MS);
		}
	}

	/** probe_done succeeded and the teacher's first turn hasn't been asked
	 *  for yet (the pi engine's auto-wake after the probe). */
	private handoffDue(): boolean {
		if (this.known(`steer_probe_${this.o.chatId}`) < 0) return false;
		const rec = sessionRecordFor(this.o.chatId);
		const { prompts } = convertTranscript(readTranscript(transcriptPath(rec.ccSessionId)), this.o.chatId);
		return !prompts.some((p) => p.trim() === HANDOFF_TEXT.trim());
	}
}

/** Session markers whose text is the learner's (or the app's, on his
 *  behalf) and goes to Claude Code as his message. */
const SPOKEN_MARKERS = new Set(["graph-context", "practice-thinking", "practice-next"]);

const DISMISSED_TEXT =
	"(I discarded the problem without finishing it — treat it as concluded with outcome \"dismissed\"; call nothing for it.)";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((x: { text?: string }) => x.text ?? "").join("") : "";
}

function isSynthetic(m: LhMessage): boolean {
	return m.role === "assistant" && (m as AssistantMessage).provider === "synthetic";
}

/**
 * Everything the learner said since the agent last spoke: his messages, his
 * practice thinking and next-problem signals, the session's opening map
 * context, and a problem he discarded (its synthesized conclude pair is
 * skipped — Claude Code never made that call). A turn that failed to reach
 * Claude Code leaves its input unanswered, and the retry carries it too.
 * Pure: the seam tests pin.
 */
export function learnerInput(messages: readonly LhMessage[]): string | null {
	// Answers to posed questions end in a tool result: pendingInput's other path.
	if (messages.at(-1)?.role === "toolResult") return null;
	const parts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "user") {
			parts.push(textOf((m as { content: unknown }).content));
			continue;
		}
		if (m.role === "custom") {
			const type = (m as { customType?: string }).customType ?? "";
			if (SPOKEN_MARKERS.has(type)) parts.push(textOf((m as { content: unknown }).content));
			else if (type === "problem-dismissed") parts.push(DISMISSED_TEXT);
			else break;
			continue;
		}
		if (m.role === "toolResult" && (m as { toolName?: string }).toolName === "conclude") {
			// Only the synthesized dismissal's result, whose call sits just before it.
			const prev = messages[i - 1];
			if (prev && isSynthetic(prev)) continue;
			break;
		}
		if (isSynthetic(m)) continue;
		break;
	}
	const text = parts.filter((p) => p.trim()).reverse().join("\n\n");
	return text || null;
}

/** The mock exam's clock line, once the paper is posed (else nothing). */
export function mockClock(messages: readonly LhMessage[], mock: MockExam, now: number = Date.now()): string {
	const start = mockStartedAt(messages as never);
	if (start === null) return "";
	const used = Math.max(0, Math.round((now - start) / 60_000));
	return `[Mock exam — ${used} of ${mock.minutes} minutes used${used >= mock.minutes ? ": time is up" : ""}]\n\n`;
}
