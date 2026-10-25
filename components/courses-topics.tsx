"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpenIcon, DumbbellIcon, PlusIcon } from "lucide-react";
import { BUTTON, CourseCardView, formatDay, startCourseSession } from "@/components/block-panel";
import { SidebarToggle } from "@/components/sidebar";
import type { CourseCard, LibraryEntry, LibraryOverview } from "@/src/core";

/**
 * Courses & Topics (fork, docs/blocks-and-courses.md decisions 19–23): every
 * course and topic in one place. This block's courses (the home panel's
 * cards), "Add course" (a new folder in the block, opened in Finder),
 * earlier courses, and topics — learning outside uni, linked to its
 * lessons and practice like a course.
 */

const INPUT =
	"min-w-0 rounded-md border border-border bg-background px-2 py-1 font-ui text-xs text-foreground outline-none focus:border-muted-foreground/60";

function draftHref(id: string, mode: "teach" | "practice", text: string): string {
	return `/chat/new?${new URLSearchParams({ ...(mode === "practice" ? { mode } : {}), course: id, text }).toString()}`;
}

export function CoursesTopics() {
	const router = useRouter();
	const [data, setData] = useState<LibraryOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [starting, setStarting] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/library");
			setData((await res.json()) as LibraryOverview);
		} catch {
			/* offline dev server — keep the last view */
		}
	}, []);

	const busy = data?.block.cards.some((c) => c.reading || c.importing) ?? false;
	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), busy ? 4000 : 60_000);
		return () => clearInterval(t);
	}, [load, busy]);

	/** POST and take the overview back; the block-panel routes answer with
	 *  the block overview only, so those reload the page's view after. */
	const post = async (url: string, body: unknown, method = "POST"): Promise<(LibraryOverview & { created?: string }) | null> => {
		setError(null);
		const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const json = (await res.json()) as LibraryOverview & { error?: string; created?: string };
		if (!res.ok) {
			setError(json.error ?? "Something went wrong");
			return null;
		}
		if ("past" in json) setData(json);
		else await load();
		return json;
	};

	const start = async (card: CourseCard, mock?: boolean) => {
		if (starting) return;
		setStarting(card.courseId);
		try {
			const target = await startCourseSession(card, mock);
			if (target) router.push(target);
		} finally {
			setStarting(null);
		}
	};

	return (
		<div className="h-dvh overflow-y-auto">
			<header className="lh-drag sticky top-0 z-10 flex items-center gap-2 bg-background/90 px-3 py-2 backdrop-blur">
				<div className="lh-no-drag">
					<SidebarToggle />
				</div>
				<h1 className="font-ui text-sm font-medium text-foreground">Courses &amp; Topics</h1>
			</header>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pb-16 pt-4" data-testid="courses-topics">
				{!data ? (
					<p className="font-ui text-xs text-muted-foreground">Loading…</p>
				) : (
					<>
						{error && <p className="font-ui text-xs text-destructive">{error}</p>}
						{notice && <p className="font-ui text-xs text-muted-foreground">{notice}</p>}

						<Section
							title="This block"
							hint={
								data.block.block
									? `${data.block.block.folder}${data.block.week.week !== null ? ` · week ${data.block.week.week} of ${data.block.week.of}` : ""}`
									: "Choose the block folder on the home screen first."
							}
						>
							<div className="grid gap-2 sm:grid-cols-2">
								{data.block.cards.map((card) => (
									<CourseCardView
										key={card.folder}
										card={card}
										starting={starting === card.courseId}
										onStart={() => void start(card)}
										onMock={() => void start(card, true)}
										onShowCourse={() => router.push(`/?lens=${encodeURIComponent(card.courseId)}`)}
										onWriteBack={(on) => void post("/api/courses/write-back", { courseId: card.courseId, on })}
										onRead={() => void post("/api/courses/read", { folder: card.folder })}
										onImport={() => void post("/api/courses/import", { courseId: card.courseId })}
										onDone={(name) => void post("/api/courses/assessment", { courseId: card.courseId, name, done: true })}
									/>
								))}
							</div>
							{data.block.block && (
								<AddForm
									label="Add course"
									fields={[{ key: "name", placeholder: "Course name, as the uni writes it" }]}
									submit="Create folder"
									help="Creates the folder in this block and opens it in Finder. Put the course's files in it (syllabus, lecture plan, exam info), then press Read course on its card."
									onSubmit={async ({ name }) => {
										const out = await post("/api/courses/new", { name });
										if (out?.created) setNotice(`Created ${out.created} and opened it in Finder. Add the course's files, then press Read course.`);
										return out !== null;
									}}
								/>
							)}
						</Section>

						<Section title="Topics" hint="Learning outside uni. Same knowledge graph, so it builds on what you already know.">
							{data.topics.length === 0 && <p className="font-ui text-xs text-muted-foreground">No topics yet.</p>}
							<div className="grid gap-2 sm:grid-cols-2">
								{data.topics.map((t) => (
									<EntryCard key={t.id} entry={t} />
								))}
							</div>
							<AddForm
								label="New topic"
								fields={[
									{ key: "name", placeholder: "Name, e.g. Investing" },
									{ key: "goal", placeholder: "What you want to be able to do" },
									{ key: "folder", placeholder: "Folder with material (optional), e.g. ~/Books/Investing" },
								]}
								submit="Create topic"
								onSubmit={async (v) => {
									const out = await post("/api/topics", v);
									if (out?.created) setNotice(null);
									return out !== null;
								}}
							/>
						</Section>

						<Section title="Earlier courses" hint="Courses from earlier blocks. Their points stay in the graph; practise them any time.">
							{data.past.length === 0 ? (
								<p className="font-ui text-xs text-muted-foreground">
									None yet. When a block ends and you point the home panel at the next one, its courses move here.
								</p>
							) : (
								<div className="grid gap-2 sm:grid-cols-2">
									{data.past.map((c) => (
										<EntryCard key={c.id} entry={c} />
									))}
								</div>
							)}
						</Section>
					</>
				)}
			</div>
		</div>
	);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div>
				<h2 className="font-ui text-xs font-medium uppercase tracking-wider text-foreground">{title}</h2>
				{hint && <p className="mt-0.5 truncate font-ui text-xs text-muted-foreground">{hint}</p>}
			</div>
			{children}
		</section>
	);
}

