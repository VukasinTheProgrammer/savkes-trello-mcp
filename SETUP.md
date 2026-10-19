# Setup

This guide shows how to install the `trello-board` MCP server in each place
you can use it:

| Where | Works? | Section |
|---|---|---|
| Claude Code, inside this repo | ✅ already configured (`.mcp.json`) | [A](#a-claude-code-inside-this-repo) |
| Claude Code, in every project | ✅ one command | [B](#b-claude-code-in-every-project) |
| Claude Desktop app | ✅ edit one JSON file | [C](#c-claude-desktop) |
| claude.ai custom connector | ❌ not supported, see why | [D](#d-claudeai-connectors-not-supported) |

Requirements:

- **Node ≥ 20.11** (`node --version`). There is nothing to install; the
  server has no dependencies.
- **You must be a member of the Trello board, not a guest.** The server
  acts as you, through your own token, so it can only do what your account
  can do on that board. Guest access isn't enough to use this MCP. If you're
  a guest on a board, ask a board admin to add you as a member before
  setting it up. Check your role in the board's **Share** menu.

---

## 1. Get Trello credentials

- **API key:** open <https://trello.com/power-ups/admin>, create a Power-Up
  (any name), open it, and click **Generate a new API key**.
- **Token:** on the same page, click the **Token** link next to the key and
  approve. Trello shows the token once, so copy it straight away.

> **The token grants read/write access to every board your account can
> see.** Treat it like a password. Never commit it, and never paste it into
> `.mcp.json` or any other file in a repo.

## 2. Put them in your shell environment

Add the variables to your shell profile (`~/.zshrc`, `~/.bashrc`), then
**open a new terminal** so that programs started from it see them:

```bash
export TRELLO_API_KEY="your_key"
export TRELLO_TOKEN="your_token"
export TRELLO_BOARD_ID="your_board_id"   # optional: default board for board-scoped tools
```

The server reads only the process environment and does not load `.env`
files. `.env.example` lists the variable names.

**Finding a board id:** once the server is connected, ask Claude to call
`getMyBoards`. Tools accept a board URL, the 8-character shortLink, or the
24-character id. For `TRELLO_BOARD_ID`, prefer the full id.

---

## A. Claude Code, inside this repo

Nothing to do. `.mcp.json` at the repo root registers the server as
**project-scoped**, using `${VAR}` references to your shell variables.
Start `claude` from the repo root, approve the server when asked, then
check it:

```bash
claude mcp list
# trello-board: node ${CLAUDE_PROJECT_DIR}/server/src/index.mjs - ✔ Connected
```

If a variable isn't set, Claude Code prints
`Missing environment variables: …` naming it. A tool call then fails with
`TRELLO_API_KEY is not set — …` instead of an unexplained Trello 401.

## B. Claude Code, in every project

Register the server once at **user scope** so it's available in any folder.
Run this from anywhere, replacing the path with your clone's absolute
path:

```bash
claude mcp add --scope user \
  --env 'TRELLO_API_KEY=${TRELLO_API_KEY}' \
  --env 'TRELLO_TOKEN=${TRELLO_TOKEN}' \
  --transport stdio \
  trello-board -- node /absolute/path/to/savkes-trello-mcp/server/src/index.mjs
```

Details that matter:

- **Single quotes around `'KEY=${KEY}'`.** They stop your shell from
  expanding the variable. Claude Code stores the literal `${TRELLO_TOKEN}`
  in `~/.claude.json` and fills it in from your environment each time the
  server starts, so the secret never gets written to a config file.
- **Keep `--transport stdio` between the last `--env` and the server
  name.** `--env` accepts several values, so a name right after it is read
  as another variable and the command fails with
  `Invalid environment variable format: trello-board`.
- **Everything after `--` is the server command**, passed through as-is.
- Add `--env 'TRELLO_BOARD_ID=…'` if you want a default board.
- Inside this repo, the project's `.mcp.json` entry has the same name. The
  project entry wins over the user one
  ([scope precedence](https://code.claude.com/docs/en/mcp.md)), and both
  start the same server.

Check, use, remove:

```bash
claude mcp list                      # trello-board: … - ✔ Connected
claude mcp get trello-board          # show the stored config
claude mcp remove trello-board -s user
```

Inside a Claude Code session, **`/mcp`** shows each server's status and
tool count, and can reconnect or turn a server on and off. It can't *add*
servers; use `claude mcp add` for that.

## C. Claude Desktop

Claude Desktop has **its own config file**. A server added with
`claude mcp add` does not appear there, so add it again:

1. Open **Settings → Developer → Edit Config**. That opens
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the server under `mcpServers`, keeping any entries already there:

   ```json
   {
     "mcpServers": {
       "trello-board": {
         "command": "/absolute/path/to/node",
         "args": ["/absolute/path/to/savkes-trello-mcp/server/src/index.mjs"],
         "env": {
           "TRELLO_API_KEY": "your_key",
           "TRELLO_TOKEN": "your_token",
           "TRELLO_BOARD_ID": "your_board_id"
         }
       }
     }
   }
   ```

3. **Quit Claude Desktop completely** (⌘Q on macOS, not just closing the
   window) and reopen it. The Trello tools appear under the tools/connectors
   menu in a new chat.

Notes:

- **Use absolute paths for both `node` and the script.** Desktop is started
  from the Dock, not from your terminal, so it doesn't load your shell
  profile. A `node` installed through nvm, fnm or Volta often isn't on its
  `PATH`. Get the path with `which node`, e.g.
  `/Users/you/.nvm/versions/node/v20.20.2/bin/node`.
- **The credentials go in this file as actual values.** Desktop doesn't
  inherit your shell variables. The file is in your user profile, not in a
  repo, but treat it as holding secrets.
- **Logs** if the server doesn't show up: `~/Library/Logs/Claude/mcp*.log`
  (macOS) or `%APPDATA%\Claude\logs` (Windows).

Reference:
[Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## D. claude.ai connectors: not supported

**Settings → Connectors → Add custom connector** on claude.ai accepts only
a **remote MCP server URL** that Anthropic's servers can reach over the
internet. Local servers like this one, which run as a process on your
machine over stdio, are a separate mechanism and don't show up on claude.ai
([custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).

Turning this into a connector would need an HTTP transport, public hosting,
and authentication in front of it, because the hosted server would hold
your Trello token. That's out of scope for this project. Use Claude Code or
Claude Desktop instead.

---

## Optional: the card workflow

How it works, with diagrams: [docs/WORKFLOW.md](docs/WORKFLOW.md). Before
your first `/trello-card-push`:

- **Set `TRELLO_BOARD_ID`.** It's optional for the server, but the push calls
  `findCards` without a board, so this workflow requires it.
- **The plan's `Target list` must exist on the board.** Drafts default to
  `Backlog`. Push looks the name up live with `getLists`, and if it isn't
  found it stops before creating anything. Label and list ids are looked up
  live, so `server/trello-board-ids.md` is only a fallback.
- Optionally, `.claude/skills/trello-card-draft/references/app-routes.md`:
  your app's page list, if the project has a frontend.

Skills only work in Claude Code, inside this repo.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `TRELLO_API_KEY is not set — …` | The variable isn't in the environment the client started with. Open a new terminal after editing your profile; for Desktop, put the value in its config. |
| `boardId is required when TRELLO_BOARD_ID is not set` | Pass `boardId` to the tool, or set `TRELLO_BOARD_ID`. |
| `Trello 401` | The key or token is wrong or revoked. Generate a new token. |
| Board calls fail but `getMyBoards` works | You may be a guest on that board rather than a member. Ask a board admin to make you a member. |
| `Trello 400 … invalid id` | Bad card, list or board id. Use the id, shortLink or URL from Trello. |
| Server `✘ Failed` in `claude mcp list` | Run `npm run smoke` in `server/`. It should print 4 lines of JSON. If it doesn't, check `node --version` (must be ≥ 20.11). |
| Not visible in Desktop | Check that the paths are absolute, that you fully quit and reopened Desktop, then read the `mcp*.log` files. |
