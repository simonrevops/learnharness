"use client";

import { useEffect, useState } from "react";
import { TimerIcon } from "lucide-react";

/**
 * The mock exam's clock (fork, stage 3): minutes used of the exam's length,
 * counted from when the paper was posed. Before that it reads "Mock exam".
 */
export function MockClock({ minutes, startedAt }: { minutes: number; startedAt: number | null }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === null) return;
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, [startedAt]);
	const used = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 60_000));
	const over = used !== null && used >= minutes;
	return (
		<span
			data-testid="mock-clock"
			className={`pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide ${over ? "text-destructive" : "text-muted-foreground"}`}
		>
			<TimerIcon className="size-3" />
			{used === null ? "Mock exam" : over ? `Time's up · ${minutes} min` : `${used} / ${minutes} min`}
		</span>
	);
}
