// POST /api/cc/tools/call {chatId, name, arguments} — run one LearnHarness tool
// for Claude Code. Question tools answer {pending: token} instead of a result:
// the proxy then polls /api/cc/tools/poll until the learner has answered.
import { CC_ENGINE, callTool } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!CC_ENGINE) return Response.json({ error: "The Claude Code engine is off" }, { status: 404 });
	let body: { chatId?: unknown; name?: unknown; arguments?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (typeof body.chatId !== "string" || typeof body.name !== "string") {
		return Response.json({ error: "Body must be {chatId, name, arguments}" }, { status: 400 });
	}
	return Response.json(await callTool(body.chatId, body.name, body.arguments ?? {}));
}
