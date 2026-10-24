// POST /api/courses/import {courseId} — import the course's own notes into
// the knowledge graph (a Claude Code worker works the extraction).
import { blockOverview, CC_ENGINE, startCourseImport } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!CC_ENGINE) return Response.json({ error: "Importing course notes needs the Claude Code engine" }, { status: 501 });
	const { courseId } = (await request.json().catch(() => ({}))) as { courseId?: unknown };
	if (typeof courseId !== "string") return Response.json({ error: "courseId required" }, { status: 400 });
	const out = startCourseImport(courseId);
	if (!out.started) return Response.json({ error: out.error }, { status: 409 });
	return Response.json(blockOverview());
}
