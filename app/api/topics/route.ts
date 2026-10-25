// POST /api/topics {name, goal, folder?} — create a topic: something learned
// outside uni, with lessons and practice linked to it like a course's.
import { createTopic, LibraryError, libraryOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { name?: unknown; goal?: unknown; folder?: unknown };
	try {
		const topic = createTopic({
			name: typeof body.name === "string" ? body.name : "",
			goal: typeof body.goal === "string" ? body.goal : "",
			...(typeof body.folder === "string" ? { folder: body.folder } : {}),
		});
		return Response.json({ ...libraryOverview(), created: topic.id });
	} catch (err) {
		if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
