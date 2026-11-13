import WebSocket from 'ws';
const URL = process.env.HUB_URL || 'ws://127.0.0.1:8787/ws';
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'join', name }));
      resolve(ws);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'conflict') console.log(`⚠ ${name}: ${msg.message}`);
    });
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const a = await connect('Developer A');
const b = await connect('Developer B');
console.log('Two simulated developers connected.');
a.send(JSON.stringify({ type: 'claim', cardId: 'TRELLO-42' }));
await sleep(300);
b.send(JSON.stringify({ type: 'claim', cardId: 'TRELLO-42' }));
await sleep(300);
a.send(JSON.stringify({ type: 'claim-field', cardId: 'TRELLO-43', field: 'description' }));
await sleep(300);
b.send(JSON.stringify({ type: 'claim-field', cardId: 'TRELLO-43', field: 'description' }));
await sleep(300);
a.send(JSON.stringify({ type: 'depends-on', cardId: 'TRELLO-44', needs: 'TRELLO-41' }));
await sleep(300);
b.send(JSON.stringify({ type: 'status', cardId: 'TRELLO-44', status: 'done' }));
await sleep(300);
a.send(JSON.stringify({ type: 'activity', detail: 'Updated card description' }));
await sleep(300);
a.send(JSON.stringify({ type: 'release', cardId: 'TRELLO-42' }));
await sleep(300);
b.send(JSON.stringify({ type: 'claim', cardId: 'TRELLO-42' }));
await sleep(500);
a.close(); b.close();
console.log('Demo complete. Open the dashboard to review events.');
