/** Browser-safe engine flag (fork: docs/claude-code-engine.md). The client
 *  bundle sees NEXT_PUBLIC_LH_ENGINE inlined at build/dev start; with the
 *  Claude Code engine on, the BYOK model and key setup gates step aside —
 *  the learner's own Claude Code session is the model. */
export const CLAUDE_CODE_ENGINE_UI = process.env.NEXT_PUBLIC_LH_ENGINE === "claude-code";
