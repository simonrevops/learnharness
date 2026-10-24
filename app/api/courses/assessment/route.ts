// POST /api/courses/assessment {courseId, name, done} — mark an assessment
// done (or not); the course's next step moves on.
import { blockOverview, getCourse, setAssessmentDone } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { courseId?: unknown; name?: unknown; done?: unknown };
	if (typeof body.courseId !== "string" || typeof body.name !== "string") {
		return Response.json({ error: "courseId and name required" }, { status: 400 });
	}
	const course = getCourse(body.courseId);
	if (!course?.assessments.some((a) => a.name === body.name)) {
		return Response.json({ error: "Unknown assessment" }, { status: 404 });
	}
	setAssessmentDone(body.courseId, body.name, body.done !== false);
	return Response.json(blockOverview());
}
