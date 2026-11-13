
const HUB_URL = process.env.COLLABORATION_HUB_URL;

const DEVELOPER_ID =
  process.env.COLLABORATION_DEVELOPER_ID || "unknown-developer";

export async function reportToolActivity(toolName, args, success) {
  if (!HUB_URL) return;

  const cardId = args.cardId ?? args.idCard ?? null;

  const event = {
    type: "mcp_tool_activity",
    developerId: DEVELOPER_ID,
    tool: toolName,
    cardId,
    success,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // The hub is optional. Trello MCP must keep working.
  }
}
