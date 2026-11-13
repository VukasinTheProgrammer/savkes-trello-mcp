import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'collab-phase4-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, PORT: String(port), HUB_BRIDGE_TOKEN: 'test-bridge-token', COLLAB_DB_PATH: join(dir, 'hub.sqlite'), COLLAB_USER_TOKENS: JSON.stringify({alice:'alice-secret', bob:'bob-secret', eve:'eve-secret'}) };
let server;
const start = async () => {
  server = spawn(process.execPath, ['src/server.mjs'], { cwd: new URL('../', import.meta.url), env, stdio: 'pipe' });
  for (let i=0;i<100;i++) {
    if (server.exitCode !== null) throw new Error('hub exited');
    try { const r=await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await new Promise(r=>setTimeout(r,30));
  }
  throw new Error('hub did not start');
};
const stop = async () => { if (!server) return; const child=server; child.kill(); await new Promise(resolve=>{ if (child.exitCode!==null) resolve(); else child.once('exit',resolve); }); };
const connect = () => new Promise((resolve,reject)=>{
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: {'X-Hub-Token':'test-bridge-token'} });
  ws.once('open',()=>resolve(ws)); ws.once('error',reject);
});
const receive = (ws, predicate=()=>true) => new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{ws.off('message',handler);reject(new Error('message timeout'));},1500);
  function handler(raw) {const data=JSON.parse(raw.toString());if(predicate(data)){clearTimeout(timeout);ws.off('message',handler);resolve(data);}}
  ws.on('message',handler);
});
const command = (ws,msg,types) => {const wait=receive(ws,x=>types.includes(x.type));ws.send(JSON.stringify(msg));return wait;};
const joinUser = (ws,developerId,identityToken) => command(ws,{type:'join',developerId,identityToken},['joined','error']);
const close = ws => ws.close();

test('Phase 4 identity, permissions, notifications and persistence', async t => {
  await start();
  let alice=await connect(),bob=await connect(),eve=await connect();
  t.after(async()=>{close(alice);close(bob);close(eve);await stop();rmSync(dir,{recursive:true,force:true});});
  assert.equal((await joinUser(eve,'alice','wrong')).type,'error');
  assert.equal((await joinUser(alice,'alice','alice-secret')).type,'joined');
  assert.equal((await joinUser(bob,'bob','bob-secret')).type,'joined');
  assert.equal((await joinUser(eve,'eve','eve-secret')).type,'joined');
  assert.equal((await command(alice,{type:'workspace',subtype:'create',name:'team'},['workspace_created','error'])).type,'workspace_created');
  assert.equal((await command(eve,{type:'workspace',subtype:'add_member',name:'team',memberId:'eve'},['workspace_member_added','error'])).type,'error');
  assert.equal((await command(alice,{type:'workspace',subtype:'add_member',name:'team',memberId:'bob'},['workspace_member_added','error'])).type,'workspace_member_added');
  assert.equal((await command(alice,{type:'task',subtype:'create',workspace:'team',title:'A',assignee:'eve'},['task_created','error'])).type,'error');
  const created=await command(alice,{type:'task',subtype:'create',workspace:'team',title:'A',assignee:'bob'},['task_created','error']);
  assert.equal(created.type,'task_created');
  const note=await command(bob,{type:'notification',subtype:'list'},['notification_list']);
  assert.ok(note.notifications.some(x=>x.type==='task_assigned'));
  const submitted=await command(bob,{type:'change-request',subtype:'submit',taskId:created.taskId,description:'Change'},['change_request_submitted','error']);
  assert.equal(submitted.type,'change_request_submitted');
  assert.equal((await command(bob,{type:'change-request',subtype:'approve',requestId:submitted.requestId},['change_request_approved','error'])).type,'error');
  assert.equal((await command(alice,{type:'change-request',subtype:'approve',requestId:submitted.requestId},['change_request_approved','error'])).type,'change_request_approved');
  assert.ok((await command(bob,{type:'notification',subtype:'list'},['notification_list'])).notifications.some(x=>x.type==='change_request_decided'));
  assert.equal((await command(alice,{type:'workspace',subtype:'remove_member',name:'team',memberId:'bob'},['workspace_member_removed','error'])).type,'workspace_member_removed');
  const tasks=await command(bob,{type:'task',subtype:'list'},['task_list']);
  assert.equal(tasks.tasks.length,0);
  await stop(); await start();
  const restored=await connect();t.after(()=>close(restored));
  assert.equal((await joinUser(restored,'alice','alice-secret')).type,'joined');
  const workspaces=await command(restored,{type:'workspace',subtype:'list'},['workspace_list']);
  assert.equal(workspaces.workspaces.length,1);
  const requests=await command(restored,{type:'change-request',subtype:'list'},['change_request_list']);
  assert.equal(requests.requests[0].status,'approved');
});
