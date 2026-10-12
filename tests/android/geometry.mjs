// Optional Android acceptance: isolated workspace/session; own AVD or an explicitly selected test emulator.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,open,readdir} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {importCompose,instrumentWorkspace,restoreWorkspace,planCompose,writeComposePlan} from '../../compose.mjs';
import {sourceRevision,build} from '../../scripts/native-project.mjs';
import {launch,stop} from '../../scripts/native-device.mjs';
import {decodePng} from '../../scripts/compare-png.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url)),exec=promisify(execFile),options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--template','--output','--sdk','--port','--serial'].includes(key)||!process.argv[i+1]||options[key])throw Error('Нужны --template <подготовленная копия> --output <новый каталог> [--sdk <SDK> --port <порт> или --serial <тестовый эмулятор>]');options[key]=process.argv[i+1];}
if(!options['--template']||!options['--output'])throw Error('Нужны --template и --output');
const template=path.resolve(options['--template']),out=path.resolve(options['--output']),workspace=path.join(out,'workspace');
if(out===template||out.startsWith(template+path.sep)||template.startsWith(out+path.sep))throw Error('Результаты должны находиться отдельно от шаблона');
const sdk=options['--sdk']||process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;
if(!sdk)throw Error('Нужен --sdk или ANDROID_HOME');
if(options['--port']&&options['--serial'])throw Error('Выберите --port или --serial');
if(options['--serial']&&!/^emulator-\d+$/.test(options['--serial']))throw Error('--serial требует явный emulator-<порт>');
const external=Boolean(options['--serial']),port=Number(options['--port']||options['--serial']?.slice(9)||5586),serial='emulator-'+port;
const acceleration=process.env.BRIDGE_TEST_ACCEL||'auto';
if(!['auto','off'].includes(acceleration))throw Error('BRIDGE_TEST_ACCEL: auto или off');
if(!Number.isInteger(port)||port<5554||port>5682||port%2)throw Error('Порт эмулятора должен быть чётным от 5554 до 5682');
const marker=JSON.parse(await readFile(path.join(template,'.bridge-native-workspace.json'),'utf8'));
if(marker.module!==':app')throw Error('Стенд требует подготовленный :app workspace');
const adb=(...args)=>exec(path.join(sdk,'platform-tools/adb'),['-s',serial,...args],{maxBuffer:4*1024*1024,timeout:30000});
const devices=(await exec(path.join(sdk,'platform-tools/adb'),['devices'])).stdout;
if(!external&&devices.includes(serial))throw Error('Порт тестового эмулятора занят');
if(external&&!devices.split('\n').some(line=>line.trim()===serial+'\tdevice'))throw Error('Выбранный тестовый эмулятор не готов в ADB');
await mkdir(out); // Refuse to reuse any previous verification directory.
const originalRevision=await sourceRevision(template),file='app/src/main/java/dev/composevisualbridge/acceptance/GeometryScreen.kt';
const excluded=new Set(['.git','.gradle','.kotlin','build','.bridge-compose-import.json','.bridge-scene-import.json','bridge-native-build.json','bridge-native-build.log','BridgeSource.kt','BridgeScene.kt']);
await cp(template,workspace,{recursive:true,filter:filename=>!excluded.has(path.basename(filename))});
await writeFile(path.join(workspace,'.bridge-native-workspace.json'),JSON.stringify({...marker,sourceProject:template}));
await mkdir(path.dirname(path.join(workspace,file)),{recursive:true});
await writeFile(path.join(workspace,file),await readFile(new URL('./GeometryScreen.kt',import.meta.url)));
const appGradle=path.join(workspace,'app/build.gradle.kts');
await writeFile(appGradle,(await readFile(appGradle,'utf8')).replace(/applicationId\s*=\s*"[^"]+"/,'applicationId = "dev.composevisualbridge.geometry"'));
// Old imported/generated screens are not part of this independent scene.
const sourceDir=path.dirname(path.join(workspace,file));
const {rm}=await import('node:fs/promises');
for(const name of await readdir(sourceDir))if(['TestScreen.kt','CreatedScreen.kt'].includes(name))await rm(path.join(sourceDir,name));
const avds=path.join(out,'avds'),avd=path.join(avds,'Geometry.avd');if(!external){await mkdir(avd,{recursive:true});
await writeFile(path.join(avds,'Geometry.ini'),`avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-36\n`);
await writeFile(path.join(avd,'config.ini'),`AvdId=Geometry\navd.ini.displayname=Compose Geometry\nabi.type=x86_64\nhw.cpu.arch=x86_64\nhw.cpu.ncore=2\nhw.ramSize=1536\nhw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=320\nhw.gpu.enabled=yes\nhw.gpu.mode=swiftshader_indirect\nhw.keyboard=yes\nhw.camera.back=none\nhw.camera.front=none\nhw.audioInput=no\nhw.sdCard=no\nimage.sysdir.1=system-images/android-36/google_apis_playstore/x86_64/\ntag.id=google_apis_playstore\ndisk.dataPartition.size=2147483648\nshowDeviceFrame=no\nfastboot.forceColdBoot=yes\nvm.heapSize=256\n`);}
const log=await open(path.join(out,'emulator.log'),'w');
let emulator,browser,display,connections=[],servers=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(name,document){
 const data=path.join(out,name);await mkdir(data);
 if(document)await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline:document,current:document,applied:null}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});servers.push(child);
 let output='';child.stderr.on('data',chunk=>output+=chunk);
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output||'Сервер не запустился')),10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
 return {url,data};
}
async function capture(cycle){
 console.log(`Цикл ${cycle}: импорт, инструментирование и debug-сборка`);
 const document=await importCompose({workspace,file,symbol:'GeometryScreen'});document.viewport.presentation='content';await instrumentWorkspace(document);
 let value;
 try{
  const catalog=await build(workspace);await writeFile(path.join(out,`${cycle}-build.json`),JSON.stringify(catalog,null,2));
  const server=await start(`native-${cycle}`),connection=await launch({workspace,serial,url:server.url,screenState:`Геометрия · цикл ${cycle}`,preview:'dev.composevisualbridge.acceptance.GeometryScreenKt.GeometryPreview',sdk});connections.push(connection);
  value=await(await fetch(server.url+'/api/native')).json();value.frame.image=Buffer.from(await(await fetch(server.url+'/api/native/image')).arrayBuffer()).toString('base64');
  await writeFile(path.join(out,`${cycle}-native.png`),Buffer.from(value.frame.image,'base64'));await writeFile(path.join(out,`${cycle}-capture.json`),JSON.stringify(value,null,2));
  await stop(connection);connections=connections.filter(c=>c!==connection);
 }finally{await restoreWorkspace(workspace);}
 assert.equal(await sourceRevision(workspace),document.compose.workspaceRevision,'Восстановление должно вернуть исходную ревизию');
 const byKey=new Map(value.frame.nodes.map(node=>[node.properties.bridgeSourceKey,node])),density=value.frame.densityDpi/160;
 const rect=node=>({x:node.bounds.left/density,y:node.bounds.top/density,width:(node.bounds.right-node.bounds.left)/density,height:(node.bounds.bottom-node.bounds.top)/density});
 const geometry={};for(const box of document.root.children){const child=box.children[0],outer=rect(byKey.get(box.id)),inner=rect(byKey.get(child.id));geometry[child.props.text]={outer,inner,insetX:inner.x-outer.x,insetY:inner.y-outer.y};}
 await writeFile(path.join(out,`${cycle}-import.json`),JSON.stringify(document,null,2));return {document,geometry};
}
function check(geometry,expected){for(const [label,values] of Object.entries(expected)){const g=geometry[label],actual=[g.outer.width,g.outer.height,g.inner.width,g.inner.height,g.insetX,g.insetY];assert.deepEqual(actual,values,`${label}: реальные размеры и отступы`);}}
async function browserGeometry(page,document){
 return page.evaluate(nodes=>{const phone=document.querySelector('#after .phone').getBoundingClientRect();return Object.fromEntries(nodes.map(({label,id,childId})=>{const outer=document.querySelector(`#after [data-node-id="${id}"]`).getBoundingClientRect(),inner=document.querySelector(`#after [data-node-id="${childId}"]`).getBoundingClientRect();return [label,{outer:{x:outer.x-phone.x,y:outer.y-phone.y,width:outer.width,height:outer.height},inner:{x:inner.x-phone.x,y:inner.y-phone.y,width:inner.width,height:inner.height},insetX:inner.x-outer.x,insetY:inner.y-outer.y}];}));},document.root.children.map(node=>({label:node.children[0].props.text,id:node.id,childId:node.children[0].id})));
}
try{
 if(external){
  display={size:(await adb('shell','wm','size')).stdout,density:(await adb('shell','wm','density')).stdout};
  await writeFile(path.join(out,'original-display.json'),JSON.stringify(display,null,2));
  await adb('shell','wm','size','720x1280');await adb('shell','wm','density','320');
  console.log('Используется '+serial+'; экран временно 720×1280, density 320');
 }else{
 emulator=spawn(path.join(sdk,'emulator/emulator'),['-avd','Geometry','-port',String(port),'-no-window','-no-audio','-no-snapshot','-gpu','swiftshader_indirect','-accel',acceleration],{env:{...process.env,ANDROID_AVD_HOME:avds},stdio:['ignore',log.fd,log.fd]});
 emulator.on('error',error=>console.error(error));
 }
 let ready=false;for(let i=0;i<(acceleration==='off'?900:180);i++){if(emulator&&emulator.exitCode!==null)throw Error('Эмулятор остановился: '+await readFile(path.join(out,'emulator.log'),'utf8'));if((await adb('shell','getprop','sys.boot_completed').catch(()=>({stdout:''}))).stdout.trim()==='1'){ready=true;break;}if(i%60===0)console.log('Ожидание загрузки тестового Android: '+i+' с');await delay(1000);}
 if(!ready)throw Error('Эмулятор не загрузился');
 const before=await capture(0);check(before.geometry,{A:[100,64,68,32,16,16],B:[132,64,100,32,16,16],C:[100,64,68,32,16,16],D:[100,64,84,32,8,16]});
 const evidence={template,originalRevision,serial,externalEmulator:external,originalDisplay:display,cycles:[{cycle:0,native:before.geometry}],browserErrors:[]};
 let previous=before;
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:2});page.on('pageerror',error=>evidence.browserErrors.push(error.message));
 for(let cycle=1;cycle<=2;cycle++){
  const server=await start(`editor-${cycle}`,previous.document);await page.goto(server.url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.evaluate(()=>document.fonts.ready);
  await page.addStyleTag({content:'.layout-node.selected{outline:none!important}.layout-node.selected:before,.selection-frame{visibility:hidden!important}'});
  const edits=cycle===1?{A:{width:'120'},B:{width:'120'},C:{paddingHorizontal:'8'},D:{paddingHorizontal:''}}:{A:{width:'140'},B:{width:'140'},C:{paddingVertical:'0'}};
  for(const [label,props] of Object.entries(edits)){const node=previous.document.root.children.find(node=>node.children[0].props.text===label);await page.locator(`#tree [data-node-id="${node.id}"]`).click();
   for(const [property,value] of Object.entries(props)){const input=page.locator(`#inspector [data-property="${property}"]`);await input.locator('xpath=ancestor::details').evaluate(details=>details.open=true);await input.fill(value);await input.press('Tab');}
  }
  await page.locator('#apply').click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Снимок сохранён'));
  const handoff=await(await fetch(server.url+'/api/handoff')).json();assert.equal(handoff.applied.mode,'test');
  const current=handoff.document,proposed=await browserGeometry(page,current);await page.locator('#after .phone').screenshot({path:path.join(out,`${cycle}-browser.png`)});
  const plan=await planCompose({baseline:previous.document,current,workspace});await writeFile(path.join(out,`${cycle}-plan.json`),JSON.stringify(plan,null,2));await writeComposePlan(plan);
  const after=await capture(cycle);
  check(after.geometry,cycle===1?{A:[120,64,88,32,16,16],B:[120,64,88,32,16,16],C:[100,64,84,32,8,16],D:[100,64,100,32,0,16]}:{A:[140,64,108,32,16,16],B:[140,64,108,32,16,16],C:[100,64,84,64,8,0],D:[100,64,100,32,0,16]});
  assert.deepEqual(await(await fetch(server.url+'/api/handoff')).json(),handoff,'Перенос не должен изменять снимок');
  evidence.cycles.push({cycle,native:after.geometry,browser:proposed,snapshot:handoff.applied,sourceRevision:after.document.compose.workspaceRevision});previous=after;
  console.log(`Цикл ${cycle}: нативные границы и отступы подтверждены`);
 }
 assert.deepEqual(evidence.browserErrors,[]);assert.equal(await sourceRevision(template),originalRevision,'Шаблон не должен измениться');
 evidence.nativeVerified=true;evidence.templateUnchanged=true;
 evidence.visualDifferences=evidence.cycles.filter(c=>c.browser).flatMap(c=>Object.entries(c.native).flatMap(([label,native])=>{
  const actual=c.browser[label],differences=[];
  for(const group of ['outer','inner'])for(const axis of ['x','y','width','height'])if(Math.abs(native[group][axis]-actual[group][axis])>0.5)differences.push({cycle:c.cycle,label,property:group+'.'+axis,native:native[group][axis],browser:actual[group][axis]});
  for(const axis of ['insetX','insetY'])if(Math.abs(native[axis]-actual[axis])>0.5)differences.push({cycle:c.cycle,label,property:axis,native:native[axis],browser:actual[axis]});
  return differences;
 }));
 evidence.visualMatches=evidence.visualDifferences.length===0;
 evidence.paint=[];
 for(const cycle of evidence.cycles.filter(c=>c.browser)){
  const native=decodePng(await readFile(path.join(out,`${cycle.cycle}-native.png`))),html=decodePng(await readFile(path.join(out,`${cycle.cycle}-browser.png`)));
  assert.equal(native.width,720);assert.equal(html.width,720);
  const pixel=(png,x,y)=>Array.from(png.data.subarray((Math.floor(y*2)*png.width+Math.floor(x*2))*png.channels,(Math.floor(y*2)*png.width+Math.floor(x*2))*png.channels+3));
  for(const [label,color] of Object.entries({A:[224,239,255],B:[255,224,239],C:[224,255,239],D:[255,255,224]})){
   const box=cycle.native[label],samples=[{x:box.inner.x+box.inner.width-4,y:box.inner.y+4,color}];
   if(box.insetY>0)samples.push({x:box.outer.x+4,y:box.outer.y+4,color:[255,255,255]});
   for(const sample of samples){const actualNative=pixel(native,sample.x,sample.y),actualBrowser=pixel(html,sample.x,sample.y);assert.deepEqual(actualNative,sample.color,`${label}: фон Android`);assert.deepEqual(actualBrowser,sample.color,`${label}: фон браузера`);evidence.paint.push({cycle:cycle.cycle,label,...sample,native:actualNative,browser:actualBrowser});}
  }
 }
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
 assert.equal(evidence.visualMatches,true,'Все внешние/внутренние размеры и отступы должны совпадать');
 console.log(evidence.visualMatches?'Геометрия Android и браузера совпадает':'Нативный перенос проверен; визуальные расхождения: '+evidence.visualDifferences.length);
 console.log('Доказательства: '+out);
}finally{
 if(browser)await browser.close();for(const connection of connections)await stop(connection).catch(()=>{});
 for(const child of servers)if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
 if(emulator&&emulator.exitCode===null){const exited=once(emulator,'exit');await adb('emu','kill').catch(()=>emulator.kill());await exited;}
 if(display){await adb('shell','wm','size',display.size.match(/Override size:\s*(\d+x\d+)/)?.[1]||'reset');await adb('shell','wm','density',display.density.match(/Override density:\s*(\d+)/)?.[1]||'reset');console.log('Исходные настройки экрана восстановлены; внешний эмулятор оставлен работающим');}
 await log.close();
}
