// POST /api/courses/read {folder} — start the course-reading run for one of
// the block's course folders (a Claude Code session in a Terminal tab).
import { blockFolders, blockOverview, CC_ENGINE, getBlock, startCourseRead } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!CC_ENGINE) return Response.json({ error: "Reading a course needs the Claude Code engine" }, { status: 501 });
	const { folder } = (await request.json().catch(() => ({}))) as { folder?: unknown };
	const block = getBlock();
	if (!block) return Response.json({ error: "Choose the block folder first" }, { status: 400 });
	if (typeof folder !== "string" || !blockFolders(block).includes(folder)) {
		return Response.json({ error: "Not one of the block's course folders" }, { status: 400 });
	}
	startCourseRead(folder);
	return Response.json(blockOverview());
}
