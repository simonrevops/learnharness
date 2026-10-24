// POST /api/cc/focus {chatId} — bring the lesson's Claude Code Terminal tab forward.
import { CC_ENGINE, focusClaudeCode } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!CC_ENGINE) return Response.json({ error: "The Claude Code engine is off" }, { status: 404 });
	const { chatId } = (await request.json().catch(() => ({}))) as { chatId?: string };
	if (!chatId) return Response.json({ error: "chatId required" }, { status: 400 });
	return Response.json({ ok: await focusClaudeCode(chatId) });
}
