// Card numbering: parse a card's hierarchy number out of its name, and answer what
// number the next card gets.
//
// Pure: no network, no filesystem, no MCP protocol. Everything here is a function of
// its arguments, which is what lets the selftest cover it without credentials.
//
// These live here rather than beside auditHierarchy, which imports them back. Keeping
// them out of the entry keeps the dependency one-way (entry -> this module); the other
// direction would be an import cycle.
//
// Was snapshot.mjs until the snapshot files were deleted. Nothing renders here now —
// numbering is the whole job, and the name says so.

// Hierarchy lives in the card name, not in a separate graph: "1" is an epic,
// "1.1" a story under it, "1.1.2" a task under that. Parent = drop the last
// segment. Keep these two in sync with the same rule in the trello skills.
export const cardNumber = (name) => {
  const epic = /^EPIC (\d+)\b/.exec(String(name ?? ""));
  if (epic) return epic[1];
  const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(String(name ?? ""));
  return m ? m[1] : null;
};
export const parentNumber = (n) => {
  const parts = String(n ?? "").split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : null;
};

// The question this module exists to answer: the number the next card gets, read off card
// names rather than off the link graph — the number is what the planning skills key
// on, and the two can disagree.
//
// max + 1, never first-gap: if 11.3.2 was archived, 11.3.2 stays retired instead of
// being handed to an unrelated new card and colliding with it in git history and in
// anyone's memory of the board.
//
// That guarantee is only as good as `cards`. Pass every card the board has ever had,
// archived ones included — Trello's card endpoints default to `visible`, which hides
// them, and a hidden number is a reissued number. nextCardNumbers asks for
// `filter: "all"` precisely for this.
//
// `under` names the parent prefixes to answer for. It's opt-in because answering for
// every prefix on the board would return a ~100-entry map on a board this size, and
// a planning run cares about exactly one parent.
export function nextNumbers(cards, under = []) {
  const numberOf = (list) => new Set(list.map((c) => cardNumber(c.name)).filter(Boolean));
  // Two sets, two different jobs. `live` decides how far the sequence has got —
  // archived cards must not push it forward, or one scratch card archived at 88 makes
  // the next epic 89 and burns 13..88 forever. `every` decides what is unavailable —
  // an archived number is spent, and handing it to unrelated work collides with it in
  // git history and in everyone's memory of the board.
  //
  // Cards with no `closed` field count as live, so callers that never fetched it (and
  // the unit tests) keep the plain max + 1 behaviour.
  const live = numberOf(cards.filter((c) => !c.closed));
  const every = numberOf(cards);
  const prefixes = Array.isArray(under) ? under : [under];

  // Direct children only: with prefix "11.3", "11.3.4" counts and "11.3.4.1" does
  // not. The trailing dot in `head` is what keeps "11.30" from matching "11.3".
  const maxLiveChildOf = (head) => {
    let max = 0;
    for (const n of live) {
      if (!n.startsWith(head)) continue;
      const rest = n.slice(head.length);
      if (rest === "" || rest.includes(".")) continue;
      max = Math.max(max, Number(rest));
    }
    return max;
  };

  // Step past anything already spent, however it was spent. Only archived numbers can
  // sit above the live max, so this advances at most a handful of times.
  const nextFree = (prefix) => {
    const head = prefix === null ? "" : `${prefix}.`;
    let n = maxLiveChildOf(head) + 1;
    while (every.has(`${head}${n}`)) n += 1;
    return `${head}${n}`;
  };

  const nextUnder = {};
  for (const prefix of prefixes) {
    nextUnder[prefix] = {
      next: nextFree(prefix),
      // A typo'd prefix ("11.33") otherwise returns a confident "11.33.1" that
      // parents nothing. Archived parents read as false too — you cannot hang new
      // work off a card that is no longer on the board.
      parentExists: live.has(prefix),
    };
  }

  // Epics are the depth-1 numbers, so they're just children of the empty prefix.
  return { nextEpic: nextFree(null), nextUnder };
}

// --- Placement -------------------------------------------------------------
//
// The board keeps one shape in Backlog: an epic, then its stories, each story
// followed by its own tasks, then a "---" card before the next epic. New cards
// have to land inside that shape, not at the bottom of the list.

// Does `number` sit under `parent` — the parent itself, or anything below it?
// "2.1" is under "2"; "2.10" is not under "2.1"; "2" is not under "2.1".
export const belongsUnder = (number, parent) =>
  number === parent || (number ?? "").startsWith(`${parent}.`);

// The card a new child should follow: the last card of the parent's subtree, in
// list order. Falls back to the parent card itself when it has no children yet.
// `next` is whatever currently follows that card — the far edge of the gap the
// new cards have to fit into, or null at the end of the list.
//
// `exclude` holds the cards being placed. They matter because Trello has already
// put them somewhere — a new card lands at the bottom of the list — so they are
// in `cards`, they are in the subtree by number, and they sort last. Leave them in
// and every one of them outranks the real anchor: the batch anchors on its own
// tail at the bottom of the list and placement silently does nothing.
//
// Matched on `id` OR `shortLink` because both identify a card and callers hold
// either: `addCard` hands back both, and the plan files record shortLinks. Keying
// this on `id` alone made a shortLink caller a silent no-op — the exact failure the
// paragraph above describes, reached by passing the other valid spelling.
export function insertionSlot(cards, underNumber, exclude = new Set()) {
  const ordered = [...cards]
    .filter((c) => !exclude.has(c.id) && !exclude.has(c.shortLink))
    .sort((a, b) => a.pos - b.pos);
  let anchorIdx = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (belongsUnder(cardNumber(ordered[i].name), underNumber)) anchorIdx = i;
  }
  if (anchorIdx === -1) return { anchor: null, next: null };
  return { anchor: ordered[anchorIdx], next: ordered[anchorIdx + 1] ?? null };
}

// Evenly space `count` new positions strictly between two existing ones. With no
// card after the anchor there is nothing to stay above, so walk past it instead.
//
// ponytail: plain midpoints, no renormalisation. Real board spacing is 512+ and
// Trello renumbers a list itself when positions get too tight; if that ever stops
// being true the fix is a renormalise call, not cleverer arithmetic here.
export function spreadPositions(anchorPos, nextPos, count) {
  const start = anchorPos ?? 0;
  const append = () => Array.from({ length: count }, (_, i) => start + 1024 * (i + 1));
  if (nextPos == null) return append();

  // No gap to divide. Two cards sharing a pos is ordinary on a Trello list — a bulk
  // move, a copied list, an import — and insertionSlot sorts by pos, so it hands back
  // an equal-valued pair whenever one exists. Divided anyway, every card in the batch
  // gets the anchor's exact position: placeCards reports success with an empty
  // `failed`, and Trello orders them however it likes. That is the same silent no-op
  // the `exclude` set exists to prevent, reached from the other side.
  //
  // Appending past `next` is wrong in a visible way, which is the point — the cards
  // are in the right order relative to each other and someone can see they overshot.
  const gap = (nextPos - start) / (count + 1);
  if (gap <= 0) return append();

  return Array.from({ length: count }, (_, i) => start + gap * (i + 1));
}
