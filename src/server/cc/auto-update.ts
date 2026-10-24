/**
 * The automatic graph update (docs/blocks-and-courses.md, stage 3): after a
 * teaching turn settles, the lesson's graph update runs once the lesson has
 * been quiet for a while. Loaded lazily from the timer, so the chat handler
 * and the graph update don't import each other.
 */

/** How long a lesson must be quiet before the graph updates on its own
 *  (docs/blocks-and-courses.md, stage 3). */
export const AUTO_UPDATE_QUIET_MS = 15 * 60_000;

const timers = ((globalThis as { __lhCcAutoUpdate?: Map<string, ReturnType<typeof setTimeout>> }).__lhCcAutoUpdate ??= new Map());

/** A teaching turn settled: update the graph once the lesson has been quiet
 *  for AUTO_UPDATE_QUIET_MS. Any new turn cancels it (cancelAutoGraphUpdate). */
export function scheduleAutoGraphUpdate(chatId: string, quietMs: number = AUTO_UPDATE_QUIET_MS): void {
	cancelAutoGraphUpdate(chatId);
	const t = setTimeout(() => {
		timers.delete(chatId);
		void Promise.all([import("./graph-update.ts"), import("./session.ts")])
			.then(([{ startGraphUpdate }, { liveProcess, readSessionRecord }]) => {
				// Only while the lesson's Claude Code tab is still open: never
				// reopen a tab the learner closed just to update the graph.
				const rec = readSessionRecord(chatId);
				if (!rec || !liveProcess(rec.ccSessionId)) return null;
				return startGraphUpdate(chatId);
			})
			.then(async (res) => {
				if (res && res.status >= 400) console.info(`[cc ${chatId}] automatic graph update skipped: ${(await res.json()).error ?? res.status}`);
			})
			.catch((err: unknown) => console.error(`[cc ${chatId}] automatic graph update failed:`, err));
	}, quietMs);
	t.unref?.();
	timers.set(chatId, t);
}

export function cancelAutoGraphUpdate(chatId: string): void {
	const t = timers.get(chatId);
	if (t) clearTimeout(t);
	timers.delete(chatId);
}
