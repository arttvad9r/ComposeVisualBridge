import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {normalizeBuddyFrame,buddyEndpoint} from '../native.mjs';
import {buddyFrame,metadata} from './native-fixture.mjs';

test('native validator preserves pixel coordinates and rejects ambiguous or unsafe input',()=>{
  const frame=normalizeBuddyFrame(buddyFrame(),metadata);
  assert.equal(frame.width,1);assert.equal(frame.nodes[1].bounds.left,.2);assert.equal(frame.nodes[1].source.confidence,'hint');
  assert.equal(frame.nodes[1].source.file,'Settings.kt');assert.equal(frame.sourceRevision,metadata.sourceRevision);
  assert.throws(()=>normalizeBuddyFrame(buddyFrame(),{...metadata,sourceRevision:'guessed'}),/фактический/);
  const duplicate=buddyFrame();duplicate.semantics.children[0].id=0;assert.throws(()=>normalizeBuddyFrame(duplicate,metadata),/уникальными/);
  const invalid=buddyFrame();invalid.semantics.bounds.right=NaN;assert.throws(()=>normalizeBuddyFrame(invalid,metadata),/bounds/);
  assert.throws(()=>buddyEndpoint('ws://example.com:7890'),/только/);assert.throws(()=>buddyEndpoint('ws://localhost:7890@evil.test'),/только/);
  assert.equal(buddyEndpoint('ws://127.0.0.1:7890'),'ws://127.0.0.1:7890/');
});

async function fixture(t) {
  const data=await mkdtemp(path.join(tmpdir(),'bridge-native-'));let child;
  const stop=async()=>{if(child?.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}};
  const start=async()=>{
    child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});
    return new Promise((resolve,reject)=>{let out='';child.stdout.on('data',c=>{out+=c;const m=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.on('error',reject);child.on('exit',()=>reject(Error(out)));});
  };
  let url=await start();t.after(async()=>{await stop();await rm(data,{recursive:true,force:true});});
  const request=async(route,input)=>{const r=await fetch(url+route,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});return {status:r.status,value:await r.json()};};
  const state=async()=>(await request('/api/native')).value;
  const post=async(route,input={})=>request('/api/native'+route,{...input,revision:(await state()).revision});
  return {data,request,state,post,restart:async()=>{await stop();url=await start();}};
}
test('native snapshot survives late drafts, rejected new frames and server restart without changing model session',async t=>{
  const f=await fixture(t),oldSession=(await f.request('/api/session')).value;
  let r=await f.post('/frame',{...metadata,frame:buddyFrame()});assert.equal(r.status,200);assert.equal(r.value.frame.image,undefined);
  const digest=r.value.frame.digest;
  const intents=[{nodeId:'7',property:'fontSize',value:16}];
  r=await f.post('/draft',{digest,intents});assert.equal(r.status,200);
  assert.equal((await f.post('/apply',{mode:'review'})).status,422);
  assert.equal((await f.post('/confirm',{digest,acknowledged:true})).status,200);
  r=await f.post('/apply',{mode:'review'});assert.equal(r.status,201);
  const original=(await f.request('/api/native/handoff')).value;
  assert.equal(original.intent.changes[0].value,16);assert.equal(original.frame.nodes[1].text,'Нативный текст');assert.equal(original.verification.confirmedBy,'user');
  assert.equal((await f.post('/frame',{...metadata,frame:buddyFrame('Другой экран')})).status,409);
  await f.post('/draft',{digest,intents:[{nodeId:'7',property:'fontSize',value:18}]});
  assert.deepEqual((await f.request('/api/native/handoff')).value,original);
  await f.restart();assert.equal((await f.state()).draft[0].value,18);assert.deepEqual((await f.request('/api/native/handoff')).value,original);
  assert.deepEqual((await f.request('/api/session')).value,oldSession);
  const stale=await f.request('/api/native/draft',{revision:0,digest,intents:[]});assert.equal(stale.status,409);
  await f.post('/draft',{digest,intents:[]});await f.post('/frame',{...metadata,frame:buddyFrame('Обновлённый текст')});
  assert.equal((await f.state()).confirmedDigest,null);assert.deepEqual((await f.request('/api/native/handoff')).value,original);
  assert.ok(await readFile(path.join(f.data,original.applied.directory,'changes.json')));
});

