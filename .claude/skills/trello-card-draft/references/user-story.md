# Level: user-story

Break an existing Epic into User Story cards (numbered `<epic>.N`). The parent is the epic number given with `--parent` (e.g. `--parent 2` → stories `2.1`, `2.2`, …). No `--parent`? Ask the user which epic — do not guess.

## Steps

1. **Resolve the parent with `mcp__trello-board__findCard`**, passing the prefix as `number`:

   ```
   findCard({ number: "2" })  ->  { number, matches: [{ idShort, shortLink, name, idList }] }
   ```

   It matches on the parsed hierarchy number, not a string prefix, so `2` claims `EPIC 2. <title>` and never `2.1` (a child) or `20` (another epic). One card comes back, not the board.

   - **No match** → the prefix is wrong. Stop and ask which parent was meant.
   - **More than one match** → do not guess the parent; name the collisions and stop.

   Keep the returned `shortLink` — later steps need it, and nothing else on the board carries it.

2. **Get the starting number from the tool, never by eye.** Call `mcp__trello-board__nextCardNumbers` with `under: ["2"]` and use `nextUnder["2"].next`. It is already `max + 1` (or `2.1` if the epic has no stories yet), counts direct children only, and compares numerically so `2.10` beats `2.2`. If `parentExists` comes back `false`, the prefix is wrong — stop and re-check the parent card. Both this and step 1 read the live board — there is no local snapshot to lag behind it.

3. Read [app-routes.md](app-routes.md) and build an app context string from its routes table. For topics scoped to a specific area (e.g. "wallet", "cards"), include only the relevant routes. For broad topics (e.g. "playwright-tests"), include all routes.

3b. If `--design <file>` was given, resolve it to a path against `.claude/references/designs/` (or use as-is if a full path). Pass the **path** in the subagent prompt below — do **not** Read it here. The subagent reads it itself; pasting the markup through this context costs the same bytes twice. Skip this step entirely if no `--design` flag.

3c. If `--docs <file>` was given, resolve it to a path against `.claude/references/docs/` (or use as-is if a full path). Pass the **path** in the subagent prompt below — do **not** Read it here, same reason as 3b. Skip this step entirely if no `--docs` flag.

4. Spawn `trello-agent` subagent with this prompt:
   ```
   Level: story
   Create Trello-ready user story cards for: <topic>
   Parent epic: <parent card name>
   Story numbering: start at <next number> (e.g. 2.4, 2.5, ...)

   Topic: <topic>
   Plan file: .claude/tasks/<topic>.md
   Target list: Backlog
   Prefix: <prefix>
   Write that file yourself per your § Output, and return only the receipt manifest — no card bodies.

   App context — pages and routes that exist in the codebase:
   <paste relevant routes from app context>

   Design file (omit this line if no --design flag given): <path>
   Doc file (omit this line if no --docs flag given): <path>

   Follow your § Level: story for what each card carries, and your § Output for the
   file format.
   ```

   **The prompt carries inputs, not the card spec.** What a story card contains — the
   `As a / I want / so that` form, the Given/When/Then criteria, the single `User Story`
   label with no Priority or Area at this tier — lives in `trello-agent.md`, which the
   agent reads on its own. Only run-specific values belong here.

5. The subagent writes `.claude/tasks/<topic>.md` itself and returns a receipt manifest — card bodies never enter this context. Every card carries exactly one label, `User Story`; the subagent resolves its ID with `mcp__trello-board__getLabels` (see [`../../../agents/trello-agent.md`](../../../agents/trello-agent.md) § Output step 1), falling back to [`../../../../server/trello-board-ids.md`](../../../../server/trello-board-ids.md) only if that call fails.

6. Confirm the file exists and its `Status: draft` header is present. If it is missing, the subagent failed — report that and stop. Do **not** reconstruct the cards from the receipt; the manifest holds names only, by design.

7. Report: the receipt manifest verbatim, parent epic, target list, path written, next number to use for future additions. Point the user at the file — that is where the card text is reviewed and edited before `/trello-card-push`.

## Card format

Lives with the writer, in [`../../../agents/trello-agent.md`](../../../agents/trello-agent.md) § Output — the subagent writes the plan file, so the format is documented there and not duplicated here.
