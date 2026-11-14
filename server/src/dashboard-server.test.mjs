import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardServer } from './dashboard-server.mjs';
const fake={boardName:'Test',metrics:{totalCards:0},recommendations:[],limitations:[]};
test('dashboard serves HTML and read-only health and summary',async()=>{
 const server=createDashboardServer({analyze:async()=>fake,page:async()=>'<html>dashboard</html>'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const base=`http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base+'/')).text(),/dashboard/);
  assert.equal((await (await fetch(base+'/api/health')).json()).boardName,'Test');
  assert.equal((await (await fetch(base+'/api/summary')).json()).boardName,'Test');
  assert.equal((await fetch(base+'/api/health',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/missing')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('dashboard does not expose upstream errors',async()=>{
 const server=createDashboardServer({analyze:async()=>{throw Error('secret-placeholder') }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/health`);assert.equal(res.status,502);assert.doesNotMatch(await res.text(),/secret-placeholder/)}finally{await new Promise(resolve=>server.close(resolve))}
});
