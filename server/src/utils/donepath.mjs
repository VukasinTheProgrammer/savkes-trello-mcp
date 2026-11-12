// How did the cards in Done get there? Pure, like outcome.mjs: cards and their list moves
// in, plain data and strings out, no network.
//
// Trello only says where a card sits. Its history says how it travelled: through
// In Progress and a review list, or straight to Done; alone, or in a batch with others.
// Each of those is a reason to look at a card, never a verdict: logging finished work
// afterwards, or moving a sprint's cards together at the end, is sometimes the right thing.
//
// Nothing here names a person. The mover and the card's members are compared inside this
// file and leave it only as counts.

import { cap, doneListTest, mdText, more, percentOf } from "./rollup.mjs";

const BURST_MINUTES = 5;
const DEFAULT_PROGRESS = ["In Progress"];
const DEFAULT_REVIEW = ["Testing/Review", "Testing", "Review", "QA"];

// `cards`: [{ id, name, listName, idMembers }], where listName is the list the card sits in now.
// `events`: [{ cardId, at, from, to, by }], one per list move or creation (from is null for a
// creation), `by` the member id of whoever did it, or null when the history did not say.
// Only cards that sit in a Done list are judged.
export function buildDonePathAudit({
  cards,
  events,
  doneLists,
  progressLists = DEFAULT_PROGRESS,
  reviewLists = DEFAULT_REVIEW,
  burstSize = 5,
}) {
  const isDone = doneListTest(doneLists);
  const isProgress = doneListTest(progressLists);
  const isReview = doneListTest(reviewLists);

  const doneCards = cards.filter((c) => isDone(c.listName));
  const doneById = new Map(doneCards.map((c) => [c.id, c]));
  const byCard = new Map();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!doneById.has(e.cardId)) continue;
    if (!byCard.has(e.cardId)) byCard.set(e.cardId, []);
    byCard.get(e.cardId).push(e);
  }

  let noHistory = 0;
  let createdInDone = 0;
  let skippedProgress = 0;
  let skippedReview = 0;
  const skippedBoth = [];
  const doneMoves = []; // the move that put each card into Done, with the card it was for

  for (const card of doneCards) {
    const history = byCard.get(card.id);
    if (!history) {
      noHistory++;
      continue;
    }
    const intoDone = history.filter((e) => e.from !== null && !isDone(e.from) && isDone(e.to));
    for (const e of intoDone) doneMoves.push({ ...e, card });
    if (history[0].from === null && isDone(history[0].to)) {
      createdInDone++;
      continue;
    }
    const visited = history.flatMap((e) => [e.from, e.to]).filter(Boolean);
    const progress = visited.some(isProgress);
    const review = visited.some(isReview);
    if (!progress) skippedProgress++;
    if (!review) skippedReview++;
    if (!progress && !review) skippedBoth.push({ name: card.name });
  }

  // A burst is burstSize or more cards put into Done by the same member, each within
  // BURST_MINUTES of the one before. Moves whose mover is unknown cannot be grouped.
  const byMover = new Map();
  for (const m of doneMoves) {
    if (!m.by) continue;
    if (!byMover.has(m.by)) byMover.set(m.by, []);
    byMover.get(m.by).push(m);
  }
  const bursts = [];
  for (const moves of byMover.values()) {
    moves.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let run = [];
    for (const m of moves) {
      const last = run.at(-1);
      if (last && Date.parse(m.at) - Date.parse(last.at) > BURST_MINUTES * 60_000) {
        if (run.length >= burstSize) bursts.push(run);
        run = [];
      }
      run.push(m);
    }
    if (run.length >= burstSize) bursts.push(run);
  }
  const burstCards = bursts.reduce((n, run) => n + run.length, 0);

  // The newest move into Done for each card, and whether its mover is one of the card's
  // members today (members change, so this is a hint, not a fact).
  const latest = new Map();
  for (const m of doneMoves) {
    if (!m.by) continue;
    const prev = latest.get(m.card.id);
    if (!prev || Date.parse(m.at) >= Date.parse(prev.at)) latest.set(m.card.id, m);
  }
  const ownMoves = [...latest.values()].filter((m) => (m.card.idMembers ?? []).includes(m.by)).length;

  return {
    doneCards: doneCards.length,
    noHistory,
    createdInDone,
    skipped: { progress: skippedProgress, review: skippedReview, both: cap(skippedBoth) },
    doneMoves: doneMoves.length,
    bursts: {
      count: bursts.length,
      cards: burstCards,
      largest: Math.max(0, ...bursts.map((run) => run.length)),
      percent: percentOf(burstCards, doneMoves.length),
    },
    movedByAssignee: { count: ownMoves, of: latest.size },
    settings: { burstSize, burstMinutes: BURST_MINUTES, progressLists, reviewLists },
  };
}

export function renderDonePathAudit(boardName, audit, { now = Date.now() } = {}) {
  const { doneCards, noHistory, createdInDone, skipped, doneMoves, bursts, movedByAssignee, settings } = audit;
  const out = [`# Done-path audit: ${boardName}`, `_${new Date(now).toISOString().slice(0, 10)}_`, ""];
  out.push(`**${doneCards} ${doneCards === 1 ? "card sits" : "cards sit"} in Done.** Here is how they got there.`, "");

  out.push("## Stages skipped");
  out.push(`- ${skipped.progress} never sat in a progress list (${settings.progressLists.map(mdText).join(", ")}).`);
  out.push(`- ${skipped.review} never sat in a review list (${settings.reviewLists.map(mdText).join(", ")}).`);
  if (skipped.both.count) {
    out.push(`- ${skipped.both.count} skipped both: ${skipped.both.items.map((c) => mdText(c.name)).join("; ")}${more(skipped.both)}.`);
  }
  if (createdInDone) out.push(`- ${createdInDone} were created straight in Done (written down afterwards), so no stage is counted as skipped.`);
  if (noHistory) out.push(`- ${noHistory} have no history to read and are not judged.`);
  out.push("");

  out.push("## Batches");
  if (bursts.count) {
    out.push(
      `- ${bursts.count} ${bursts.count === 1 ? "batch" : "batches"} of ${settings.burstSize} or more cards moved into Done by the same member within ${settings.burstMinutes} minutes of each other: ` +
        `${bursts.cards} cards, ${bursts.percent}% of the ${doneMoves} moves into Done, the largest ${bursts.largest}.`,
    );
  } else {
    out.push(`No batch of ${settings.burstSize} or more cards moved into Done within ${settings.burstMinutes} minutes.`);
  }
  out.push("");

  out.push("## Who moved it");
  out.push(
    movedByAssignee.of
      ? `- ${movedByAssignee.count} of ${movedByAssignee.of} cards were moved into Done by someone who is a member of the card now. Members are today's, so this is a hint.`
      : "No mover was recorded, so this is not shown.",
    "",
    "## How to read this",
    "This is a list of cards worth a look, not a verdict. Skipping a stage or moving cards together is sometimes right, for example when finished work is written down afterwards. Only Trello is read and no member is named.",
  );
  return out.join("\n").trimEnd();
}
