// Optional acceptance of the real SettingsScreen, only in an isolated prepared copy.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,open,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {prepareScene,instrumentScene,restoreScene,bindScene} from '../../scene.mjs';
import {sourceRevision,build,toolchain} from '../../scripts/native-project.mjs';
import {launch,stop} from '../../scripts/native-device.mjs';
import {indexTree} from '../../public/model.mjs';
import {comparePng} from '../../scripts/compare-png.mjs';
import {verifyMealioVisual} from './mealio-visual.mjs';

const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--template','--project','--output','--serial'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Нужны --template --project --output --serial');options[args[i]]=args[i+1];}
for(const flag of ['--template','--project','--output','--serial'])if(!options[flag])throw Error('Не задан '+flag);
const repo=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(options['--output']),workspace=out+'/workspace',project=path.resolve(options['--project']),serial=options['--serial'];
assert.match(serial,/^emulator-\d+$/);assert.ok(out!==project&&!out.startsWith(project+'/'));
const tools=await toolchain(),exec=promisify(execFile),adb=(...args)=>exec(tools.sdk+'/platform-tools/adb',['-s',serial,...args],{timeout:30000,maxBuffer:4*1024*1024});
assert.equal((await adb('shell','getprop','sys.boot_completed')).stdout.trim(),'1');
const originalRevision=await sourceRevision(project);await mkdir(out);
const excluded=new Set(['.git','.gradle','.kotlin','build','keystore','keystore.properties','.bridge-compose-import.json','.bridge-scene-import.json','.bridge-scene-frame.json','bridge-native-build.json','bridge-native-build.log','BridgeSource.kt','BridgeScene.kt']);
await cp(path.resolve(options['--template']),workspace,{recursive:true,filter:file=>!excluded.has(path.basename(file))&&!/^\.env(?:\.|$)|\.(jks|keystore|pem|p12)$/.test(path.basename(file))});
await rm(workspace+'/app/src/main',{recursive:true});await cp(project+'/app/src/main',workspace+'/app/src/main',{recursive:true});
await writeFile(workspace+'/.bridge-native-workspace.json',JSON.stringify({...JSON.parse(await readFile(workspace+'/.bridge-native-workspace.json')),sourceProject:project}));
const file='app/src/main/java/com/arttvad9r/mealio/ui/screens/SettingsScreen.kt',previewFile='app/src/debug/java/com/arttvad9r/mealio/bridge/MealioAcceptancePreview.kt',testFile='app/src/androidTest/java/com/arttvad9r/mealio/bridge/MealioAcceptanceTest.kt';
for(const [name,fixture] of [[previewFile,'MealioAcceptancePreview.kt'],[testFile,'MealioAcceptanceTest.kt']]){await mkdir(path.dirname(workspace+'/'+name),{recursive:true});await writeFile(workspace+'/'+name,await readFile(new URL(fixture,import.meta.url)));}
await writeFile(workspace+'/gradle.properties',(await readFile(workspace+'/gradle.properties','utf8'))+'\nkotlin.compiler.execution.strategy=in-process\n');
const gradle=workspace+'/app/build.gradle.kts';await writeFile(gradle,(await readFile(gradle,'utf8')).replace('applicationId = "com.arttvad9r.mealio"','applicationId = "com.arttvad9r.mealio.bridgeacceptance"').replace('androidx.test.ext:junit:1.2.1','androidx.test.ext:junit:1.3.0').replace('androidx.test:runner:1.6.2','androidx.test:runner:1.7.0').replace('androidx.test:core:1.6.1','androidx.test:core:1.7.0')+'\ndependencies { androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0") }\n');
let adapter=JSON.parse(await readFile(new URL('mealio-adapter.json',import.meta.url)));
const display={size:(await adb('shell','wm','size')).stdout,density:(await adb('shell','wm','density')).stdout,fontScale:(await adb('shell','settings','get','system','font_scale')).stdout.trim()};
await writeFile(out+'/original-display.json',JSON.stringify(display,null,2));
const save=(name,value)=>writeFile(out+'/'+name+'.json',JSON.stringify(value,null,2)),hash=s=>createHash('sha256').update(s).digest('hex');
let browser,page,servers=[],connections=[];const evidence={project,originalRevision,serial,originalDisplay:display,cycles:[],variants:[],browserErrors:[]};
async function start(name,document){const data=out+'/'+name;await mkdir(data);if(document)await writeFile(data+'/session.json',JSON.stringify({revision:0,baseline:document,current:document,applied:null}));const child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});servers.push(child);let log='';child.stderr.on('data',chunk=>log+=chunk);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),10000);child.once('error',reject);child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});}
async function capture(name,variant='Light'){
 console.log(name+': сборка настоящего SettingsScreen');const source=await readFile(workspace+'/'+file,'utf8');adapter.calls.forEach(rule=>rule.fileHash=hash(source));await save(name+'-adapter',adapter);
 const scene=await prepareScene(workspace,adapter);await instrumentScene(scene);let frame;
 try{const catalog=await build(workspace);await save(name+'-build',catalog);const url=await start(name+'-native'),connection=await launch({workspace,serial,url,screenState:name+' · SettingsScreen',preview:'com.arttvad9r.mealio.bridge.MealioAcceptancePreviewKt.MealioAcceptance'+variant,sdk:tools.sdk});connections.push(connection);
  frame=(await(await fetch(url+'/api/native')).json()).frame;frame.image=Buffer.from(await(await fetch(url+'/api/native/image')).arrayBuffer()).toString('base64');await save(name+'-frame',frame);await writeFile(out+'/'+name+'-native.png',Buffer.from(frame.image,'base64'));await stop(connection);connections=connections.filter(c=>c!==connection);
 }finally{await restoreScene(workspace);}
 const document=await bindScene(scene,frame);await save(name+'-document',document);return {document,frame,png:Buffer.from(frame.image,'base64')};
}
async function render(name,captured){
 const url=await start(name+'-editor',captured.document);await page.goto(url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);
 await page.addStyleTag({content:'.layout-node.selected{outline:none!important}.layout-node.selected:before,.selection-frame{visibility:hidden!important}'});
 const metrics=await page.evaluate(()=>{const phone=document.querySelector('#after .phone').getBoundingClientRect();return Object.fromEntries([...document.querySelectorAll('#after [data-node-id]')].map(element=>{const r=element.getBoundingClientRect(),label=element.querySelector(':scope > .text-content');let lines=[];if(label){const range=document.createRange();range.selectNodeContents(label);lines=[...new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top)))];}return [element.dataset.nodeId,{x:r.x-phone.x,y:r.y-phone.y,width:r.width,height:r.height,lines:lines.length,color:getComputedStyle(element).color,background:getComputedStyle(element).backgroundColor}];}));});
 const map=indexTree(captured.document.root),density=captured.frame.densityDpi/160,regions={};let checked=0;
 for(const [id,{node}] of map){const binding=captured.document.compose.bindings[id],native=captured.frame.nodes.find(n=>n.properties.bridgeSourceKey===binding.runtimeIdentity),bounds=String(native.properties.bridgeBounds).split(',').map(Number),root=String(captured.frame.nodes.find(n=>n.properties.bridgeSourceKey===captured.document.compose.bindings[captured.document.root.id].runtimeIdentity).properties.bridgeBounds).split(',').map(Number);
  for(const [key,value] of Object.entries({x:(bounds[0]-root[0])/density,y:(bounds[1]-root[1])/density,width:bounds[2]/density,height:bounds[3]/density})){assert.ok(Math.abs(metrics[id][key]-value)<0.6,`${name}/${node.type}/${key}: ${metrics[id][key]} != ${value}`);checked++;}
  regions[id]={left:bounds[0],top:bounds[1],right:bounds[0]+bounds[2],bottom:bounds[1]+bounds[3]};
 }
 const bytes=await page.locator('#after .phone').screenshot();await writeFile(out+'/'+name+'-browser.png',bytes);const pixels=comparePng(captured.png,bytes,{regions});const visual=verifyMealioVisual(captured.document,captured.png,bytes);await save(name+'-visual-check',visual);await save(name+'-browser-check',{checked,metrics,pixels,visualChecked:{text:visual.text.length,paint:visual.paint.length}});
 console.log(name+': '+checked+' проверок геометрии, сравнение регионов сохранено');return {url,metrics,pixels,visualChecked:{text:visual.text.length,paint:visual.paint.length}};
}
async function callbacks(name,removedDark){await writeFile(workspace+'/'+testFile,(await readFile(new URL('MealioAcceptanceTest.kt',import.meta.url),'utf8')).replace('val removedDark = false','val removedDark = '+removedDark));const log=await open(out+'/'+name+'-callbacks.log','w');try{const status=await new Promise((resolve,reject)=>{const child=spawn(workspace+'/gradlew',[':app:connectedDebugAndroidTest','--console=plain','-Pandroid.testInstrumentationRunnerArguments.class=com.arttvad9r.mealio.bridge.MealioAcceptanceTest'],{cwd:workspace,env:{...process.env,JAVA_HOME:tools.jdkHome,ANDROID_SERIAL:serial},stdio:['ignore',log.fd,log.fd]});child.on('error',reject);child.on('close',resolve);});assert.equal(status,0,'Android callback-тест: '+name);console.log(name+': callbacks и ресурсы подтверждены');}finally{await log.close();}}
try{
 await adb('shell','wm','size','720x2000');await adb('shell','wm','density','320');await adb('shell','settings','put','system','font_scale','1');
 browser=await chromium.launch();page=await browser.newPage({viewport:{width:1700,height:1400},deviceScaleFactor:2});page.on('pageerror',e=>evidence.browserErrors.push(e.message));
 let previous=await capture('0');const rendered=await render('0',previous);evidence.variants.push({name:'0',...rendered});
 for(let cycle=1;cycle<=2;cycle++){
  const url=cycle===1?rendered.url:(await render('baseline-2',previous)).url;
  const target=Object.entries(previous.document.compose.bindings).find(([id,b])=>b.call==='FilterChip'&&b.instance==='mode.name'&&b.runtimeIdentity.endsWith('/DARK'));assert.ok(target);
  await page.locator('#tree [data-node-id="'+target[0]+'"]').click();
  if(cycle===1){const field=page.getByLabel('Фон',{exact:true});await field.locator('xpath=ancestor::details').evaluate(e=>e.open=true);await field.fill('#fff2cc');await field.blur();}else await page.getByRole('button',{name:'Удалить элемент',exact:true}).click();
  await page.locator('#apply').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Снимок сохранён'));const handoff=await(await fetch(url+'/api/handoff')).json();await save(cycle+'-handoff',handoff);assert.equal(handoff.applied.mode,'test');assert.ok(handoff.transfer.requiresAgent.length);
  let source=await readFile(workspace+'/'+file,'utf8');assert.equal(hash(source),previous.document.compose.sourceHashes[file]);
  if(cycle===1){source=source.replace('shape = Radius.field,',`shape = Radius.field,\n                            colors = androidx.compose.material3.FilterChipDefaults.filterChipColors(\n                                containerColor = if (mode == ThemeMode.DARK) androidx.compose.ui.graphics.Color(0xFFFFF2CC) else androidx.compose.ui.graphics.Color.Unspecified,\n                                selectedContainerColor = if (mode == ThemeMode.DARK) androidx.compose.ui.graphics.Color(0xFFFFF2CC) else androidx.compose.ui.graphics.Color.Unspecified,\n                            ),`);const rule=adapter.calls.find(r=>r.call==='FilterChip'&&r.instance==='mode.name');rule.background='if (mode == ThemeMode.DARK) androidx.compose.ui.graphics.Color(0xFFFFF2CC) else '+rule.background;
  }else source=source.replace('ThemeMode.entries.forEach { mode ->','ThemeMode.entries.filter { it != ThemeMode.DARK }.forEach { mode ->');
  await writeFile(workspace+'/'+file,source);const after=await capture(String(cycle));await render(String(cycle),after);
  const remaining=Object.entries(after.document.compose.bindings).filter(([id,b])=>b.call==='FilterChip');assert.equal(remaining.length,cycle===1?6:5);
  if(cycle===1){assert.equal(after.document.compose.bindings[target[0]].runtimeIdentity,target[1].runtimeIdentity);assert.equal(indexTree(after.document.root).get(target[0]).node.props.background,'#FFF2CC');}
  else assert.ok(!after.document.compose.bindings[target[0]]);
  const regions={};for(const n of previous.frame.nodes.filter(n=>n.properties.bridgeSourceKey?.includes('/mealio-')&&n.properties.bridgeSourceKey?.match(/\/(SYSTEM|LIGHT|DARK|RUSSIAN|ENGLISH)$/)))regions[n.properties.bridgeSourceKey]=n.bounds;
  const comparison=comparePng(previous.png,after.png,{regions});await save(cycle+'-native-comparison',comparison);for(const [id,value] of Object.entries(comparison.regions))if(!id.endsWith('/DARK'))assert.equal(value.differentFraction,0,'Неизменённый сосед '+id);
  assert.deepEqual(await(await fetch(url+'/api/handoff')).json(),handoff);await callbacks(String(cycle),cycle===2);evidence.cycles.push({cycle,target:target[0],snapshot:handoff.applied,sourceRevision:after.document.sourceRevision,neighbors:comparison.regions});previous=after;
 }
 for(const [name,variant,size,fontScale] of [['dark','Dark','720x2000','1'],['long','Long','720x2000','1'],['compact-large','Long','640x1600','1.6'],['large-full','Long','640x2400','1.6']]){await adb('shell','wm','size',size);await adb('shell','settings','put','system','font_scale',fontScale);const captured=await capture(name,variant),check=await render(name,captured);evidence.variants.push({name,...check});}
 assert.deepEqual(evidence.browserErrors,[]);assert.equal(await sourceRevision(project),originalRevision);evidence.originalUnchanged=true;await save('evidence',evidence);console.log('Доказательства: '+out);
}finally{
 if(browser)await browser.close();for(const c of connections)await stop(c).catch(()=>{});for(const child of servers)if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
 await adb('shell','wm','size',display.size.match(/Override size:\s*(\d+x\d+)/)?.[1]||'reset');await adb('shell','wm','density',display.density.match(/Override density:\s*(\d+)/)?.[1]||'reset');await adb('shell','settings',display.fontScale==='null'?'delete':'put','system','font_scale',...(display.fontScale==='null'?[]:[display.fontScale]));console.log('Настройки тестового эмулятора восстановлены');
}
