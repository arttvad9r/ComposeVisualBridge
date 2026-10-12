import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {spawn,execFile} from 'node:child_process';import {once} from 'node:events';import {promisify} from 'node:util';
import {History,clone} from '../public/model.mjs';import {rebaseLateDraft} from '../transfer-result.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const baseline={schemaVersion:1,name:'Результат',sourceRevision:'source-0',viewport:{width:360,height:640},root:{id:'screen',type:'Column',props:{},children:[{id:'text',type:'Text',props:{text:'До',fontSize:14}}]}};
async function fixture(t){const data=await mkdtemp(path.join(tmpdir(),'cvb-result-'));await writeFile(data+'/session.json',JSON.stringify({revision:0,baseline,current:baseline,applied:null}));let child,url;
 const stop=async()=>{if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}};
 const start=async()=>{child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});url=await new Promise((resolve,reject)=>{let log='';child.stdout.on('data',c=>{log+=c;const m=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.stderr.on('data',c=>log+=c);child.once('error',reject);child.once('exit',()=>reject(Error(log)));});};
 t.after(async()=>{await stop();await rm(data,{recursive:true,force:true});});await start();
 const request=async(endpoint,input,method='POST')=>{const r=await fetch(url+endpoint,input?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{});return {status:r.status,value:await r.json()};};return {data,request,stop,start,get url(){return url;}};
}
const result=(state,document)=>({revision:state.revision,snapshot:state.applied.directory,beforeSourceRevision:state.baseline.sourceRevision,status:'succeeded',message:'Собрано и проверено',sourceRevision:document.sourceRevision,document,reference:{mime:'image/png',image:png,label:'Настоящий экран результата'},checks:{build:':app:assembleDebug',visual:'Сверены изменённые элементы'}});
test('Two result cycles preserve immutable handoff, late edits, persisted Undo/Redo, failure and stale rejection across restart',async t=>{
 const f=await fixture(t),r=f.request;let state=(await r('/api/session')).value;
 state=(await r('/api/baseline/reference',{revision:state.revision,mime:'image/png',image:png,label:'До · настоящий экран'})).value;
 state=(await r('/api/baseline/confirm',{revision:state.revision,baselineFingerprint:state.baselineFingerprint,acknowledged:true})).value;assert.equal(state.verification.confirmedBy,'user');
 const history=new History(state.current);let proposed=clone(state.current);proposed.root.children[0].props.text='После';history.commit(proposed);
 state=(await r('/api/apply',{revision:state.revision,document:proposed,history:history.snapshot(),mode:'review'})).value;const immutable=(await r('/api/handoff')).value;
 let late=clone(proposed);late.root.children[0].props.fontSize=18;history.commit(late);state=(await r('/api/draft',{revision:state.revision,document:late,history:history.snapshot()},'PUT')).value;
 let fresh=clone(proposed);fresh.sourceRevision='source-1';let input=result(state,fresh);const before=state.revision;
 state=(await r('/api/result',input)).value;assert.equal(state.revision,before);assert.deepEqual(state.current,late);assert.equal(state.result.beforeReference.includes(state.applied.directory),true);
 assert.equal((await fetch(f.url+state.result.reference.url)).status,200);assert.deepEqual((await r('/api/handoff')).value,immutable);
 state=(await r('/api/result/accept',{revision:state.revision,id:state.result.id})).value;assert.equal(state.current.root.children[0].props.fontSize,18);assert.equal(state.baseline.root.children[0].props.fontSize,14);assert.equal(state.result.lateDraft.status,'rebased');assert.equal(state.verification,null);assert.equal(state.reference.digest.length,64);
 await f.stop();await f.start();state=(await r('/api/session')).value;const restored=History.restore(state.current,state.history);assert.equal(restored.undo().root.children[0].props.fontSize,14);state=(await r('/api/draft',{revision:state.revision,document:restored.current,history:restored.snapshot()},'PUT')).value;
 await f.stop();await f.start();state=(await r('/api/session')).value;assert.equal(History.restore(state.current,state.history).redo().root.children[0].props.fontSize,18);
 proposed=clone(state.current);proposed.root.children[0].props.text='Второй перенос';state=(await r('/api/apply',{revision:state.revision,document:proposed,mode:'test'})).value;
 assert.equal((await r('/api/result',{...input,revision:state.revision})).status,409);const unchanged=clone(state.current);
 state=(await r('/api/result',{revision:state.revision,snapshot:state.applied.directory,beforeSourceRevision:'source-1',status:'failed',message:'Сборка не прошла'})).value;assert.deepEqual(state.current,unchanged);assert.equal((await r('/api/result/accept',{revision:state.revision,id:state.result.id})).status,400);
 fresh=clone(proposed);fresh.sourceRevision='source-2';input=result(state,fresh);assert.equal((await r('/api/result',{...input,beforeSourceRevision:'stale'})).status,400);
 state=(await r('/api/result',input)).value;state=(await r('/api/result/accept',{revision:state.revision,id:state.result.id})).value;assert.equal(state.current.sourceRevision,'source-2');assert.equal(state.current.root.children[0].props.text,'Второй перенос');assert.equal(state.results.length,3);
 const malformed={...state.history,current:baseline};assert.equal((await r('/api/draft',{revision:state.revision,document:state.current,history:malformed},'PUT')).status,400);
 assert.ok(!(await readdir(f.data)).some(n=>n.endsWith('.tmp')));
});
test('Ambiguous late structure is archived intact and can be restored with history; failed state write leaves no result file',async t=>{
 const f=await fixture(t),r=f.request;let state=(await r('/api/apply',{revision:0,document:baseline,mode:'test'})).value;
 const late=clone(baseline);late.root.children=[];state=(await r('/api/draft',{revision:state.revision,document:late},'PUT')).value;
 const fresh=clone(baseline);fresh.sourceRevision='source-1';const input=result(state,fresh);
 await rm(f.data+'/session.json');await writeFile(f.data+'/session.json.block','block');await (await import('node:fs/promises')).mkdir(f.data+'/session.json');const beforeNames=await readdir(f.data);
 assert.equal((await r('/api/result',input)).status,500);assert.deepEqual(await readdir(f.data),beforeNames);await rm(f.data+'/session.json',{recursive:true});await writeFile(f.data+'/session.json',JSON.stringify(state));
 state=(await r('/api/result',input)).value;state=(await r('/api/result/accept',{revision:state.revision,id:state.result.id})).value;
 assert.equal(state.result.lateDraft.status,'archived');assert.deepEqual(state.current,fresh);const archive=JSON.parse(await readFile(f.data+'/'+state.previousSession+'/session.json'));assert.deepEqual(archive.current,late);
 state=(await r('/api/session/restore',{revision:state.revision})).value;assert.deepEqual(state.current,late);assert.ok(state.history.past.length);
});
test('Late value conflicts and uncertain Compose identities never silently rebase',()=>{
 const late=clone(baseline);late.root.children[0].props.fontSize=18;const fresh=clone(baseline);fresh.root.children[0].props.fontSize=20;assert.ok(rebaseLateDraft(baseline,late,fresh).conflicts.length);
 const metadata=clone(baseline);metadata.root.children[0].source={file:'other.kt'};assert.ok(rebaseLateDraft(baseline,metadata,baseline).conflicts.length);
 fresh.root.children[0].props.fontSize=14;const compose={format:'static',bindings:{}};const proposed={...baseline,compose};assert.ok(rebaseLateDraft(proposed,{...late,compose},{...fresh,compose}).conflicts.length);
});

test('History trims oldest states to the UTF-8 byte budget without dropping current or nearest Redo',()=>{
 const history=new History(baseline);for(let i=0;i<10;i++){const doc=clone(baseline);doc.root.children[0].props.text='я'.repeat(180)+i;history.commit(doc);}history.undo();const current=clone(history.current),next=clone(history.future.at(-1)),snapshot=history.snapshot(1600);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=1600);assert.deepEqual(snapshot.current,current);assert.deepEqual(snapshot.future.at(-1),next);assert.deepEqual(History.restore(current,snapshot).redo(),next);
});
