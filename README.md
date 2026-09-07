# savkes-trello-mcp

Standalone copy of the `trello-board` MCP server — a project-local, stdio
Trello integration for Claude Code. No external dependencies: pure Node.js
ESM (`.mjs`), Node's built-in `http`/`https`/`fetch` only, no `package.json`.

Cut from the `trello-board` server in the TBP — Team Bravo Projekat repo.
Everything project-specific (that project's own board/label/list ids) was
left behind — this copy is the protocol/tool layer only, ready to point at
any Trello board.

## Layout

| File | What |
|---|---|
| `.claude/trello-mcp/server.mjs` | Protocol layer — stdin/stdout JSON-RPC framing, dispatch, process lifecycle |
| `.claude/trello-mcp/api.mjs` | The Trello HTTP layer |
| `.claude/trello-mcp/tools-cards.mjs` | Card-level tools (find/get/update/comment/checklist/...) |
| `.claude/trello-mcp/tools-hierarchy.mjs` | Board/list/attachment/hierarchy tools |
| `.claude/trello-mcp/numbering.mjs` | Card-number parsing/derivation helpers |
| `.claude/trello-mcp/prompts.mjs` | MCP `prompts/list` + `prompts/get` |
| `.claude/trello-mcp/resources.mjs` | MCP `resources/list` + `resources/read` (`trello://board/<id>/lists`, `.../activity`) |
| `.claude/trello-mcp/server.test.mjs` | Full protocol + tool test suite — mocks the HTTP layer, no live Trello calls |
| `.mcp.json` | Server registration, credentials as `${VAR}` references only |
| `.env.example` | Template for the three required env vars |

## One-time setup

**1. Get a Trello API key and token.**

- **Key** — open <https://trello.com/power-ups/admin>, create a Power-Up (any
  name, pick the right workspace), open it, then **Generate an API key** on
  the *API key* tab.
- **Token** — on that same tab, click the **Token** link next to the key.
  Approve the request and Trello shows the token once. Copy it before
  leaving the page.

The token grants read/write on every board your account can see, so treat it
like a password: never paste it into a file in this repo. `.mcp.json` only
holds `${VAR}` references.

**2. Find your board id.** Open the board in Trello, click **Show Menu →
More → Print, export, and share → Print and export → Export as JSON**, or
call `getMyBoards` once the server is connected — either way you want the
**full 24-character id**, not the 8-character shortLink from the board's URL.
`addList` and other write calls reject the shortLink outright.

**3. Export all three variables** in your shell profile (`~/.zshrc`,
`~/.bashrc`), then open a new terminal so a Claude Code session inherits
them:

```bash
export TRELLO_API_KEY="your_key"
export TRELLO_TOKEN="your_token"
export TRELLO_BOARD_ID="your_board_id"
```

(Or copy `.env.example` to `.env` and fill it in, if this project already
has something loading `.env` into the shell before Claude Code starts —
the server itself only reads process env, it does not load `.env` files.)

**4. Confirm the server is connected:**

```bash
claude mcp list        # run from the repo root
```

Expected: `trello-board: node ${CLAUDE_PROJECT_DIR:-.}/.claude/trello-mcp/server.mjs - ✔ Connected`

If a variable is unset, the same command prints
`[Warning] [trello-board] mcpServers.trello-board: Missing environment variables: …`
naming it, and any tool call fails with `TRELLO_API_KEY is not set — …`
rather than an opaque Trello 401.

## Protocol smoke check

No live credentials needed — this only exercises the JSON-RPC handshake:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
  '{"jsonrpc":"2.0","id":4,"method":"prompts/list"}' \
| node .claude/trello-mcp/server.mjs
```

Expect exactly four JSON-RPC frames on stdout, nothing else.

## Running the tests

```bash
node --test .claude/trello-mcp/server.test.mjs
```

Fully self-contained — mocks the HTTP layer, makes no live Trello calls, and
uses a placeholder board id purely as fixture data for building expected
request paths.

**One assertion fails on a fresh clone of this copy, by design** (`server.test.mjs`
around line 350): it checks that `.claude/skills/trello-card-draft/SKILL.md`
and `.claude/skills/trello-card-push/SKILL.md` exist, because the `create-task`
MCP prompt (`prompts.mjs`) tells the calling model to run `/trello-card-draft`
then `/trello-card-push` rather than calling `addCard` directly. Neither skill
was copied here (see "Not included" below), so that one check fails — everything
else in the suite (protocol framing, every tool, the other 4 prompts, resources)
passes standalone. Either delete that one loop from the test file, or restore
the two skills, or rewrite the `create-task` prompt to point at `addCard`
directly instead.

## Not included

The upstream repo also has `trello-agent`, `trello-push-agent`, and several
`trello-card-*` skills that consume this server — those are downstream
workflow tooling specific to that project's card-drafting process, not part
of the MCP server itself, and weren't copied here. This is the server only:
drop it into any project's `.claude/trello-mcp/`, register it the same way
in that project's own `.mcp.json`, and build whatever agents/skills call it
from scratch, or port those over separately if wanted.
