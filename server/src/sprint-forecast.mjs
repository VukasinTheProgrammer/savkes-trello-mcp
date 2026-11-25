// Sprint forecasting: parse per-card estimates and work out when the remaining work will
// be finished. Pure functions, no network.
//
// People work in parallel, so the finish time is set by the busiest person, not by the sum
// of all tasks. Example: A has 2 h + 3 h, B has 1 h + 1 h, C has 2 h + 2 h. That is 11 h
// of work, but A finishes last after 5 h, so the whole set is done in about 5 hours.
// Cards with an estimate but nobody assigned are handed to whoever is free first, and
// cards with no estimate are reported on top, because their time is unknown.
import { asArray } from './utils/arrays.mjs';

// Estimate format on a card: "Estimated hours: 2" or "[estimate: 2h]".
export function estimatedHours(card) {
  const description = String(card?.desc || '');
  const match = description.match(/(?:\[estimate\s*:\s*|estimated?\s+(?:working\s+)?(?:hours?|time)\s*:\s*)(\d+(?:\.\d+)?)\s*(?:h(?:ours?)?)?\]?/i);
  if (!match) return null;
  const hours = Number(match[1]);
  return Number.isFinite(hours) && hours > 0 && hours <= 10000 ? hours : null;
}

const round2 = n => Number(n.toFixed(2));

/**
 * Hours of estimated work per person, and when everything would be finished if people
 * work in parallel.
 *
 * - A card shared by several members splits its hours evenly between them.
 * - Estimated cards with nobody assigned go, largest first, to whoever has the least work
 *   (including idle developers when `developers` is larger than the number of assignees).
 * - Cards without an estimate are counted in `missingEstimates`; they are not in the hours.
 */
export function workloadByMember(cards, { developers, memberNames = {} } = {}) {
  const perMember = new Map();
  const unassignedCards = [];
  let missingEstimates = 0;

  for (const card of asArray(cards)) {
    const hours = estimatedHours(card);
    if (hours === null) { missingEstimates++; continue; }
    const members = asArray(card.idMembers);
    if (!members.length) { unassignedCards.push(hours); continue; }
    for (const memberId of members) {
      const entry = perMember.get(memberId) ?? { hours: 0, cards: 0 };
      entry.hours += hours / members.length;
      entry.cards += 1;
      perMember.set(memberId, entry);
    }
  }

  const members = [...perMember]
    .map(([memberId, { hours, cards }]) => ({ memberId, name: memberNames[memberId] || memberId, hours: round2(hours), cards }))
    .sort((a, b) => b.hours - a.hours || a.memberId.localeCompare(b.memberId));

  // People available for the unassigned cards: everyone who already has work, plus idle
  // developers if the team is bigger. With no information at all, assume one person.
  const headcount = Number(developers);
  const idle = Number.isInteger(headcount) && headcount > members.length ? headcount - members.length : 0;
  const loads = [...members.map(m => m.hours), ...Array(idle).fill(0)];
  if (!loads.length) loads.push(0);
  for (const hours of [...unassignedCards].sort((a, b) => b - a)) {
    let least = 0;
    for (let i = 1; i < loads.length; i++) if (loads[i] < loads[least]) least = i;
    loads[least] += hours;
  }

  return {
    members,
    busiestMemberHours: members[0]?.hours ?? 0,
    unassignedHours: round2(unassignedCards.reduce((sum, h) => sum + h, 0)),
    unassignedCards: unassignedCards.length,
    finishHours: round2(Math.max(...loads)),
    missingEstimates
  };
}

// Weekdays from `start` (inclusive) that are needed to fit `days` working days.
function addWorkingDays(start, days) {
  const date = new Date(start);
  let left = days;
  while (left > 0) {
    if (date.getDay() !== 0 && date.getDay() !== 6) left--;
    if (left > 0) date.setDate(date.getDate() + 1);
  }
  return date;
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function forecastSprint(cards, { developers, hoursPerDay, sprintEnd, memberNames, now = new Date() } = {}) {
  const items = asArray(cards);
  const known = items.map(estimatedHours).filter(h => h !== null);
  const remainingHours = round2(known.reduce((sum, h) => sum + h, 0));
  const workload = workloadByMember(items, { developers, memberNames });
  const { missingEstimates } = workload;
  const base = { remainingHours, ...workload, estimatedCards: known.length, totalActiveCards: items.length };
  const missingNote = missingEstimates ? ` Plus ${missingEstimates} card${missingEstimates === 1 ? '' : 's'} with no estimate, which will add to this.` : '';

  const headcount = Number(developers);
  const dailyHours = Number(hoursPerDay);
  const validHours = Number.isFinite(dailyHours) && dailyHours > 0 && dailyHours <= 24;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Finish date only needs hours per day; it is useful even without a sprint end date.
  let finish = {};
  if (validHours && workload.finishHours > 0) {
    const finishWorkingDays = Math.ceil(workload.finishHours / dailyHours);
    finish = { finishWorkingDays, estimatedFinishDate: isoDay(addWorkingDays(today, finishWorkingDays)) };
  }
  const finishText = `All estimated work can be done in about ${workload.finishHours} h when people work in parallel` +
    (finish.estimatedFinishDate ? ` (around ${finish.estimatedFinishDate})` : '') + '.';

  const end = sprintEnd ? new Date(`${sprintEnd}T23:59:59`) : null;
  const validConfig = Number.isInteger(headcount) && headcount > 0 && validHours && end && !Number.isNaN(end.getTime());
  if (!validConfig) {
    return { status: 'not_configured', ...base, ...finish, message: `${finishText}${missingNote} Set SPRINT_END (YYYY-MM-DD), SPRINT_DEVELOPERS and SPRINT_HOURS_PER_DAY to compare it with the sprint.` };
  }

  let workingDays = 0;
  for (const day = new Date(today); day <= end; day.setDate(day.getDate() + 1)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) workingDays++;
  }
  const capacityHours = round2(workingDays * headcount * dailyHours);
  const shortfallHours = round2(Math.max(0, remainingHours - capacityHours));
  // Per-person check: the busiest person must also finish before the sprint ends.
  const memberCapacityHours = round2(workingDays * dailyHours);
  const busiestShortfallHours = round2(Math.max(0, workload.finishHours - memberCapacityHours));
  const atRisk = shortfallHours > 0 || busiestShortfallHours > 0;
  const status = missingEstimates ? 'incomplete_estimates' : atRisk ? 'at_risk' : 'on_track';
  const verdict = shortfallHours ? ' The team does not have enough hours before the sprint ends.'
    : busiestShortfallHours ? ' The busiest person has more work than they can finish before the sprint ends.'
    : ' This fits before the sprint ends.';
  return {
    status, ...base, ...finish, memberCapacityHours, busiestShortfallHours, capacityHours, shortfallHours,
    workingDays, developers: headcount, hoursPerDay: dailyHours, sprintEnd,
    message: finishText + verdict + missingNote
  };
}

/** Sprint settings from the environment (used by the dashboard and the MCP tools). */
export function sprintConfigFromEnv(env = process.env) {
  return { sprintEnd: env.SPRINT_END, developers: env.SPRINT_DEVELOPERS, hoursPerDay: env.SPRINT_HOURS_PER_DAY };
}
