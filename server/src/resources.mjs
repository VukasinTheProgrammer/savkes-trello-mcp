// The 3 resources ported from mcp-trello 0.4.0's `registerTrelloResources`.
//
// The board-presence conditional is kept exactly as it was: the two board-scoped
// resources are registered only when a board id is configured, because their URIs
// embed it, while "My Cards" is registered unconditionally — /members/me/cards is
// scoped by the token, not by a board.
//
// The registry is rebuilt per request rather than frozen at import: trello/client.mjs reads
// credentials per call, so TRELLO_BOARD_ID may be set after this module loads.

import { defaultBoard, resolveBoard, trello } from "./trello/client.mjs";

const JSON_MIME = "application/json";

function registry() {
  const board = defaultBoard() ? resolveBoard() : null;
  return [
    ...(board
      ? [
          {
            name: "Board Lists",
            uri: `trello://board/${board}/lists`,
            mimeType: JSON_MIME,
            description: "All lists on the board",
            read: () => trello("GET", `/boards/${board}/lists`),
          },
          {
            name: "Recent Activity",
            uri: `trello://board/${board}/activity`,
            mimeType: JSON_MIME,
            description: "Recent activity on the board",
            read: () => trello("GET", `/boards/${board}/actions`, { limit: 50 }),
          },
        ]
      : []),
    {
      name: "My Cards",
      uri: "trello://me/cards",
      mimeType: JSON_MIME,
      description: "Cards assigned to the authenticated user",
      read: () => trello("GET", "/members/me/cards"),
    },
  ];
}

// `read` is the server's business, not the client's — strip it from the wire shape.
export const listResources = () => registry().map(({ read, ...meta }) => meta);

export async function readResource(uri) {
  const entry = registry().find((r) => r.uri === uri);
  if (!entry) {
    const err = new Error(
      `Unknown resource: ${uri}. Available: ${listResources().map((r) => r.uri).join(", ")}`,
    );
    err.code = -32602;
    throw err;
  }
  return {
    contents: [{ uri, mimeType: entry.mimeType, text: JSON.stringify(await entry.read(), null, 2) }],
  };
}
