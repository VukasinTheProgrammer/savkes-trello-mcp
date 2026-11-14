import { resolveBoard, trello } from '../trello/client.mjs';
import { analyzeBoard, summarizeBoard } from '../board-health.mjs';

export async function fetchBoardHealth({ boardId, completedListNames, includeHistory = false } = {}) {
  const id = resolveBoard(boardId);
  const [board, lists, cards] = await Promise.all([
    trello('GET', `/boards/${id}`, { fields:'name' }),
    trello('GET', `/boards/${id}/lists`, { fields:'name,closed', filter:'open' }),
    trello('GET', `/boards/${id}/cards`, { fields:'name,desc,idList,idMembers,due,dueComplete,closed', labels:'all', filter:'open' })
  ]);
  // Trello limits board actions; keep this opt-in and explicitly mark the estimate.
  const actions = includeHistory ? await trello('GET', `/boards/${id}/actions`, { filter:'updateCard:idList', limit:1000, fields:'type,date,data' }) : [];
  return analyzeBoard({boardId:id,boardName:board.name,lists,cards,actions,completedListNames,historyAvailable:includeHistory});
}
const props = {
  boardId:{type:'string',description:'Board ID or short link; defaults to TRELLO_BOARD_ID'},
  completedListNames:{type:'string',description:'Comma-separated exact completed-list names (default: Done,Completed,Closed)'},
  includeHistory:{type:'boolean',description:'Fetch recent board movement actions to estimate weekly throughput (default false)'}
};
export const TOOLS = {
  analyzeBoardHealth:{
    description:'Read-only analysis of board progress, workload, deadlines, blocked cards, bottlenecks and a heuristic health score.',
    annotations:{readOnlyHint:true}, inputSchema:{type:'object',properties:props},
    run:fetchBoardHealth
  },
  getBoardSummary:{
    description:'Concise read-only summary of a Trello board with risks and recommendations.',
    annotations:{readOnlyHint:true}, inputSchema:{type:'object',properties:props},
    run:async (args) => summarizeBoard(await fetchBoardHealth(args))
  }
};
