# Trello MCP Live Collaboration Hub

A **local, optional** collaboration service added to the original `savkes-trello-mcp` repository. It is a working prototype, not a production multi-user deployment.

## Real Trello board

The hub reads `TRELLO_API_KEY`, `TRELLO_TOKEN` and `TRELLO_BOARD_ID` from the repo-root `.env` (the same file the MCP server uses). With them set, the dashboard shows the board name and a card picker grouped by list with the board's real open cards, and the hub only accepts claims, dependencies and collaboration requests on cards that are on that board (card ID or short link). Without them it runs in **demo mode** and accepts any typed ID such as `TRELLO-42`. `GET /api/board` returns what the hub sees (`?refresh=1` skips the 30-second cache).

## Input limits

Every text field has one limit, defined once in `LIMITS` in `src/utils/validators.mjs` (with the other input checks: allowed roles, card statuses, field names; text helpers live in `src/utils/formatters.mjs`): name 40, card ID 80, field 40, collaboration message 200, split descriptions 160 characters. The limits are sent to the browser with each state update and applied as `maxlength`, and the server rejects longer text with a clear message instead of cutting it silently.

## Run locally (Node.js 20+)

Terminal 1:

```bash
cd collaboration-hub
npm install
npm start
```

Open **http://127.0.0.1:8787** in two separate browser tabs. Connect with different names, pick a card, and try to claim the same card or same field. Add a dependency, change statuses, and observe the live feed. `npm run demo` simulates two developers. `npm test` checks the optional bridge behavior.

## Optional connection to the existing MCP server

The existing MCP server continues working without the hub. To broadcast **successful/failed MCP tool activity** into the dashboard, set the *same* secret in both processes:

```bash
# Terminal 1 (hub)
cd collaboration-hub
HUB_BRIDGE_TOKEN=replace-with-long-random-secret npm start

# Terminal 2 (MCP server, for example via your Cline config)
COLLAB_HUB_URL=http://127.0.0.1:8787
HUB_BRIDGE_TOKEN=replace-with-long-random-secret
```

Restart the MCP server after setting its environment variables. Its existing `tools/call` requests will send **tool name, card ID (if supplied), and success/failure** as best-effort events. No Trello credentials or full card content are sent. These events are **activity only**: the hub does not intercept or prevent real Trello changes. The browser task-claim system remains a coordination convention.

**Failure behaviour.** If the hub is stopped or returns an error, Trello writes continue in standalone mode; only a real `409` field conflict blocks a write. Set `COLLAB_REQUIRE_HUB=true` on the MCP server to refuse writes while the hub is unreachable. Field claims expire after `CLAIM_TTL_MS` (default 10 minutes).

**Dashboard security.** `/ws` accepts browser connections only from the dashboard origin (add others with `COLLAB_ALLOWED_ORIGINS`, comma-separated); non-browser clients such as `demo.mjs` must send the `x-hub-token` header.

For local MCP smoke tests: `cd server && npm test && npm run smoke` (the original server is dependency-free).

## What's implemented

- Live WebSocket presence and current-card focus
- Advisory card claims, claim releases, and same-card warnings
- Advisory field claims and same-field warnings
- Task dependencies, status changes, blocked-completion warnings
- Real-time activity feed and browser dashboard
- Optional, secret-protected MCP tool activity bridge
- Localhost-only binding by default; MCP server remains independent

## Not implemented yet

- Authenticated team accounts, permissions, assignments, notifications (roles are display labels only)
- Durable persistence, robust reconnect identity, claim expiration, multi-instance hosting
- Trello webhooks (the board list refreshes every 30 s or on *Refresh board*), real-time Trello edits, GitHub file overlap detection, AI merges
- Actual merge prevention: warnings are advisory and do not lock GitHub or Trello

**Security:** Do not expose the hub on a public interface. Browser WebSocket clients are unauthenticated in this local demo. The bridge token protects only the MCP event endpoint. For a real team-hosted deployment, add authentication, TLS, authorization, durable storage, and abuse limits first.

## Architecture

```text
Cline -> existing Trello MCP server -> Trello API (unchanged)
                  | optional tool events (HTTP + shared secret)
                  v
Developer browser A <--> Collaboration Hub <--> Developer browser B
                       | WebSocket events
                       | card/field claims
                       | task status/dependencies
                       +-- Live dashboard (HTTP)
```