function websocketFixture() {
  const sockets=new Set(),commands=[];const server=http.createServer();let peer;
  const send=value=>{const data=Buffer.from(JSON.stringify(value));let header;if(data.length<126)header=Buffer.from([0x81,data.length]);else if(data.length<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(data.length,2);}else{header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(data.length),2);}peer.write(Buffer.concat([header,data]));};
  server.on('upgrade',(req,socket)=>{peer=socket;sockets.add(socket);socket.on('error',()=>{});const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);let pending=Buffer.alloc(0);
    socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=6){const len=pending[1]&127;if(len>=126||pending.length<6+len)return;const payload=Buffer.from(pending.subarray(6,6+len));for(let i=0;i<len;i++)payload[i]^=pending[2+i%4];const opcode=pending[0]&15;pending=pending.subarray(6+len);if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}if(opcode===1){commands.push(JSON.parse(payload.toString()));if(commands.at(-1).cmd==='requestPreviewList')send({type:'previewList',previews:['test.SettingsPreview']});if(commands.at(-1).cmd==='rerender')send(buddyFrame());}}});socket.on('close',()=>sockets.delete(socket));
  });
  return {server,commands,send,drop:()=>peer.destroy(),close:async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const eventually=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('Состояние не обновилось');};
test('Buddy websocket handshake, catalog and late incoming frame preserve the active draft',{skip:typeof WebSocket==='undefined'},async t=>{
  const ws=websocketFixture();ws.server.listen(0,'127.0.0.1');await once(ws.server,'listening');t.after(ws.close);
  const f=await fixture(t);const endpoint=`ws://127.0.0.1:${ws.server.address().port}/`;
  assert.equal((await f.post('/connect',{...metadata,endpoint})).status,200);
  await eventually(async()=>!!(await f.state()).frame);let state=await f.state();assert.deepEqual(state.previews,['test.SettingsPreview']);assert.equal(state.connection.status,'connected');
  await f.post('/draft',{digest:state.frame.digest,intents:[{nodeId:'7',property:'text',value:'Желаемый текст'}]});
  ws.send(buddyFrame('Новый native кадр'));await eventually(async()=>(await f.state()).pendingFrame);
  state=await f.state();assert.equal(state.frame.nodes[1].text,'Нативный текст');assert.equal((await f.post('/navigate',{preview:'test.SettingsPreview'})).status,409);
  await f.post('/draft',{digest:state.frame.digest,intents:[]});assert.equal((await f.post('/refresh')).status,200);
  await eventually(async()=> (await f.post('/disconnect')).status===200);assert.equal((await f.state()).connection.status,'disconnected');assert.ok(ws.commands.some(c=>c.cmd==='rerender'));
});

test('Buddy connection retries while the device preview server is starting',{skip:typeof WebSocket==='undefined'},async t=>{
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const f=await fixture(t),ws=websocketFixture();
  await f.post('/connect',{...metadata,endpoint:`ws://127.0.0.1:${port}/`});
  await new Promise(resolve=>setTimeout(resolve,650));
  ws.server.listen(port,'127.0.0.1');await once(ws.server,'listening');t.after(ws.close);
  await eventually(async()=>!!(await f.state()).frame);
  assert.equal((await f.state()).connection.status,'connected');
  const requests=ws.commands.filter(command=>command.cmd==='requestPreviewList').length;
  ws.drop();
  await eventually(async()=>ws.commands.filter(command=>command.cmd==='requestPreviewList').length>requests&&(await f.state()).connection.status==='connected');
});
