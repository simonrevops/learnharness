// PUT /api/courses/block {folder, root?} — choose the block folder (its
// subfolders are the courses).
import fs from "node:fs";
import { blockOverview, saveBlock } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { folder?: unknown; root?: unknown };
	if (typeof body.folder !== "string" || !body.folder.trim()) {
		return Response.json({ error: "folder required" }, { status: 400 });
	}
	const block = saveBlock(body.folder, typeof body.root === "string" ? body.root : undefined);
	if (!fs.existsSync(block.folder) || !fs.statSync(block.folder).isDirectory()) {
		return Response.json({ error: `No folder at ${block.folder}` }, { status: 400 });
	}
	return Response.json(blockOverview());
}
