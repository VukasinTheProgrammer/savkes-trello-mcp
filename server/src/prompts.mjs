// The 5 prompts ported from mcp-trello 0.4.0's `registerTrelloPrompts`.
//
// Static text builders — no API calls, no imports beyond this file. The prompt text
// names tools directly (getLists, findCards, getRecentActivity,
// getMyCards, getCard, addComment). The selftest re-checks that claim by
// pulling each tool-shaped identifier out of the built text and looking it up in
// the merged tool map — a rename would otherwise leave the prompts pointing at
// tools that no longer exist.

const user = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

export const PROMPTS = {
  // Rewritten, not ported verbatim. mcp-trello's version told the model to call
  // getLists then addCard directly, which produces a card with no hierarchy number,
  // no parent attachment and no labels — exactly the drift auditCardHierarchy
  // reports. This repo already has a two-phase plan-then-push path that gets all
  // three right, so the prompt points at it instead of racing it.
  "create-task": {
    description: "Create a new Trello task/card with details",
    arguments: [
      { name: "taskName", description: "The name/title of the task", required: true },
      { name: "listName", description: "The name of the list (optional)", required: false },
    ],
    build: ({ taskName, listName }) =>
      user(
        `Create a Trello card for "${taskName}"${listName ? ` in the "${listName}" list` : ""} ` +
          "using this repo's two-phase path, not a direct addCard call.\n\n" +
          `Run /trello-card-draft "${taskName}" to draft the card into ` +
          ".claude/tasks/<topic>.md, then /trello-card-push <topic> to create it. " +
          "That path is what assigns the hierarchy number via nextCardNumbers, resolves " +
          "and attaches the parent card, and resolves label IDs live with getLabels. " +
          "A bare addCard skips all three and leaves an unnumbered, unattached, " +
          "unlabelled card that auditCardHierarchy will then report as drift.\n\n" +
          "Only fall back to addCard directly if the card is deliberately outside the " +
          "numbered hierarchy — a `---` separator, or a scratch card being archived.",
      ),
  },

  "board-status": {
    description: "Get an overview of the current board status",
    arguments: [],
    build: () =>
      user(
        "Please provide a comprehensive overview of the Trello board. Use getLists to see all lists, then findCards to fetch every card in one call and group them by idList. Also use getRecentActivity to show recent changes.",
      ),
  },

  "my-tasks": {
    description: "View all tasks assigned to me",
    arguments: [],
    build: () =>
      user(
        "Please show all Trello cards assigned to me using the getMyCards tool. Organize them by due date and highlight any overdue items.",
      ),
  },

  "card-discussion": {
    description: "View a card with all its comments and discussion",
    arguments: [{ name: "cardId", description: "The ID of the card to view", required: true }],
    build: ({ cardId }) =>
      user(
        `Please retrieve the card "${cardId}" using the getCard tool with includeComments set to true. Show the card details and format all comments in a readable discussion format with timestamps and authors.`,
      ),
  },

  "comment-on-card": {
    description: "Add a comment to a specific card",
    arguments: [
      { name: "cardId", description: "The ID of the card to comment on", required: true },
      { name: "comment", description: "The comment text to add", required: true },
    ],
    build: ({ cardId, comment }) =>
      user(
        `Please add the following comment to card "${cardId}" using the addComment tool: "${comment}"`,
      ),
  },
};
