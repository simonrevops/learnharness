// POST /api/courses/new {name} — add a course: a new empty folder in the
// block, opened in Finder for the course's files (then "Read course").
import { createCourseFolder, LibraryError, libraryOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const { name } = (await request.json().catch(() => ({}))) as { name?: unknown };
	try {
		const { folder } = createCourseFolder(typeof name === "string" ? name : "");
		return Response.json({ ...libraryOverview(), created: folder });
	} catch (err) {
		if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
