# savkes-trello-mcp

A working [Model Context Protocol](https://modelcontextprotocol.io) server for
Trello, written **from scratch with zero dependencies**: no SDK, no
`node_modules`, just Node's standard library and about 1,800 lines of
commented code.

Use it two ways:

- **To learn how MCP works.** Most servers hide the protocol behind
  `@modelcontextprotocol/sdk`. Here you can read every byte that crosses the
  wire, from the `initialize` handshake to a tool result, in a single
  270-line file.
- **As a real Trello integration for Claude Code.** It has 34 tools, 5
  prompts, 3 resources, and a draft → review → push workflow for creating
  numbered epic/story/task cards.

---

## Contents

1. [What MCP is, in one minute](#what-mcp-is-in-one-minute)
2. [Architecture](#architecture)
3. [The life of a tool call](#the-life-of-a-tool-call)
4. [Add your own tool](#add-your-own-tool)
5. [Lessons baked into the code](#lessons-baked-into-the-code)
6. [Setup](#setup)
7. [What's included](#whats-included)
8. [Testing](#testing)
9. [When to use the official SDK instead](#when-to-use-the-official-sdk-instead)

---

## What MCP is, in one minute

An MCP **client** (Claude Code, Claude Desktop, an IDE) starts your **server**
as a child process and talks to it over **stdin/stdout**. Each message is one
line of [JSON-RPC 2.0](https://www.jsonrpc.org/specification). A server can
offer three kinds of things:

| Primitive | What it is | Here |
|---|---|---|
| **Tools** | Functions the model can call | `addCard`, `findCards`, `auditCardHierarchy`, … |
| **Resources** | Read-only data addressed by URI | `trello://board/<id>/lists` |
| **Prompts** | Reusable prompt templates the user can invoke | `board-status`, `my-tasks`, … |

A session from the server's side looks like this:

```
client → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
server ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{},"prompts":{}},"serverInfo":{"name":"trello-board","version":"0.4.0"}}}
client → {"jsonrpc":"2.0","method":"notifications/initialized"}          ← no id = notification, never answered
client → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
server ← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"getMyBoards","description":"…","inputSchema":{…},"annotations":{…}}, …]}}
client → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"findCards","arguments":{}}}
server ← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"[ {\"name\":\"1.1. Login page\", …} ]"}]}}
```

That covers most of what the protocol does.

### Start with the 50-line version

[`examples/minimal.mjs`](examples/minimal.mjs) is a complete MCP server with
one `echo` tool and nothing else. Read it first: the Trello server is the
same structure with validation, error handling and the Trello API added.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}' \
| node examples/minimal.mjs
```

---

## Architecture

```
 .mcp.json ──starts──▶ node server/src/index.mjs
                         │
                         │  protocol layer: line framing, JSON-RPC dispatch,
                         │  argument validation, version negotiation
                         │
          ┌──────────────┼──────────────────┬───────────────────┐
          ▼              ▼                  ▼                   ▼
   tools/cards.mjs  tools/hierarchy.mjs  resources.mjs      prompts.mjs
   CRUD tools       domain tools         trello:// URIs     text templates
          │              │                  │
          │              ├──▶ utils/numbering.mjs   pure logic, no I/O
          ▼              ▼                  ▼
        trello/client.mjs  ── the ONLY place that talks HTTP ──▶ api.trello.com
        auth header · rate limit · 429 retry · timeout · error redaction
```

Each layer has one job, and each job lives in one layer:

| File | Job | Knows about |
|---|---|---|
| `server/src/index.mjs` | Speak MCP: frame lines, route methods, validate args, wrap results | MCP, but not Trello |
| `server/src/tools/*.mjs` | Define tools as plain objects `{ description, inputSchema, annotations, run }` | Trello endpoints, but not MCP framing |
| `server/src/trello/client.mjs` | One `trello(method, path, params)` function for every HTTP call | HTTP, but not tools |
| `server/src/utils/numbering.mjs` | Card-number parsing and placement maths | Nothing (pure functions) |
| `server/src/resources.mjs`, `prompts.mjs` | The other two MCP primitives | — |
| `server/src/index.test.mjs` | Protocol + tool tests with a mocked `fetch` | — |

Because a tool is plain data plus a `run` function, the protocol layer doesn't
need any knowledge of individual tools. It reads `TOOLS` (`index.mjs:39`) and
serves whatever is in it.

---

## The life of a tool call

Follow `{"id":3,"method":"tools/call","params":{"name":"getCard","arguments":{"cardId":"abc"}}}`
through the code:

1. **Framing:** `onChunk` (`index.mjs`) buffers stdin and splits on `\n`. A
   partial line stays in the buffer until the rest arrives.
2. **Queueing:** each complete line is chained onto a single promise
   (`queue = queue.then(...)`). Requests run one at a time, so responses come
   back in order.
3. **Parsing:** `dispatch` runs `JSON.parse`. If the message has no `id`,
   it's a notification and never gets a response.
4. **Routing:** `handle` switches on `method`. For `tools/call` it looks up
   `TOOLS[name]`.
5. **Validation:** `validateArgs` checks the arguments against the tool's
   `inputSchema`: unknown keys, missing required keys, and wrong types. It
   names the offending key.
6. **Execution:** `tool.run(args)` calls `trello("GET", "/cards/abc")`.
7. **HTTP:** `trello()` takes a rate-limit token, sets the `Authorization`
   header, calls `fetch` with a 30-second timeout, retries a 429 up to 5
   times with backoff, and parses the JSON.
8. **Result:** `handle` wraps the value as
   `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
9. **Errors:** an exception inside a tool becomes
   `{ content: [...message...], isError: true }`, a *result* the model can
   read and react to. Only protocol-level failures (unknown method, bad
   prompt name) become JSON-RPC `error` frames.

The split in step 9 is important. A failed tool call is information for the
model ("that card id doesn't exist"). A protocol error means the client
itself did something wrong.

---

## Add your own tool

Example: a read-only tool that returns a board's name and URL.

**1. Add an entry to `server/src/tools/cards.mjs`:**

```js
getBoard: {
  description:
    "Get a board's name, description and URL. boardId accepts a board URL, " +
    "shortLink, or 24-char id; defaults to TRELLO_BOARD_ID.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      boardId: { type: "string", description: "Board to read; defaults to TRELLO_BOARD_ID" },
    },
  },
  run: ({ boardId } = {}) =>
    trello("GET", `/boards/${resolveBoard(boardId)}`, { fields: "name,desc,url" }),
},
```

**2. Add its name to the expected tool list** in `index.test.mjs`. The test
suite asserts the full set of tool names, so a missing or colliding tool
fails loudly.

**3. Run `npm test` and `npm run smoke`**, then restart Claude Code. The new
tool is listed as `mcp__trello-board__getBoard`.

Checklist for a good tool:

- **Write the `description` for the model, not for a human.** Say what it
  returns, what to pass, and which tool to use instead when this one is the
  wrong choice. The model relies on this text when choosing tools.
- **Keep payloads small.** Ask Trello for only the `fields` you need. A raw
  card list can run to hundreds of thousands of characters and fill the
  model's context. That's why `findCards` returns 4 fields per card.
- **Set `annotations`.** `readOnlyHint: true` for reads. For writes,
  `destructiveHint` defaults to *true* in the spec, so additive tools should
  say `destructiveHint: false`. Clients use these hints to decide what needs
  a confirmation prompt.
- **Throw on bad input.** Trello often answers 200 and ignores a bad value
  (see `updateChecklistItem`), so validate in `run` when that's the case.

---

## Lessons baked into the code

Every one of these is a bug someone actually hit, and the comment at each
site explains it. They apply to any MCP server you write.

| Lesson | Where |
|---|---|
| **stdout is the protocol.** A stray `console.log` corrupts the stream, so all logging goes to stderr. | `index.mjs` (`console.error` only) |
| **Reject unknown arguments.** Otherwise a `desc:` vs `description:` typo silently creates an empty card. | `validateArgs` |
| **Negotiate the protocol version, don't echo it.** Answer with a version you actually support. | `negotiateVersion` |
| **Answer `resources/templates/list` even if it's empty.** If you declare a capability, clients will call it. | `handle` |
| **Every network call needs a timeout.** With serialized dispatch, one hung socket stalls the whole session. | `client.mjs` `AbortSignal.timeout` |
| **Bound your retries.** An unbounded 429 loop looks exactly like a hang. | `MAX_ATTEMPTS` |
| **Keep credentials out of URLs.** Trello's 404 page echoes the request URL, so query-string credentials end up in model context and transcripts. Credentials go in the `Authorization` header, with redaction as a backup. | `authHeader`, `redact` |
| **Unset env vars may arrive as the literal text `${VAR}`.** Detect that and name the missing variable instead of failing with an opaque 401. | `credential`, `defaultBoard` |
| **Rate-limit on the client side.** Trello allows 100 requests per 10 seconds per token, and it's easier to stay under that than to recover from 429s. | `Bucket` |
| **Bound fan-out.** `placeCards` moves 40 cards through a pool of 4 workers, not 40 sockets at once. | `pool` |
| **Report partial failure.** Batch tools return `{ placed, failed }` so a half-applied batch isn't hidden behind one error. | `placeCards`, `repairCardHierarchy` |

---

## Setup

**→ See [SETUP.md](SETUP.md)** for getting Trello credentials and installing
the server in Claude Code (this repo or every project) or Claude Desktop,
plus why a claude.ai connector isn't supported.

Quick version for this repo: export `TRELLO_API_KEY` and `TRELLO_TOKEN`,
start `claude` from the repo root, and `.mcp.json` does the rest.

> You must be a **member** of the Trello board. Being a guest on the board
> isn't enough to use this MCP.

---

## What's included

### Tools (34)

| Group | Tools |
|---|---|
| **Read** | `getMyBoards` `getLists` `getLabels` `getBoardMembers` `getCard` `getCardsByList` `getMyCards` `getRecentActivity` `getCardChecklists` `listCardAttachments` `findCard` `findCards` |
| **Write (additive)** | `addCard` `addList` `addComment` `addChecklist` `addChecklistItem` `moveCard` `unarchiveCard` `attachCard` `placeCards` |
| **Write (destructive)** | `updateCard` `changeCardMembers` `archiveCard` `archiveList` `updateComment` `deleteComment` `updateChecklistItem` `deleteChecklist` `detachCard` |
| **Hierarchy** | `listBoardCardLinks` `auditCardHierarchy` `nextCardNumbers` `repairCardHierarchy` (with `dryRun`) |

The hierarchy tools show what domain tools look like beyond CRUD. Cards are
numbered `EPIC 1` → `1.1` (story) → `1.1.2` (task), each card is attached to
its parent, and the tools check and repair that structure. The rules live in
`utils/numbering.mjs` as pure functions, so they're easy to test.

### Resources

`trello://board/<id>/lists`, `trello://board/<id>/activity` (both only when
`TRELLO_BOARD_ID` is set), and `trello://me/cards`.

### Prompts

`create-task`, `board-status`, `my-tasks`, `card-discussion`, `comment-on-card`.

### Claude Code workflow (`.claude/`)

On top of the server, the repo ships a two-phase card workflow:

```
/trello-card-draft <topic>   → trello-agent writes .claude/tasks/<topic>.md   (you review and edit it)
/trello-card-push  <topic>   → trello-push-agent creates the cards, numbers them,
                               attaches each one to its parent, and orders them in the list
```

| Path | What |
|---|---|
| `.claude/skills/trello-card-draft/` | Draft skill, with templates for epic / user-story / task cards |
| `.claude/skills/trello-card-push/` | Push skill |
| `.claude/agents/trello-agent.md` | Subagent that writes the cards |
| `.claude/agents/trello-push-agent.md` | Subagent that creates them in Trello |

Add `.claude/tasks/` to `.gitignore` in whatever project uses this workflow.

---

## Testing

```bash
cd server
npm test        # protocol + tool tests, mocked fetch, no network or credentials needed
npm run smoke   # real stdio round trip: prints exactly 4 JSON-RPC frames
```

`npm test` replaces `globalThis.fetch` with a recorder, so it checks the exact
request each tool would send (method, path, params) without calling Trello.
It also starts the server as a child process and talks to it over real
stdio.

### Explore it with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the
official debugging client. It lists a server's tools, resources and prompts
and lets you call them by hand, so you can test a server without an AI
client:

```bash
# browser UI
npx @modelcontextprotocol/inspector node server/src/index.mjs

# or straight from the terminal
npx @modelcontextprotocol/inspector --cli node server/src/index.mjs --method tools/list
npx @modelcontextprotocol/inspector --cli node examples/minimal.mjs \
  --method tools/call --tool-name echo --tool-arg text=hi
```

The Trello server reads `TRELLO_API_KEY` / `TRELLO_TOKEN` from your shell.
Pass a board with `-e TRELLO_BOARD_ID=<id>` before `node`.

---

## When to use the official SDK instead

This server writes the protocol by hand so you can see it. For a production
server, consider
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk):
it handles transports (stdio *and* HTTP), schema validation with zod,
progress notifications, cancellation, and new protocol versions as they
ship. Once you've read `index.mjs`, you'll know what the SDK does for you.

---

## License

MIT, see [LICENSE](LICENSE).
