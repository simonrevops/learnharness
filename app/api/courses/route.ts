// GET /api/courses — the block overview the home screen draws
// (docs/blocks-and-courses.md decision 9).
import { blockOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(blockOverview());
}
