// PUT /api/chats/[id]/course {courseId | null} — link a session to a course
// or topic after the fact, or unlink it (fork, Courses & Topics).
import { LibraryError, linkSession } from "@/src/server";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { courseId?: unknown } | null;
	const courseId = typeof body?.courseId === "string" ? body.courseId : body?.courseId === null ? null : undefined;
	if (courseId === undefined) return Response.json({ error: "courseId must be a course id or null" }, { status: 400 });
	try {
		return Response.json({ course: linkSession(id, courseId) });
	} catch (err) {
		if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
