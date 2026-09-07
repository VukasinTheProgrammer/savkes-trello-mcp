---
name: trello-card-push
description: Read a task plan snapshot and create Trello cards from it. Use after trello-card-draft has drafted a plan file, to actually push those tasks as real Trello cards.
---

Read a task plan snapshot and create Trello cards from it.

## Usage
Call as: `/trello-card-push <topic>`
Example: `/trello-card-push playwright-tests`

Reads: `.claude/tasks/<topic>.md`

## Board ID reference
Label and list IDs are board constants shared across skills — resolve every label/list name against [`../../trello-mcp/trello-board-ids.md`](../../trello-mcp/trello-board-ids.md), not a copy kept here.

## How this runs

The main thread does **not** read the plan file and does **not** create cards. Card text would cross its context twice — once read, once re-emitted into `addCard` — for no benefit, since nothing after the push needs it. Spawn one `trello-push-agent` subagent instead:

> Follow `.claude/skills/trello-card-push/SKILL.md` for topic `<topic>` and return the final report.

Every step below is that subagent's spec — it reads this file itself, so nothing needs pasting into its prompt. The main thread only relays the report.

There is nothing to sync afterwards. No snapshot of the board is kept on disk, so creating cards leaves nothing stale behind. If the subagent dies without returning, treat it as a partial push: the `Pushed:` lines already in the plan file are authoritative, so re-running `/trello-card-push <topic>` resumes where it stopped and creates nothing twice.

## Steps

1. Read `.claude/tasks/<topic>.md`.
   - If `Status: pushed` — report "Already pushed. Edit status to re-push." and stop.
   - If `Status: draft` — scan every `## <number>. <Name>` section for a `Pushed: [<idShort>] <shortLink>` line. A section carrying one already exists on the board from a prior run — **never call `addCard` for it again.** This is how a re-run after a partial failure tells "already created" apart from "still needs creating" without guessing from the name.
   - If **every** section already has a `Pushed:` line: report "Already pushed, nothing to do." Update `Status: draft` → `pushed` and stop — no `findCards`, no `addCard`, no sync. This is the fully-recovered case: every card exists, only the status flip was left undone.
   - Otherwise proceed with the sections that lack a `Pushed:` line.

