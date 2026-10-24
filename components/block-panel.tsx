"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, DumbbellIcon, RefreshCwIcon } from "lucide-react";
import { startDraftSession } from "@/components/new-session";
import type { BlockOverview, CourseCard } from "@/src/core";

/**
 * The block panel (fork, stage 2 — docs/blocks-and-courses.md decision 9):
 * floats at the home screen's top left, over the graph. One card per course
 * folder: this week's topics, the next assessment, this week's sessions and
 * the one suggested next step. A course not read yet offers "Read course",
 * which opens a Claude Code run in a Terminal tab.
 */

const COLLAPSE_KEY = "lh.blockPanel.collapsed";

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(COLLAPSE_KEY) === "1";
	} catch {
		return false;
	}
}

function writeCollapsed(v: boolean): void {
	try {
		localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
	} catch {
		/* storage blocked — the panel just forgets */
	}
}

export function formatDay(iso: string): string {
	const d = new Date(`${iso}T12:00:00`);
	return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function daysLeftLabel(n: number): string {
	return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

const AIDS_LABEL = { none: "no aids", some: "some aids", all: "all aids" } as const;

const BUTTON =
	"inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent disabled:cursor-default disabled:opacity-60";

export function BlockPanel() {
	const router = useRouter();
	const [data, setData] = useState<BlockOverview | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [folder, setFolder] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState<string | null>(null);

	useEffect(() => setCollapsed(readCollapsed()), []);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/courses");
			setData((await res.json()) as BlockOverview);
		} catch {
			/* offline dev server — keep the last view */
		}
	}, []);

	const reading = data?.cards.some((c) => c.reading) ?? false;
	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), reading ? 4000 : 60_000);
		return () => clearInterval(t);
	}, [load, reading]);

	const post = async (url: string, method: string, body: unknown) => {
		setError(null);
		const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const json = (await res.json()) as BlockOverview & { error?: string };
		if (!res.ok) setError(json.error ?? "Something went wrong");
		else setData(json);
	};

	const start = async (card: CourseCard) => {
		const s = card.suggestion;
		if (!s || starting) return;
		setStarting(card.courseId);
		try {
			const target = await startDraftSession(s.prompt, fetch, s.mode === "practice" ? "practice" : undefined, undefined, card.courseId);
			if (target) router.push(target);
		} finally {
			setStarting(null);
		}
	};

	if (!data) return null;

	if (!data.block) {
		return (
			<div className="w-80 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur" data-testid="block-panel">
				<div className="font-ui text-xs font-medium text-foreground">Your block</div>
				<p className="mt-1 font-ui text-xs text-muted-foreground">
					Point LearnHarness at the folder that holds this block's courses — one subfolder per course.
				</p>
				<form
					className="mt-2 flex gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (folder.trim()) void post("/api/courses/block", "PUT", { folder });
					}}
				>
					<input
						value={folder}
						onChange={(e) => setFolder(e.target.value)}
						placeholder="~/School/Active"
						className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-ui text-xs text-foreground outline-none focus:border-muted-foreground/60"
					/>
					<button type="submit" className={BUTTON}>
						Use folder
					</button>
				</form>
				{error && <p className="mt-1.5 font-ui text-xs text-destructive">{error}</p>}
			</div>
		);
	}

	const { week } = data;
	return (
		<div className="w-80 rounded-xl border bg-card/90 shadow-lg backdrop-blur" data-testid="block-panel">
			<button
				type="button"
				onClick={() => {
					setCollapsed(!collapsed);
					writeCollapsed(!collapsed);
				}}
				className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left font-ui text-xs font-medium text-foreground"
			>
				{collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
				<span>This block</span>
				{week.week !== null && (
					<span className="font-normal text-muted-foreground">
						· week {week.week} of {week.of}
					</span>
				)}
			</button>
			{!collapsed && (
				<div className="flex flex-col gap-2 px-3 pb-3">
					{data.cards.length === 0 && (
						<p className="font-ui text-xs text-muted-foreground">No course folders in {data.block.folder}.</p>
					)}
					{data.cards.map((card) => (
						<CourseCardView
							key={card.folder}
							card={card}
							starting={starting === card.courseId}
							onStart={() => void start(card)}
							onRead={() => void post("/api/courses/read", "POST", { folder: card.folder })}
						/>
					))}
					{error && <p className="font-ui text-xs text-destructive">{error}</p>}
				</div>
			)}
		</div>
	);
}

