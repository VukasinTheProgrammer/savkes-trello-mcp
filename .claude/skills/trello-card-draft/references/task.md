# Level: task

Break an existing User Story into implementation-level Task cards. This is the only tier that carries the Frontend/Backend/DevOps/Ai Feature + Priority label split.

## Steps

1. **Resolve the parent with `mcp__trello-board__findCard`**, passing the prefix as `number`:

   ```
   findCard({ number: "2.1" })  ->  { number, matches: [{ idShort, shortLink, name, idList }] }
   ```

   It matches on the parsed hierarchy number, not a string prefix, so `2.1` claims `2.1. <title>` and never `2.1.1` (a child) or `2.10` (a sibling). One card comes back, not the board.

   - **No match** → the prefix is wrong. Stop and ask which parent was meant.
   - **More than one match** → do not guess the parent; name the collisions and stop.

   Keep the returned `shortLink` — later steps need it, and nothing else on the board carries it.

2. **Get the starting number from the tool, never by eye.** Call `mcp__trello-board__nextCardNumbers` with `under: ["2.1"]` and use `nextUnder["2.1"].next`. It is already `max + 1` (or `2.1.1` if the parent has no children yet), counts direct children only, and compares numerically so `2.1.10` beats `2.1.2`. If `parentExists` comes back `false`, the prefix is wrong — stop and re-check the parent card. Both this and step 1 read the live board — there is no local snapshot to lag behind it.

3. **Read the parent's User Story text and Acceptance Criteria.** One call: `mcp__trello-board__getCard` on the `shortLink` step 1 found. Its description holds both — the `As a / I want / so that` User Story text, then an `**Acceptance Criteria:**` block of `**Given** / **When** / **Then**` bullets.

   Each task must map to a concrete implementation step satisfying one or more of those AC bullets, so this text is required input, not optional colour. Inventing the parent's AC from its name is the failure this step exists to prevent — `findCard` returns identity only, by design, so `getCard` is the only source.

   **Older cards may carry AC as a checklist instead.** Cards created during the short window when `trello-card-push` wrote AC as a real Trello checklist have an empty-looking description as far as AC goes. If the description has no `Acceptance Criteria:` block, call `mcp__trello-board__getCardChecklists` on the same `shortLink` and read the `checkItems` of the checklist named `Acceptance Criteria`. Only treat the parent as having no AC when **both** are empty — then stop and ask, rather than inventing them.

   Both tools take the `shortLink` or the 24-char id; an `idShort` like `402` is rejected with `invalid id`.

3b. If `--design <file>` was given, resolve it to a path against `.claude/references/designs/` (or use as-is if a full path). Pass the **path** in the subagent prompt below — do **not** Read it here. The subagent reads it itself; pasting the markup through this context costs the same bytes twice. Skip this step entirely if no `--design` flag.

3c. If `--docs <file>` was given, resolve it to a path against `.claude/references/docs/` (or use as-is if a full path). Pass the **path** in the subagent prompt below — do **not** Read it here, same reason as 3b. Skip this step entirely if no `--docs` flag.

4. Spawn `trello-agent` subagent with this prompt:
   ```
   Level: task
   Create Trello-ready task cards for parent story: <parent story name>
   Parent User Story: <parent story's "As a/I want/so that" text>
   Parent Acceptance Criteria: <paste parent AC bullets>
   Task numbering: start at <next number> (e.g. 2.1.2, 2.1.3, ...)

   Topic: <topic>
   Plan file: .claude/tasks/<topic>.md
   Target list: Backlog
   Prefix: <prefix>
   Write that file yourself per your § Output, and return only the receipt manifest — no card bodies.

   Design file (omit this line if no --design flag given): <path>
   Doc file (omit this line if no --docs flag given): <path>

   Follow your § Level: task for what each card carries and how to order them, and your
   § Output for the file format.

   Every task must map to a concrete step that satisfies one or more of the Parent
   Acceptance Criteria above — don't invent scope the story doesn't ask for.
   ```

   **The prompt carries inputs, not the card spec.** What a task card contains — the description limit, the Area and Priority values, the Given/When/Then form, the execution-order rule — lives in `trello-agent.md`, which the agent reads on its own. Restating it here made two copies that had to agree, and they had already drifted: the agent's setup-before-endpoints ordering rule never made it into this prompt. Add card-shape rules there, and only run-specific values here.

5. The subagent writes `.claude/tasks/<topic>.md` itself and returns a receipt manifest — card bodies never enter this context. Every task card carries exactly three labels: `Task` + one area label (`Frontend`/`Backend`/`DevOps`/`Ai Feature`) + one priority label (`High`/`Medium`/`Low` Priority); the subagent resolves each name with `mcp__trello-board__getLabels` (see [`../../../agents/trello-agent.md`](../../../agents/trello-agent.md) § Output step 1), falling back to [`../../../../server/trello-board-ids.md`](../../../../server/trello-board-ids.md) only if that call fails.

6. Confirm the file exists and its `Status: draft` header is present. If it is missing, the subagent failed — report that and stop. Do **not** reconstruct the tasks from the receipt; the manifest holds names only, by design.

7. Report: the receipt manifest verbatim, parent story, target list, path written, next number for future additions. Point the user at the file — that is where the task text is reviewed and edited before `/trello-card-push`.

## Card format

Lives with the writer, in [`../../../agents/trello-agent.md`](../../../agents/trello-agent.md) § Output — the subagent writes the plan file, so the format is documented there and not duplicated here.
