# Phase 1 — Trello MCP Live Collaboration Hub

A **local, optional** collaboration service added to the original `savkes-trello-mcp` repository. This is a working Phase 1 prototype, not a production multi-user deployment.

## Run locally (Node.js 20+)

Terminal 1:

```bash
cd collaboration-hub
npm install
npm start
```

Open **http://127.0.0.1:8787** in two separate browser tabs. Connect with different names, focus on a card, and try to claim the same card or same field. Add a dependency, change statuses, and observe the live feed. `npm run demo` simulates two developers. `npm test` checks the optional bridge behavior.

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

- Authenticated team accounts, roles, permissions, assignments, approval requests, notifications
- Durable persistence, robust reconnect identity, claim expiration, multi-instance hosting
- Trello webhooks, real-time Trello edits, GitHub file overlap detection, AI merges
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
