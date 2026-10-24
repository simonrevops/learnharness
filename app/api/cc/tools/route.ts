// GET /api/cc/tools?chatId= — the tool list the Claude Code MCP proxy serves
// (scripts/cc-mcp.mjs). Local only: the proxy runs on the same machine.
import { CC_ENGINE, listTools } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (!CC_ENGINE) return Response.json({ error: "The Claude Code engine is off" }, { status: 404 });
	const chatId = new URL(request.url).searchParams.get("chatId") ?? "";
	if (!chatId) return Response.json({ error: "chatId required" }, { status: 400 });
	return Response.json({ tools: listTools(chatId) });
}
