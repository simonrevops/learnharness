// GET /api/library — the Courses & Topics page: this block's courses,
// earlier courses and topics (fork, docs/blocks-and-courses.md).
import { libraryOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(libraryOverview());
}
