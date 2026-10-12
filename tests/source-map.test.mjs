import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {indexWorkspace,mapFrame,verifyMapping,kotlinTokens} from '../source-map.mjs';
import {normalizeBuddyFrame,createNativeBridge} from '../native.mjs';
import {buddyFrame,metadata} from './native-fixture.mjs';
import {nativeSourceFixture} from './native-source-fixture.mjs';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'bridge-source-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,...await nativeSourceFixture(root)};}
test('source candidates retain ambiguity, skip comments/interpolation, locate resource references and unknown nodes',async t=>{
  const f=await fixture(t),index=await indexWorkspace(f.root,f.revision);
  const frame=normalizeBuddyFrame(buddyFrame(),{...metadata,sourceRevision:f.revision}),mapped=mapFrame(frame,index);
  assert.throws(()=>mapFrame({...frame,preview:'another.Project'},index),/каталога/);
  assert.equal(mapped.nodes[1].source.candidateCount,3);assert.equal(mapped.nodes[1].source.confidence,'candidate');
  assert.deepEqual(mapped.nodes[1].source.candidates.map(c=>c.line),[3,4,5]);assert.equal(mapped.nodes[1].source.candidates[2].resource.line,1);
  assert.match(mapped.nodes[1].source.candidates[0].excerpt,/fontSize = 14.sp/);assert.equal(mapped.nodes[0].source.confidence,'unknown');
  assert.equal(mapFrame(mapped,index).digest,mapped.digest);assert.equal(mapped.sourceMapping.requiresResolution,true);
  const hint=structuredClone(frame);hint.nodes[1].source={file:'Settings.kt',line:3};const found=mapFrame(hint,index).nodes[1].source.candidates;assert.equal(found[0].reason,'runtime-hint');
  const tokens=kotlinTokens('val a="escaped \\$"; val b="""raw literal"""; val c="dynamic $x"; val d="\\u0041"');
  assert.deepEqual(tokens.filter(t=>t.kind==='string').map(t=>t.value),['escaped $','raw literal',null,'A']);
  await assert.rejects(indexWorkspace(f.root,'a'.repeat(64)),/не совпадает/);await verifyMapping(mapped);
  const unique=structuredClone(frame);unique.nodes[1].text='only one';const single={...index,textLocations:new Map([['only one',[{file:index.kotlin[0],line:3}]]])};assert.equal(mapFrame(unique,single).nodes[1].source.confidence,'candidate');
  const many={...single,textLocations:new Map([['only one',Array.from({length:20},(_,i)=>({file:index.kotlin[0],line:i+1}))]])};const capped=mapFrame(unique,many).nodes[1].source;assert.equal(capped.candidates.length,12);assert.equal(capped.candidateCount,20);
  const apk=path.join(f.root,'app/build/outputs/apk/debug/app-debug.apk');await writeFile(apk,'changed-apk');await assert.rejects(verifyMapping(mapped),/APK изменился/);await writeFile(apk,'test-apk');
  await writeFile(f.file,f.code+'// edited');await assert.rejects(verifyMapping(mapped),/устарел/);
});
test('attached sources survive restart and immutable handoff; stale sources and unfinished edits are rejected',async t=>{
  const f=await fixture(t);
  // Session data must be outside indexed workspace.
  const session=await mkdtemp(path.join(tmpdir(),'bridge-source-session-'));t.after(()=>rm(session,{recursive:true,force:true}));
  const atomic=(file,value)=>writeFile(file,JSON.stringify(value)),serial=fn=>fn();
  let bridge=await createNativeBridge({data:session,atomic,serial}),revision=0;
  const request=async(route,input={})=>{let result;await bridge.handle({method:'POST'},{},new URL('http://localhost/api/native'+route),(status,value)=>{result={status,value};revision=value.revision;},async()=>({...input,revision}));return result.value;};
  await request('/frame',{...metadata,sourceRevision:f.revision,frame:buddyFrame()});
  const state=JSON.parse(await readFile(path.join(session,'native-session.json')));
  let mapped=await request('/source',{workspace:f.root,digest:state.frame.digest});
  const digest=mapped.frame.digest;assert.equal(mapped.frame.nodes[1].source.candidateCount,3);
  await request('/draft',{digest,intents:[{nodeId:'7',property:'fontSize',value:16}]});
  await assert.rejects(request('/source',{workspace:f.root,digest}),/незавершённых/);
  await request('/confirm',{digest,acknowledged:true});const applied=await request('/apply',{mode:'review'});
  const snapshot=path.join(session,applied.applied.directory,'changes.json'),original=await readFile(snapshot,'utf8');
  const handoff=JSON.parse(original);assert.equal(handoff.intent.changes[0].source.candidateCount,3);assert.equal(handoff.intent.changes[0].sourceRequiresResolution,true);
  bridge.stop();bridge=await createNativeBridge({data:session,atomic,serial});
  await writeFile(f.file,f.code+'// edit');await assert.rejects(request('/apply',{mode:'review'}),/устарел/);
  await assert.rejects(request('/draft',{digest,intents:[{nodeId:'7',property:'fontSize',value:18}]}),/устарел/);
  await request('/draft',{digest,intents:[]});assert.equal(await readFile(snapshot,'utf8'),original);bridge.stop();
});