function CourseCardView({
	card,
	starting,
	onStart,
	onRead,
}: {
	card: CourseCard;
	starting: boolean;
	onStart: () => void;
	onRead: () => void;
}) {
	const { course } = card;
	if (!course || card.reading) {
		return (
			<div className="rounded-lg border border-border/70 bg-background/60 p-2.5" data-testid="course-card">
				<div className="font-ui text-xs font-medium text-foreground">{course?.name ?? card.folderName}</div>
				{card.reading ? (
					<p className="mt-1 font-ui text-xs text-muted-foreground">Claude Code is reading the course folder in a Terminal tab…</p>
				) : (
					<>
						<p className="mt-1 font-ui text-xs text-muted-foreground">
							Not read yet. Claude Code reads the folder and works out the weeks and the assessments.
						</p>
						<button type="button" onClick={onRead} className={`${BUTTON} mt-2`}>
							Read course
						</button>
					</>
				)}
				{card.readError && <p className="mt-1 font-ui text-xs text-destructive">{card.readError}</p>}
			</div>
		);
	}
	const cw = card.currentWeek;
	const next = card.next;
	const s = card.suggestion;
	const draft = (mode: "teach" | "practice", text: string) =>
		`/chat/new?${new URLSearchParams({ ...(mode === "practice" ? { mode } : {}), course: course.id, text }).toString()}`;
	return (
		<div className="rounded-lg border border-border/70 bg-background/60 p-2.5" data-testid="course-card">
			<div className="flex items-start justify-between gap-2">
				<div className="font-ui text-xs font-medium text-foreground">{course.name}</div>
				<button
					type="button"
					onClick={onRead}
					title="Read the course folder again"
					className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
				>
					<RefreshCwIcon className="size-3" />
				</button>
			</div>
			{cw && (
				<p className="mt-1 line-clamp-2 font-ui text-xs text-muted-foreground">
					<span className="text-foreground">Week {cw.week}:</span> {cw.topics}
				</p>
			)}
			{next && (
				<p className="mt-1 font-ui text-xs text-muted-foreground">
					<span className="text-foreground">{next.assessment.name}</span> · {formatDay(next.assessment.date)} ·{" "}
					{daysLeftLabel(next.daysLeft)} · {AIDS_LABEL[next.assessment.aids]}
				</p>
			)}
			<p className="mt-1 font-ui text-xs text-muted-foreground">
				This week: {card.lessonsThisWeek} {card.lessonsThisWeek === 1 ? "lesson" : "lessons"}, {card.practiceThisWeek} practice
			</p>
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				{s && (
					<button type="button" onClick={onStart} disabled={starting} className={`${BUTTON} border-muted-foreground/40`}>
						{s.mode === "practice" ? <DumbbellIcon className="size-3" /> : <BookOpenIcon className="size-3" />}
						{starting ? "Starting…" : s.label}
					</button>
				)}
				<Link href={draft("teach", cw ? `${course.name}, week ${cw.week}: ${cw.topics}` : `${course.name}: `)} className={BUTTON} title="A lesson — edit the topic first">
					<BookOpenIcon className="size-3" />
				</Link>
				<Link href={draft("practice", `${course.name}: `)} className={BUTTON} title="A practice session — say what to practise">
					<DumbbellIcon className="size-3" />
				</Link>
			</div>
		</div>
	);
}
