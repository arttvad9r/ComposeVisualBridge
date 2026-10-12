import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeTextAtomic} from '../storage.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareScene,instrumentScene,restoreScene} from '../scene.mjs';
import {importCompose,instrumentWorkspace,restoreWorkspace} from '../compose.mjs';

const source='package fixture\nfun Screen() { Column(Modifier) { Text("x") } }\n';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(tmpdir(),'cvb-storage-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'Screen.kt'),source);
 await fs.writeFile(path.join(root,'.bridge-native-workspace.json'),JSON.stringify({format:'compose-visual-bridge-workspace-v1',module:':app',sourceProject:root+'-original'}));
 return root;
}
function rule(file,code,symbol,call,type,root=false) {
 return {file,fileHash:hash(code),symbol,call,type,root,occurrence:0};
}
async function injectWriteFailure(fn,operation) {
 const original=fs.writeFile;
 fs.writeFile=async(...args)=>fn(original,...args);syncBuiltinESMExports();
 try {return await operation();}
 finally {fs.writeFile=original;syncBuiltinESMExports();}
}
const noTemporaryFiles=async root=>{
 const names=await fs.readdir(root,{recursive:true});assert.ok(!names.some(name=>name.endsWith('.tmp')),names.join('\n'));
};

for (const kind of ['scene','compose']) test(`${kind}: partial instrumentation and restoration writes keep complete sources and recovery`,async t=>{
 const root=await fixture(t),target=path.join(root,'Screen.kt');
 const input=kind==='scene'?await prepareScene(root,{format:'compose-visual-bridge-scene-adapter-v1',calls:[rule('Screen.kt',source,'Screen','Column','Column',true)]}):await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen'});
 const instrument=()=>kind==='scene'?instrumentScene(input):instrumentWorkspace(input);
 const restore=()=>kind==='scene'?restoreScene(root):restoreWorkspace(root);
 const partial=async(write,filename,text,...args)=>{
  if(filename.startsWith(target+'.')){await write(filename,String(text).slice(0,10),...args);throw Object.assign(Error('partial ENOSPC'),{code:'ENOSPC'});}
  return write(filename,text,...args);
 };
 await injectWriteFailure(partial,()=>assert.rejects(instrument(),/partial ENOSPC/));
 assert.equal(await fs.readFile(target,'utf8'),source);await noTemporaryFiles(root);
 await instrument();const instrumented=await fs.readFile(target,'utf8');assert.notEqual(instrumented,source);
 await injectWriteFailure(partial,()=>assert.rejects(restore(),/partial ENOSPC/));
 assert.equal(await fs.readFile(target,'utf8'),instrumented);
 const manifest=path.join(root,kind==='scene'?'.bridge-scene-import.json':'.bridge-compose-import.json');
 assert.ok(await fs.stat(manifest));await noTemporaryFiles(root);
 await restore();assert.equal(await fs.readFile(target,'utf8'),source);
});

test('Scene rollback failure retains recovery manifest and can be restored later',async t=>{
 const root=await fixture(t),other='package fixture\nfun Other() { Text("other") }\n';
 await fs.writeFile(path.join(root,'Other.kt'),other);
 const scene=await prepareScene(root,{format:'compose-visual-bridge-scene-adapter-v1',calls:[rule('Screen.kt',source,'Screen','Column','Column',true),rule('Other.kt',other,'Other','Text','Text')]});
 let writes=0;
 await injectWriteFailure(async(write,filename,text,...args)=>{
  if(filename.startsWith(path.join(root,'Screen.kt')+'.')&&++writes>1)throw Error('rollback unavailable');
  if(filename.startsWith(path.join(root,'Other.kt')+'.')){await write(filename,String(text).slice(0,10),...args);throw Error('partial write');}
  return write(filename,text,...args);
 },()=>assert.rejects(instrumentScene(scene),/Автовосстановление не завершено.*Снимок восстановления/));
 const manifest=JSON.parse(await fs.readFile(path.join(root,'.bridge-scene-import.json'),'utf8'));
 assert.equal(manifest.files['Screen.kt'].original,source);assert.equal(manifest.files['Other.kt'].original,other);
 assert.notEqual(await fs.readFile(path.join(root,'Screen.kt'),'utf8'),source);
 assert.equal(await fs.readFile(path.join(root,'Other.kt'),'utf8'),other);
 await restoreScene(root);assert.equal(await fs.readFile(path.join(root,'Screen.kt'),'utf8'),source);await noTemporaryFiles(root);
});

test('Exclusive atomic helper creation preserves an existing file',async t=>{
 const root=await fixture(t),target=path.join(root,'helper.kt');await fs.writeFile(target,'user helper');
 await assert.rejects(writeTextAtomic(target,'bridge helper',{exclusive:true}),{code:'EEXIST'});
 assert.equal(await fs.readFile(target,'utf8'),'user helper');await noTemporaryFiles(root);
});

test('Scene recovery survives a killed process between two source replacements',async t=>{
 const root=await fixture(t),other='package fixture\nfun Other() { Text("other") }\n';
 await fs.writeFile(path.join(root,'Other.kt'),other);
 const adapter={format:'compose-visual-bridge-scene-adapter-v1',calls:[rule('Screen.kt',source,'Screen','Column','Column',true),rule('Other.kt',other,'Other','Text','Text')]};
 const script=`
  import fs from 'node:fs/promises';
  import {syncBuiltinESMExports} from 'node:module';
  import {prepareScene,instrumentScene} from ${JSON.stringify(new URL('../scene.mjs',import.meta.url).href)};
  const rename=fs.rename;
  fs.rename=async(from,to)=>{
   await rename(from,to);
   if(to===${JSON.stringify(path.join(root,'Screen.kt'))})process.kill(process.pid,'SIGKILL');
  };
  syncBuiltinESMExports();
  await instrumentScene(await prepareScene(${JSON.stringify(root)},${JSON.stringify(adapter)}));
 `;
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script]),error=>error.signal==='SIGKILL');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'.bridge-scene-import.json'),'utf8'));
 assert.equal(await fs.readFile(path.join(root,'Screen.kt'),'utf8'),manifest.files['Screen.kt'].instrumented);
 assert.equal(await fs.readFile(path.join(root,'Other.kt'),'utf8'),other);
 await restoreScene(root);await restoreScene(root);
 assert.equal(await fs.readFile(path.join(root,'Screen.kt'),'utf8'),source);
 assert.equal(await fs.readFile(path.join(root,'Other.kt'),'utf8'),other);
 await noTemporaryFiles(root);
});
