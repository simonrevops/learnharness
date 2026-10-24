import type { LhMessage } from "../../core/native-messages.ts";
import { stores } from "../stores.ts";

/**
 * The running Claude Code agents, one per chat with a turn in flight. A live
 * agent's state runs ahead of the persisted record (persistTurn lands at turn
 * end), so tool calls and question polls read through here.
 */

interface LiveState {
	messages: readonly LhMessage[];
}

const g = globalThis as { __lhCcLive?: Map<string, LiveState> };
const live = (g.__lhCcLive ??= new Map());

export function registerLive(chatId: string, state: LiveState): void {
	live.set(chatId, state);
}

export function unregisterLive(chatId: string, state: LiveState): void {
	if (live.get(chatId) === state) live.delete(chatId);
}

export function liveMessages(chatId: string): readonly LhMessage[] {
	return live.get(chatId)?.messages ?? stores.chatStore.getChat(chatId)?.messages ?? [];
}
