import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {launch,stop} from '../scripts/native-device.mjs';
import {nativeSourceFixture} from './native-source-fixture.mjs';
test('native launch validates a compiled workspace, targets only selected emulator and rejects unfinished work before install',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-device-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=path.join(root,'copy'),sdk=path.join(root,'sdk');const f=await nativeSourceFixture(workspace),log=path.join(root,'adb.jsonl');
  await mkdir(path.join(sdk,'platform-tools'),{recursive:true});await mkdir(path.join(sdk,'build-tools/36.0.0'),{recursive:true});
  await writeFile(path.join(sdk,'build-tools/36.0.0/aapt'),`#!${process.execPath}\nconsole.log("package: name='test.project'");\n`,{mode:0o755});
  await writeFile(path.join(sdk,'platform-tools/adb'),`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(args.includes('get-state'))console.log('device');else if(args.includes('sys.boot_completed'))console.log('1');else if(args.includes('install'))console.log('Success');else if(args.includes('tcp:0'))console.log('34567');\n`,{mode:0o755});
  let state={revision:0,draft:[],frame:null,connection:{status:'disconnected'}};const server=http.createServer((req,res)=>{if(req.method==='GET'){res.end(JSON.stringify(state));return;}let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=JSON.parse(text);if(body.origin?.x!==0||body.origin?.y!==0){res.statusCode=400;res.end(JSON.stringify({error:'Invalid CLI origin'}));return;}assert.equal(body.workspace,workspace);state={...state,frame:{preview:'test.SettingsPreview',sourceRevision:f.revision,nodes:[{},{}]},connection:{status:'connected'}};res.end(JSON.stringify(state));});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url='http://127.0.0.1:'+server.address().port;
  const result=await launch({workspace,sdk,serial:'emulator-5584',url,screenState:'Тест'});assert.equal(result.nodes,2);assert.equal(result.sourceRevision,f.revision);assert.equal(result.port,34567);
  await stop(result);const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(calls.every(args=>args[0]==='-s'&&args[1]==='emulator-5584'));assert.ok(calls.some(args=>args.includes('install')));assert.ok(calls.some(args=>args.includes('--remove')));
  const previous=await readFile(log,'utf8');state.draft=[{nodeId:'7'}];await assert.rejects(launch({workspace,sdk,serial:'emulator-5584',url,screenState:'Тест'}),/текущие правки/);assert.equal(await readFile(log,'utf8'),previous);
  await assert.rejects(launch({workspace,sdk,serial:'physical-device',url,screenState:'Тест'}),/эмулятора/);
});
