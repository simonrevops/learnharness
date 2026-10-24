// POST /api/courses/write-back {courseId, on} — let the course's sessions
// update the learner's own progress files (off unless he turns it on).
import { blockOverview, getCourse, setWriteBack } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const { courseId, on } = (await request.json().catch(() => ({}))) as { courseId?: unknown; on?: unknown };
	if (typeof courseId !== "string" || typeof on !== "boolean") {
		return Response.json({ error: "courseId and on required" }, { status: 400 });
	}
	if (!getCourse(courseId)) return Response.json({ error: "Unknown course" }, { status: 404 });
	setWriteBack(courseId, on);
	return Response.json(blockOverview());
}
