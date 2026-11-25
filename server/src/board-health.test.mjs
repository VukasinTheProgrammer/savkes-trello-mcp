import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBoard, summarizeBoard, countWeeklyCompletions, estimatedHours, forecastSprint } from './board-health.mjs';
import * as sprint from './sprint-forecast.mjs';
import { TOOLS } from './tools/board-health.mjs';
const lists = [{id:'todo',name:'To Do'},{id:'done',name:'Done'}];
const now = new Date('2026-11-14T12:00:00Z');
const analyze = (cards, extras={}) => analyzeBoard({boardId:'b',lists,cards,now,...extras});
test('empty board has no false health score or invalid numbers',()=>{const a=analyze([]);assert.equal(a.metrics.totalCards,0);assert.equal(a.metrics.healthScore,null);assert.equal(a.metrics.completionPercentage,0);});
test('completed, overdue, upcoming, blocked, unassigned and workload',()=>{const a=analyze([{id:'1',name:'Done',idList:'done',idMembers:['a']},{id:'2',name:'Blocked: review',idList:'todo',due:'2026-11-12',idMembers:['a']},{id:'3',name:'Next',idList:'todo',due:'2026-11-17',idMembers:[]}]);assert.equal(a.metrics.completedCards,1);assert.equal(a.metrics.overdueCards,1);assert.equal(a.metrics.upcomingDeadlines,1);assert.equal(a.metrics.blockedCards,1);assert.equal(a.metrics.unassignedCards,1);assert.deepEqual(a.workloadDistribution,[{memberId:'a',cardCount:1}]);assert.match(summarizeBoard(a).summary,/1\/3/);});
test('no due date is not automatically blocked',()=>{assert.equal(analyze([{id:'1',name:'Normal',idList:'todo'}]).metrics.blockedCards,0);});
test('custom done list and archived exclusion',()=>{const a=analyze([{id:'1',idList:'qa'},{id:'2',idList:'todo',closed:true}],{lists:[...lists,{id:'qa',name:'Shipped'}],completedListNames:'Shipped'});assert.equal(a.metrics.completedCards,1);assert.equal(a.metrics.totalCards,1);});
test('history optional, weekly throughput distinct card moves',()=>{const action={type:'updateCard',date:'2026-11-13T12:00:00Z',data:{card:{id:'c1'},listBefore:{id:'todo'},listAfter:{id:'done'}}};assert.equal(analyze([]).metrics.weeklyThroughput,null);assert.equal(analyze([],{historyAvailable:true,actions:[action,action]}).metrics.weeklyThroughput,1);});
test('MCP tools expose read-only schemas',()=>{for(const key of ['analyzeBoardHealth','getBoardSummary']){assert.equal(TOOLS[key].annotations.readOnlyHint,true);assert.equal(typeof TOOLS[key].run,'function');}});
test('forecast helpers live in sprint-forecast.mjs and are still re-exported',()=>{assert.equal(estimatedHours,sprint.estimatedHours);assert.equal(forecastSprint,sprint.forecastSprint);assert.equal(estimatedHours({desc:'Estimated hours: 2'}),2);});
test('countWeeklyCompletions ignores old, invalid and non-done moves',()=>{const isDoneList=l=>l?.id==='done';const mk=(date,id,to='done')=>({date,data:{card:{id},listAfter:{id:to}}});const acts=[mk('2026-11-13T12:00:00Z','a'),mk('2026-11-13T13:00:00Z','a'),mk('2026-11-01T00:00:00Z','old'),mk('garbage','bad'),mk(undefined,'nodate'),mk('2026-11-13T12:00:00Z','b','todo'),mk('2026-11-14T11:00:00Z','c')];assert.equal(countWeeklyCompletions(acts,{now,isDoneList}),2);assert.equal(countWeeklyCompletions(undefined,{now,isDoneList}),0);});
test('recommendations list risks in order, with a calm fallback',()=>{const risky=analyze([{id:'1',name:'blocked',idList:'todo',due:'2026-11-01',idMembers:[]}]).recommendations;assert.deepEqual(risky.map(r=>r.split(' ')[0]),['Unblock','Review','Assign','Review']);assert.deepEqual(analyze([]).recommendations,['No immediate board risks detected.']);});

// Review example: three people working in parallel. A: 2 h + 3 h, B: 1 h + 1 h,
// C: 2 h + 2 h. 11 h of work in total, but everything is done after A's 5 h.
// Two cards have no estimate and are reported on top.
const est = (h, ...idMembers) => ({ desc: `Estimated hours: ${h}`, idMembers });
const reviewCards = [est(2, 'A'), est(3, 'A'), est(1, 'B'), est(1, 'B'), est(2, 'C'), est(2, 'C'), { desc: '', idMembers: ['A'] }, { desc: '', idMembers: [] }];

test('parallel work: finish time is the busiest person, not the sum', () => {
  const w = sprint.workloadByMember(reviewCards, { memberNames: { A: 'Amra' } });
  assert.equal(w.finishHours, 5);
  assert.equal(w.missingEstimates, 2);
  assert.deepEqual(w.members.map(m => [m.name, m.hours]), [['Amra', 5], ['C', 4], ['B', 2]]);
  const f = sprint.forecastSprint(reviewCards, { hoursPerDay: 6, now: new Date('2026-11-25T10:00:00') });
  assert.equal(f.remainingHours, 11);
  assert.equal(f.finishHours, 5);
  assert.equal(f.estimatedFinishDate, '2026-11-25');
  assert.match(f.message, /about 5 h/);
  assert.match(f.message, /Plus 2 cards with no estimate/);
});

test('unassigned estimated cards go to whoever is free first, including idle developers', () => {
  const cards = [est(4, 'A'), est(1, 'B'), est(3), est(2)];
  // A=4, B=1 → 3 h goes to B (4), 2 h goes to A or B → finish 6
  assert.equal(sprint.workloadByMember(cards).finishHours, 6);
  // With a third, idle developer the 3 h goes to them → finish 4
  assert.equal(sprint.workloadByMember(cards, { developers: 3 }).finishHours, 4);
  // Nobody assigned and no team size: one person does it all
  assert.equal(sprint.workloadByMember([est(2), est(3)]).finishHours, 5);
});

test('sprint is at risk when the busiest person cannot finish, even if total capacity fits', () => {
  // Wed 2026-11-25 to Thu 2026-11-26 = 2 working days, 3 devs × 4 h = 24 h capacity.
  const f = sprint.forecastSprint([est(10, 'A'), est(1, 'B')], { developers: 3, hoursPerDay: 4, sprintEnd: '2026-11-26', now: new Date('2026-11-25T09:00:00') });
  assert.equal(f.capacityHours, 24);
  assert.equal(f.shortfallHours, 0);
  assert.equal(f.busiestShortfallHours, 2);
  assert.equal(f.status, 'at_risk');
  assert.equal(f.finishWorkingDays, 3);
  assert.equal(f.estimatedFinishDate, '2026-11-27');
});
