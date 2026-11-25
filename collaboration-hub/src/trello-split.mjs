/** Explicit Trello card split. No Trello write occurs until the owner confirms. */
const API = 'https://api.trello.com/1';
export async function splitTrelloCard({cardId, ownerWork, collaboratorWork, collaboratorName, ownerName, key, token, fetchImpl = fetch}) {
  if (!key || !token) throw new Error('Trello credentials are not configured on the hub');
  if (!/^[0-9a-f]{24}$/i.test(cardId)) throw new Error('Use the real 24-character Trello card ID, not a demo ID');
  if (!ownerWork?.trim() || !collaboratorWork?.trim()) throw new Error('Both task descriptions are required');
  const auth = new URLSearchParams({key, token});
  const getUrl = `${API}/cards/${encodeURIComponent(cardId)}?${auth}&fields=id,name,desc,idList,closed`;
  const originalResponse = await fetchImpl(getUrl);
  if (!originalResponse.ok) throw new Error(`Could not load Trello card (${originalResponse.status})`);
  const original = await originalResponse.json();
  if (original.closed || !original.idList) throw new Error('Trello card is closed or missing its list');
  // Preserve the original card and its description. Create a separate child task for collaborator.
  const body = new URLSearchParams({
    idList: original.idList,
    name: `${original.name} — ${collaboratorName} (split task)`.slice(0, 160),
    desc: `Split from ${original.name}\nOriginal card: https://trello.com/c/${original.id}\n\nAssigned work (${collaboratorName}):\n${collaboratorWork}\n\nRemaining work (${ownerName || 'owner'}):\n${ownerWork}`,
    pos: 'bottom', key, token
  });
  const createResponse = await fetchImpl(`${API}/cards`, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()});
  if (!createResponse.ok) throw new Error(`Trello rejected the new card (${createResponse.status})`);
  const created = await createResponse.json();
  if (!created?.id) throw new Error('Trello did not return a new card ID');
  return {originalCardId: original.id, newCardId: created.id, newCardUrl: created.url || `https://trello.com/c/${created.id}`, originalCardName: original.name};
}