2. Parse the file:
   - Extract `Target list` → resolve to list ID using map above.
   - Extract any explicit `Parent:` line, if present — file-level header, or a per-group line above a set of sections. Format is `Parent: [idShort] <name>`; only the `[idShort]` matters, since name-matching no longer exists (step 2b resolves by number instead). An explicit line is optional and rare — it's a cross-tree override, not how parent linkage normally works.
   - For each `## <number>. <Name>` section **that lacks a `Pushed:` line** (step 1's scan), extract:
     - `name`: full heading text (e.g. `11.3.1. Test Login E2E`)
     - `Label IDs`: parse as comma-separated list
     - `parent`: any explicit `Parent:` in scope for this section (may be absent — that's the normal case)
     - `User Story` (story level) or `Description` (task level) → the opening of the `description` field, verbatim.
     - `Acceptance Criteria`: keep the `**Acceptance Criteria:**` heading and the bullets underneath it **exactly as written in the plan file** — leading `- ` intact, `**Given**`/`**When**`/`**Then**` markers intact. They go into the card description as markdown text, directly after the User Story / Description text. Trello renders the bold markers, so the card reads the same as the plan file.

       **Not a checklist.** Checklists were tried and dropped: tickable boxes turn every acceptance criterion into sprint bookkeeping nobody maintains, and the progress counter on the card face reads as work status when it is really a definition of done. `addChecklist` / `addChecklistItem` / `updateChecklistItem` / `getCardChecklists` stay on the MCP server for other uses — this skill just does not call them.

2b. **Parent linkage — derived from the card number, not a name lookup.** A card's parent is its own number with the last segment dropped: `0.3.21` → parent `0.3`; `0.3` → parent `0`. A single-segment number (`12`, or a bare `EPIC 12`) has no parent — it's top-level, and no attach is attempted for it; this is expected, not an error. This is the same rule `.claude/trello-mcp/src/utils/numbering.mjs`'s `cardNumber`/`parentNumber` helpers implement — keep both definitions in sync if either changes. Each child still gets both a clickable `Parent:` line in its description AND a real Trello attachment on the parent card — the attachment is what makes opening the parent show its children as card previews; the description line is what makes opening the child show where it came from.

   Extract a card's number the same way, in order:
   1. `^EPIC (\d+)\b` → that number (`EPIC 0. Feature Planning` → `0`)
   2. `^(\d+(?:\.\d+)*)\.?\s` → that number (`0.3.21. Repair the...` → `0.3.21`)
   3. Neither matches → the card has no number; it gets no automatic parent, and only an explicit `Parent:` line can attach it.

   Call `mcp__trello-board__findCards` **once** for the whole board — no `boardId` argument needed, it defaults to `TRELLO_BOARD_ID`. It returns `{idShort, shortLink, name, idList}` for every card, fields-filtered so it stays small even at ~250 cards. This replaces scanning `mcp__trello-board__getCardsByList` per list: that tool returns full unfiltered card objects and can exceed the output cap outright (`getMyCards` returned 369,976 characters).

   Build two lookups from the result: `idShort → card` (for an explicit override only) and `number → [cards]`, by applying the number extraction above to every card's `name`. There is no `name → [cards]` lookup anymore — nothing in this step matches by name.

   **Adopt orphans before creating anything.** Because step 3 marks a whole batch at once, a run that dies between the create message and the mark message leaves cards on the board that the plan file has no `Pushed:` line for — and step 1's scan would create them a second time. The `number → [cards]` lookup answers this for free, so use it: for every plan section still lacking a `Pushed:` line, look up **its own** number on the board.
   - Exactly one match **whose name also matches the plan section's name** → the card already exists from an earlier run. Write its `Pushed: [<idShort>] <shortLink>` line into the plan file now, drop it from the create set, and count it as **adopted** in the report: created by a previous run, marked by this one.
   - Exactly one match but **the names disagree** → the number now belongs to unrelated work and this plan is stale. **Do not adopt and do not create.** Report both names side by side and stop the run; the plan needs renumbering before any of it can be pushed. Compare the text after the number, trimmed and case-insensitive, and treat a shared prefix as a match — a card may have been lightly retitled on the board — but treat a different subject as a different card.
   - More than one match → do not guess and do not create. Report the ambiguous number and the colliding cards. A duplicate card on the board is worse than a card left unpushed.
   - No match → it genuinely needs creating; it stays in the create set.

   **The name check is the safeguard, not a nicety.** A number identifies a card only inside one plan's lineage, and only at one moment in time. A plan drafted weeks ago can have its numbers claimed by unrelated work since — a real case in this repo: `.claude/tasks/epic8.md` plans `8.1.1. Add Google OAuth config + dependency`, while the board's `8.1.1` is `Reuse centralized account locking mechanism`, under `EPIC 8. Refactor of Backend`. Number-only adoption would mark the Google card as pushed while having created nothing at all — a silent no-op that reads as success.

   An adopted card may have been created but never attached to its parent. Before attaching one, call `mcp__trello-board__listCardAttachments` once on that parent and skip the attach if the child's `shortLink` is already there — attaching twice leaves two previews of the same child. This check belongs to the adoption path only; a card created this run has no prior attachment to collide with.

   An adopted card needs no other repair. Its description was written in full by `addCard`, so a card that exists at all has its Acceptance Criteria — there is no second write that can be missing.

   For each card in the plan:
   - Compute its own number and that number's parent number. No parent number (top-level) → skip linkage entirely for this card, no attach attempted.
   - Otherwise look up the parent number in the board lookup:
     - Exactly one match → that card is the number-derived parent.
     - Zero matches → unresolved; warn in the report which parent number was missing. Never block card creation.
     - More than one match → do not guess; unresolved; warn in the report which number was ambiguous and name the colliding cards.
   - If the section (or file/group header) also carries an explicit `Parent:` line, resolve its `[idShort]` via the `idShort → card` lookup. If it resolves to a **different** card than the number-derived parent, **the explicit line wins** — use it, and report the mismatch (number vs. explicit) so it's visible rather than silently overridden. If only one of the two resolved, use whichever did.
   - Cache each board-side lookup result by parent number, so a parent number shared by several cards in the plan is resolved once, not once per child.

3. **Create the cards in batches of five, two messages per batch.** The cards are independent of each other — every parent was resolved in step 2b, before anything was created — so serialising them buys nothing. One card at a time costs three round trips per card; batching costs two messages per five.

   Build each card's full `description` first — User Story or Description text, then the Acceptance Criteria block verbatim from the plan, then the parent link as the last line, omitted when no parent resolved:
   ```
   <description from step 2>

   **Acceptance Criteria:**
   - **Given** <precondition>. **When** <action>. **Then** <expected behavior>.
   - ...

   Parent: <parent shortUrl>
   ```

   That is the whole card. One `addCard` call writes name, labels and every word of the body, so there is no second write that can half-land.

   Then, per batch of five:

   **Message A — the batch's five `mcp__trello-board__addCard` calls, all in one message.** Each with:
   - `name`: task name
   - `listId`: resolved list ID
   - `description`: formatted description + AC + Parent link
   - `labels`: array of label IDs

   Those two names are the tool's own argument names, **not** Trello's REST field names — `mcp__trello-board__addCard` translates to the REST spelling internally. Its zod schema strips unknown keys silently, so a call written with the REST names raises no error and creates the card with an empty description and no labels. Use only `description` and `labels`.

   **Message B — one message holding both of the following, for that same batch:**
   - `mcp__trello-board__attachCard({ cardId: <parent>, attachCardId: <new card id> })` for every card that passes **both** filters below — child attached to parent, not the reverse, so opening the parent renders each child as a card preview.
   - One `Edit` writing `Pushed: [<idShort>] <shortLink>` for every card whose `addCard` returned an id, each as a new line directly under that card's `## <number>. <Name>` heading, before its `Labels:` line.

   Both share a message because neither depends on the other — each needs only what message A returned. That puts the durable record one message behind creation, the smallest window the protocol allows.

   **Build the attach group from message A's results, never from the plan.** A card is in it only if **(a)** its `addCard` returned an id **and (b)** a parent resolved for it in step 2b. A card whose `addCard` failed has no id to attach; including it produces an `attachCard` error that reads like a linkage bug and hides the real creation failure. A card with no parent has nothing to attach to — skip it silently, that is the normal top-level case, not an error.

   A card whose `addCard` failed gets no attach and no `Pushed:` line, so it stays eligible on the next run. Name it and its error in the report, and keep going with the rest of the batch and the remaining batches — one failed card never stops the push.

   **Why five, not all of them at once.** The batch is the crash window: anything created in message A but not yet marked in message B is unmarked if the run dies between the two, and step 2b's adoption pass is what recovers it. Five keeps that pass small and its report readable. It is also the only crash window — a card's whole body lands in message A, so a card that exists is never half-written.

   **Why not a per-card pipeline.** Starting card 1's attach while card 3's `addCard` is still in flight is not expressible here. Tool calls inside one message run concurrently, but the model regains control only once *every* result in that message has returned, so a dependent call cannot be emitted mid-flight. Per-item pipelining is a `Workflow` primitive, not something a plain agent's tool calls can do — batch-then-attach is the real choice, and the batch size is the only knob.

3b. **Put the new cards in hierarchy order.** A new card lands at the bottom of its list; the Backlog reads epic -> its stories -> each story's tasks -> `---` -> next epic. Two cases, and only one needs work:

   **Story or task plans** — every card has a parent number, so after each batch's message B, call once:

   ```
   mcp__trello-board__placeCards({
     listId,
     underNumber: "<the plan's Prefix>",
     cardIds: [<ids addCard returned, in plan order>],
   })
   ```

   `underNumber` is the plan file's `Prefix` — the parent everything in the file hangs under (`2.1` for tasks under that story, `3` for stories under that epic). `cardIds` are the ids `addCard` returned in message A, in the order the sections appear in the plan.

   It places them directly after the last card of that parent's subtree. Cards created by an earlier batch are already in the subtree, so the next batch lands after them with no bookkeeping. Put this call in message B alongside the attaches and the `Pushed:` edit — it depends only on what message A returned, so it costs no extra round trip.

   **Read its `failed` list, not just its error.** `placeCards` returns `{ placed, failed, anchor }` and moves each card independently — a card Trello rejects lands in `failed` while the rest still move, so a call that "succeeded" can still have left cards where they were. Report `failed` entries by name. If the whole call errors, the cards are still created and still marked: report it and continue. Wrong order is a nuisance; a lost card is not.

   **Epic plans** — no `placeCards` call needed. A whole epic block belongs at the end of the list, which is where new cards go by default. Instead keep the separator invariant: **immediately before creating each epic card, create a card named exactly `---`** in the same list, with no labels and no description. One separator between blocks, none leading, none trailing.

   Check the list's **current last card** each time, and skip the separator when the list is empty or that last card is already a separator. That check is what makes a re-run safe: sections already carrying a `Pushed:` line are skipped entirely, so their separators are never re-created, and an epic created just before a crash leaves the list ending on an epic card — exactly the state that should get a separator before the next one. Separators are not plan sections and never get a `Pushed:` line; the list itself is their record.

4. Update the plan file's status: `Status: draft` → `Status: pushed` only if **every** card section now carries a `Pushed:` line — the ones that already had one from a prior run, plus every one that succeeded this run. If even one card lacks a `Pushed:` line (this run's failure, or a card that has now failed across multiple runs), leave `Status: draft` so the plan is never silently abandoned.

5. Report, with each outcome counted and named separately:
   - **Created this run**: N cards, the list they landed in.
   - **Skipped**: N cards that already carried a `Pushed:` line from a prior run — not touched, not duplicated.
   - **Adopted**: N cards found on the board by number in step 2b and marked this run — created by an earlier run that died before marking them. Name each one, so a crash that happened silently becomes visible.
   - **Attached / not attached**: N children linked to their parent; name any card kept despite a failed `attachCard`, and any whose parent number was unresolved or ambiguous.
   - **Acceptance Criteria**: confirm the bullets went into each card's description as markdown; name any card whose plan section had no AC block at all.
   - **Placement**: the card each batch was placed after, or the `placeCards` error if it failed. For epic plans, whether a `---` separator was created.
   - **Still failing**: N cards, named individually with their error, that lack a `Pushed:` line after this run.

## Error handling
- Unknown label name → skip that label, warn in report.
- Parent number matches no card on the board → create the card without the `Parent:` link and without an attachment; report names the missing parent number. Never block card creation on an unresolved parent.
- Parent number matches more than one card → do not guess; create the card without the `Parent:` link and without an attachment; report names the ambiguous number and the colliding cards.
- Explicit `Parent:` line disagrees with the number-derived parent → the explicit line wins (it's used for the description link and the attachment); report the mismatch so it's visible, not silent.
- `mcp__trello-board__addCard` failure → log the card name and error, write no `Pushed:` line for it, continue with remaining cards. Do NOT mark the plan as pushed while any section still lacks a `Pushed:` line.
- `mcp__trello-board__attachCard` failure → the card was already created by `addCard`, so keep it and still write its `Pushed:` line; log the card name and the attach error, name it in the report, and continue to the next card. This does not count as a card-creation failure — it does not block the status flip to `pushed`.
- A card already carrying a `Pushed:` line → never call `addCard` or `attachCard` for it again, on any run. Count it as skipped, not created.
- `placeCards` fails, or finds no card under the parent number → the cards exist and are marked; leave them where they are and report it. Never re-create a card to fix its position. Re-running `placeCards` with the same arguments is safe once the parent is sorted out.
- `placeCards` returns a non-empty `failed` while `placed` also has entries → a partial reorder. The cards in `failed` are still in the list, just not moved. Name them; re-running with only those ids is safe.
- `addCard` fails for one card inside a batch → that card is excluded from message B entirely: no attach (no id to attach), no `Pushed:` line (nothing durable to record). The batch's other four proceed untouched.
- Run dies between a batch's message A and message B → cards exist on the board with no `Pushed:` line. Step 2b's adoption pass finds them by number on the next run, marks them, and does not re-create them. This is the one failure this batching introduces, and adoption is what pays for it.
- Adopted card whose parent already lists it as an attachment → skip the attach; `listCardAttachments` on the parent is the check. Attaching twice leaves two previews of the same child.
- Plan card's own number matches more than one card on the board in step 2b → do not create and do not adopt. Report the ambiguity; a duplicate card is worse than an unpushed one.
- Plan card's number matches exactly one board card but the **names disagree** → stale plan. Stop the whole run, report both names, push nothing. The plan's numbers belong to other work now, so every later section is suspect for the same reason. Renumber the plan — re-run `/trello-card-draft`, or edit the numbers by hand against a fresh `mcp__trello-board__nextCardNumbers` — before pushing again.
- Push subagent dies mid-run (no report returned) → partial push. The plan file's `Pushed:` lines are the record; re-run `/trello-card-push <topic>` to finish. Anything created but unmarked is recovered by step 2b's adoption pass.
