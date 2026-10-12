// Replays previously verified native Mealio captures through the result contract.
// Does not connect to ADB, modify Mealio, or replace an existing editor session.
import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {spawn,execFile} from 'node:child_process';import {once} from 'node:events';import {promisify} from 'node:util';
import {indexTree,History,clone} from '../../public/model.mjs';
const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){assert.ok(['--evidence','--output'].includes(args[i])&&args[i+1]);options[args[i]]=args[i+1];}assert.ok(options['--evidence']&&options['--output']);const source=options['--evidence'],out=options['--output'];await mkdir(out);const data=out+'/data';await mkdir(data);
const load=name=>readFile(source+'/'+name+'.json','utf8').then(JSON.parse);const initial=await load('0-document'),frame=await load('0-frame');await writeFile(data+'/session.json',JSON.stringify({revision:0,baseline:initial,current:initial,applied:null,reference:{mime:'image/png',image:frame.image,label:'Mealio · исходный нативный кадр'}}));
// Use the API to normalize reference metadata, rather than trusting this fixture.
let child,done,url;const evidence={kind:'verified-native-capture-replay',source,cycles:[]};
async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});done=once(child,'exit');url=await new Promise((resolve,reject)=>{let log='';child.stdout.on('data',c=>{log+=c;const m=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.once('error',reject);});}
async function stop(){if(child?.exitCode===null){child.kill();await done;}}
async function request(endpoint,input,method='POST'){const response=await fetch(url+endpoint,input?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{});const value=await response.json();assert.ok(response.ok,value.error);return value;}
try{
 await start();let state=await request('/api/session');state=await request('/api/baseline/reference',{revision:state.revision,mime:'image/png',image:frame.image,label:'Mealio · исходный нативный кадр'});
 for(let cycle=1;cycle<=2;cycle++){
  const saved=await load(cycle+'-handoff'),fresh=await load(cycle+'-document'),native=await load(cycle+'-frame');state=await request('/api/apply',{revision:state.revision,document:saved.document,mode:'test'});const snapshot=await request('/api/handoff');
  const late=clone(state.current),target=[...indexTree(late.root)].find(([id,e])=>e.node.type==='Text');target[1].node.props.color='#123456';state=await request('/api/draft',{revision:state.revision,document:late},'PUT');
  const input={snapshot:state.applied.directory,beforeSourceRevision:state.baseline.sourceRevision,status:'succeeded',message:'Нативный результат итерации '+cycle,sourceRevision:fresh.sourceRevision,document:fresh,reference:{mime:'image/png',image:native.image,label:'Mealio · проверенный кадр '+cycle},checks:{build:':app:assembleDebug — подтверждено каталогом '+cycle+'-build.json',visual:'Поэлементная проверка '+cycle+'-visual-check.json'}};
  const filename=out+'/'+cycle+'-result-input.json';await writeFile(filename,JSON.stringify(input));const registered=JSON.parse((await promisify(execFile)(process.execPath,['scripts/bridge.mjs','result','--url',url,'--input',filename],{maxBuffer:4*1024*1024})).stdout);
  assert.equal(registered.sourceRevision,fresh.sourceRevision);assert.deepEqual(await request('/api/handoff'),snapshot);state=await request('/api/result/accept',{revision:state.revision,id:registered.id});assert.equal(state.result.lateDraft.status,'rebased');assert.equal(indexTree(state.current.root).get(target[0]).node.props.color,'#123456');assert.equal(state.verification,null);
  assert.deepEqual(Buffer.from(await(await fetch(url+registered.reference.url)).arrayBuffer()),Buffer.from(native.image,'base64'));
  await stop();await start();state=await request('/api/session');assert.equal(state.result.id,registered.id);const history=History.restore(state.current,state.history);history.undo();state=await request('/api/draft',{revision:state.revision,document:history.current,history:history.snapshot()},'PUT');assert.deepEqual(state.current,fresh);
  evidence.cycles.push({cycle,snapshot:registered.snapshot,result:state.result,sourceRevision:fresh.sourceRevision,immutableSnapshot:true,lateDraftPreserved:true,restart:true,undo:true});
 }
 await writeFile(out+'/evidence.json',JSON.stringify(evidence,null,2));console.log('Два цикла результата на проверенных нативных кадрах: '+out);
}finally{await stop();}