/** An earlier course or a topic: what it is, its sessions and points, and
 *  the two doors (lesson, practice). */
function EntryCard({ entry }: { entry: LibraryEntry }) {
	const sessions = `${entry.lessons} ${entry.lessons === 1 ? "lesson" : "lessons"}, ${entry.practice} practice`;
	return (
		<div className="rounded-lg border border-border/70 bg-background/60 p-2.5" data-testid="library-entry">
			<div className="font-ui text-xs font-medium text-foreground">{entry.name}</div>
			<p className="mt-1 line-clamp-2 font-ui text-xs text-muted-foreground">{entry.summary}</p>
			{entry.folder && <p className="mt-1 truncate font-ui text-xs text-muted-foreground/80">{entry.folder}</p>}
			<p className="mt-1 font-ui text-xs text-muted-foreground">
				{sessions}
				{entry.lastActive && ` · last ${formatDay(entry.lastActive.slice(0, 10))}`}
				{entry.kind === "course" && entry.assessments.total > 0 && ` · ${entry.assessments.done}/${entry.assessments.total} assessments done`}
				{entry.graphPoints.length > 0 && (
					<>
						{" · "}
						<Link
							href={`/?lens=${encodeURIComponent(entry.id)}`}
							title="Show these points in the chain table, picked — ready to practise"
							className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
						>
							{entry.graphPoints.length} points in the graph
						</Link>
					</>
				)}
			</p>
			<div className="mt-2 flex flex-wrap gap-1.5">
				<Link href={draftHref(entry.id, "teach", `${entry.name}: `)} className={BUTTON} title="A lesson — say what you want to understand">
					<BookOpenIcon className="size-3" />
					Lesson
				</Link>
				<Link href={draftHref(entry.id, "practice", `${entry.name}: `)} className={BUTTON} title="A practice session — on its points unless you say otherwise">
					<DumbbellIcon className="size-3" />
					Practice
				</Link>
			</div>
		</div>
	);
}

/** A folded "+ Add …" row that opens into a small form. */
function AddForm({
	label,
	fields,
	submit,
	help,
	onSubmit,
}: {
	label: string;
	fields: Array<{ key: string; placeholder: string }>;
	submit: string;
	help?: string;
	onSubmit: (values: Record<string, string>) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [sending, setSending] = useState(false);
	if (!open) {
		return (
			<button type="button" onClick={() => setOpen(true)} className={`${BUTTON} self-start`}>
				<PlusIcon className="size-3" />
				{label}
			</button>
		);
	}
	return (
		<form
			className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border p-2.5"
			onSubmit={(e) => {
				e.preventDefault();
				if (sending) return;
				setSending(true);
				void onSubmit(values)
					.then((ok) => {
						if (ok) {
							setValues({});
							setOpen(false);
						}
					})
					.finally(() => setSending(false));
			}}
		>
			<div className="font-ui text-xs font-medium text-foreground">{label}</div>
			{help && <p className="font-ui text-xs text-muted-foreground">{help}</p>}
			{fields.map((f, i) => (
				<input
					key={f.key}
					autoFocus={i === 0}
					value={values[f.key] ?? ""}
					onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
					placeholder={f.placeholder}
					className={INPUT}
				/>
			))}
			<div className="flex gap-1.5">
				<button type="submit" disabled={sending} className={BUTTON}>
					{sending ? "Creating…" : submit}
				</button>
				<button type="button" onClick={() => setOpen(false)} className="cursor-pointer font-ui text-xs text-muted-foreground hover:text-foreground">
					Cancel
				</button>
			</div>
		</form>
	);
}
