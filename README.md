# savkes-trello-mcp

A project-local, stdio Trello integration for Claude Code, plus the drafting
workflow that uses it: draft cards as a reviewable plan file, then push them
to Trello with hierarchy numbers, parent attachment, and labels resolved
automatically. No external dependencies for the server itself: pure Node.js
ESM (`.mjs`), Node's built-in `http`/`https`/`fetch` only, no `package.json`.

Cut from the TBP — Team Bravo Projekat repo. Everything project-specific
(that project's own board/label/list ids, its app's route list) was stripped
to empty templates — this copy is the mechanism only, ready to point at any
Trello board and any project.

## Layout

| File | What |
|---|---|
| `.claude/trello-mcp/server.mjs` | Protocol layer — stdin/stdout JSON-RPC framing, dispatch, process lifecycle |
| `.claude/trello-mcp/api.mjs` | The Trello HTTP layer |
| `.claude/trello-mcp/tools-cards.mjs` | Card-level tools (find/get/update/comment/checklist/...) |
| `.claude/trello-mcp/tools-hierarchy.mjs` | Board/list/attachment/hierarchy tools |
| `.claude/trello-mcp/numbering.mjs` | Card-number parsing/derivation helpers |
| `.claude/trello-mcp/prompts.mjs` | MCP `prompts/list` + `prompts/get`, including `create-task` (points at the two-phase draft→push flow below) |
| `.claude/trello-mcp/resources.mjs` | MCP `resources/list` + `resources/read` (`trello://board/<id>/lists`, `.../activity`) |
| `.claude/trello-mcp/server.test.mjs` | Full protocol + tool test suite — mocks the HTTP layer, no live Trello calls |
| `.claude/trello-mcp/trello-board-ids.md` | **Empty template.** This project's own board/label/list id reference — fill in during setup, step 2 |
| `.claude/agents/trello-agent.md` | Subagent that drafts User Story / Task cards, resolving label ids via `getLabels` (falling back to the file above) |
| `.claude/agents/trello-push-agent.md` | Subagent that pushes a drafted plan's cards to Trello, attaching each to its parent |
| `.claude/skills/trello-card-draft/` | `/trello-card-draft <topic>` — drafts a reviewable plan to `.claude/tasks/<topic>.md` |
| `.claude/skills/trello-card-draft/references/app-routes.md` | **Empty template.** This project's own page/route list, used by story-level drafting for app context — see its own header for how to fill it in |
| `.claude/skills/trello-card-push/` | `/trello-card-push <topic>` — creates the drafted cards for real |
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

**2. Find your board id and fill in `trello-board-ids.md`.** Open the board
in Trello, click **Show Menu → More → Print, export, and share → Print and
export → Export as JSON**, or call `getMyBoards` once the server is
connected — either way you want the **full 24-character id**, not the
8-character shortLink from the board's URL (`addList` and other write calls
reject the shortLink outright). Put that id in
`.claude/trello-mcp/trello-board-ids.md`'s Board ID table, then call
`getLabels`/`getLists` once connected and fill in the Label ID map and List
ID map the same way. Every skill/agent here resolves ids live where it can
and falls back to this file only when that call fails, so a stale or
half-filled table degrades — it doesn't break anything.

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

**5. (Optional) Fill in `app-routes.md`** if this project has a frontend
with a meaningful page list — see that file's own header for the shape
`user-story.md` expects. Skip it for a backend-only repo, a CLI, or a
library; drafting still works without it, just without app-context in the
generated stories.

**6. Draft a card** to check the whole path end to end:

```
/trello-card-draft <topic>
```

That writes a reviewable plan to `.claude/tasks/<topic>.md` (gitignore it in
whatever project this ends up in). `/trello-card-push <topic>` turns it into
real cards. Full skill options are in
`.claude/skills/trello-card-draft/SKILL.md`.

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

Fully self-contained and passes clean on a fresh clone — mocks the HTTP
layer, makes no live Trello calls, uses a placeholder board id purely as
fixture data for building expected request paths, and (now that
`trello-card-draft`/`trello-card-push` are both present) the `create-task`
prompt's self-consistency check passes too.

## Not included

`member-summary`, `trello-audit`, and any other Trello-adjacent skills from
the upstream repo weren't copied — those are further downstream tooling
(activity summaries, hierarchy-drift auditing) built on top of this same
server, not required for the core draft → push workflow. Add them from the
upstream repo the same way this copy was made, if wanted.
