import {readFile,writeFile,mkdir,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepare,build,sourceRevision,toolchain} from './scripts/native-project.mjs';
import {prepareScene,instrumentScene,restoreScene,bindScene} from './scene.mjs';
import {normalizeBuddyFrame} from './native.mjs';
import {writeTextAtomic} from './storage.mjs';
const exec=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
function device(sdk,serial){if(!sdk||!/^emulator-\d+$/.test(serial||''))throw Error('Нужен SDK и выделенный тестовый эмулятор');return args=>exec(path.join(sdk,'platform-tools/adb'),['-s',serial,...args],{maxBuffer:16*1024*1024,timeout:30000});}
export async function withLiveHost(filename,call,operation){
 const original=await readFile(filename,'utf8');if(typeof call!=='string'||!call.trim()||original.split(call).length!==2)throw Error('Host устарел или вызов неоднозначен');
 const wrapped=original.replace(call,`dev.composevisualbridge.capture.BridgeLiveHost { ${call} }`);
 await writeTextAtomic(filename,wrapped);
 let result,failure;try{result=await operation();}catch(error){failure=error;}
 try{const current=await readFile(filename,'utf8');if(current===wrapped)await writeTextAtomic(filename,original);else if(current!==original)throw Error('Host изменился во время подготовки; новые правки сохранены');}
 catch(recovery){if(failure)throw new AggregateError([failure,recovery],`Ошибка подготовки: ${failure.message}. Host не восстановлен: ${recovery.message}`);throw recovery;}
 if(failure)throw failure;return result;
}
export async function prepareLive({project,output,adapter,serial,sdk,module=':app'}){
 if(adapter?.format!=='compose-visual-bridge-live-adapter-v1'||!adapter.host||!Array.isArray(adapter.calls))throw Error('Нужен live-адаптер с host и связями экранов');
 if(!sdk)throw Error('Нужен Android SDK');if(serial)device(sdk,serial);
 const host=adapter.host;if(typeof host.file!=='string'||path.isAbsolute(host.file)||host.file.split(/[\\/]/).includes('..')||!host.file.endsWith('.kt')||typeof host.call!=='string'||!host.call.trim())throw Error('Нужна относительная Kotlin-связь host');
 if(adapter.calls.some(rule=>!rule.key||rule.file===host.file))throw Error('Для live нужны явные стабильные ключи; host должен быть отдельным от связей экранов');
 const tools=await toolchain();if(!tools.jdkHome||tools.jdkMajor<21)throw Error('Нужен JDK 21 для debug-сборки');
 const {workspace}=await prepare({project,output,module,sdk,liveOnly:true});
 const properties=path.join(workspace,'gradle.properties');await writeTextAtomic(properties,(await readFile(properties,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}))+'\nkotlin.compiler.execution.strategy=in-process\n');
 await exec(path.join(tools.jdkHome,'bin/keytool'),['-genkeypair','-keystore',path.join(workspace,'.bridge-test-debug.keystore'),'-alias','androiddebugkey','-storepass','android','-keypass','android','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Android Debug,O=Android,C=US']);
 const appGradle=path.join(workspace,module.slice(1).replaceAll(':','/'),'build.gradle.kts');await writeTextAtomic(appGradle,(await readFile(appGradle,'utf8'))+'\nandroid { signingConfigs { getByName("debug") { storeFile = rootProject.file(".bridge-test-debug.keystore") } }; buildTypes { getByName("debug") { applicationIdSuffix = ".composebridge" } } }\n');
 const filename=await realpath(path.join(workspace,host.file));if(!filename.startsWith(workspace+path.sep))throw Error('Host выходит из копии');
 const original=await readFile(filename,'utf8');if(hash(original)!==host.fileHash)throw Error('Host устарел или вызов неоднозначен');
 const prepared=await withLiveHost(filename,host.call,async()=>{
  const helper=path.join(workspace,module.slice(1).replaceAll(':','/'),'src/debug/java/dev/composevisualbridge/capture/BridgeLiveCapture.kt');await mkdir(path.dirname(helper),{recursive:true});await writeFile(helper,await readFile(new URL('./integrations/android/BridgeLiveCapture.kt',import.meta.url)),{flag:'wx'});
  const scene=await prepareScene(workspace,structuredClone(adapter));let instrumented=false;
  try{
   await instrumentScene(scene);instrumented=true;const built=await build(workspace);
   const versions=(await readdir(path.join(sdk,'build-tools'))).filter(v=>/^\d+(?:\.\d+)*$/.test(v)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
   const badging=(await exec(path.join(sdk,'build-tools',versions.at(-1),'aapt'),['dump','badging',path.join(workspace,built.apk)])).stdout;
   const applicationId=badging.match(/^package: name='([\w.]+)'/m)?.[1],activity=badging.match(/^launchable-activity: name='([\w.]+)'/m)?.[1];if(!applicationId||!activity)throw Error('У debug APK нет основной Activity');
   return {scene,built,applicationId,activity};
  }finally{if(instrumented)await restoreScene(workspace);}
 });
 prepared.scene.workspaceRevision=await sourceRevision(workspace);
 const live={format:'compose-visual-bridge-live-v1',captureProtocol:2,workspace,...prepared,sdk,serial:null,startedAt:null};
 await writeTextAtomic(path.join(workspace,'.bridge-live.json'),JSON.stringify(live));
 if(serial)return launchLive(workspace,{serial});
 return {workspace,applicationId:live.applicationId,serial:null,sourceRevision:live.built.sourceRevision,next:'Debug-сборка готова. Выполните live-run с выделенным эмулятором, перейдите на экран приложения и нажмите «Редактировать экран».'};
}
export async function launchLive(workspace,{serial}){
 const root=await realpath(workspace),live=JSON.parse(await readFile(path.join(root,'.bridge-live.json'),'utf8'));
 if(live.format!=='compose-visual-bridge-live-v1'||live.workspace!==root||await sourceRevision(root)!==live.scene.workspaceRevision)throw Error('Исходники live-копии изменились');
 if(live.captureProtocol!==2)throw Error('Подготовьте новую live-сборку с идентификатором запуска: prepare-live');
 const apk=path.resolve(root,live.built.apk);if(!apk.startsWith(root+path.sep)||hash(await readFile(apk))!==live.built.apkSha256)throw Error('Debug APK изменился');
 const adb=device(live.sdk,serial);if((await adb(['get-state'])).stdout.trim()!=='device')throw Error('Эмулятор недоступен');
 const launchId=randomUUID();
 const installed=await adb(['install','-r',apk]);if(!installed.stdout.includes('Success'))throw Error('Не удалось установить debug-копию');
 await adb(['shell','run-as',live.applicationId,'rm','-f','files/compose-visual-bridge-live.json']);
 await adb(['shell','run-as',live.applicationId,'mkdir','-p','files']);
 await adb(['shell','run-as',live.applicationId,'sh','-c',`'echo ${launchId} > files/compose-visual-bridge-live-launch.txt'`]);
 const started=await adb(['shell','am','start','-S','-W','-n',live.applicationId+'/'+live.activity]);if(/Error:|Exception/.test(started.stdout+started.stderr))throw Error('Не удалось открыть приложение');
 Object.assign(live,{serial,startedAt:Date.now(),launchId});await writeTextAtomic(path.join(root,'.bridge-live.json'),JSON.stringify(live));
 return {workspace:root,applicationId:live.applicationId,serial,sourceRevision:live.built.sourceRevision,next:'Перейдите на экран приложения, нажмите «Редактировать экран» и выполните edit-live.'};
}
export async function captureLive(workspace){
 const root=await realpath(workspace),live=JSON.parse(await readFile(path.join(root,'.bridge-live.json'),'utf8'));
 if(live.format!=='compose-visual-bridge-live-v1'||live.workspace!==root||live.scene.workspace!==root||await sourceRevision(root)!==live.scene.workspaceRevision)throw Error('Копия live-приложения изменилась; подготовьте новую сборку');
 const adb=device(live.sdk,live.serial),apk=path.resolve(root,live.built.apk);if(!apk.startsWith(root+path.sep)||hash(await readFile(apk))!==live.built.apkSha256)throw Error('Debug APK изменился');
 const installed=(await adb(['shell','pm','path',live.applicationId])).stdout.trim().split('\n').find(line=>line.endsWith('/base.apk'))?.slice(8);if(!installed||!/^\/[\w./=+~-]+$/.test(installed))throw Error('Не найден установленный APK');
 if((await adb(['shell','sha256sum',installed])).stdout.split(/\s+/)[0]!==live.built.apkSha256)throw Error('В эмуляторе другая сборка приложения');
 let raw;try{raw=JSON.parse((await adb(['shell','run-as',live.applicationId,'cat','files/compose-visual-bridge-live.json'])).stdout);}catch{throw Error('Перейдите на экран приложения и нажмите «Редактировать экран»');}
 if(!/^[a-f0-9-]{36}$/.test(raw.captureId||'')||!Number.isFinite(raw.capturedAt)||(live.launchId?raw.launchId!==live.launchId:raw.capturedAt<live.startedAt))throw Error('Захват относится к прежнему запуску');
 const frame=normalizeBuddyFrame(raw,{sourceRevision:live.built.sourceRevision,screenState:'Текущий экран работающего приложения'});frame.provider='compose-visual-bridge-live';
 const document=await bindScene(live.scene,frame),rootRule=document.compose.bindings[document.root.id];
 document.name=rootRule.name||rootRule.source.symbol;document.state={...document.state,screen:rootRule.key,screenState:document.name+(raw.systemTheme==='dark'?' · системная тёмная тема':raw.systemTheme==='light'?' · системная светлая тема':''),systemTheme:['light','dark'].includes(raw.systemTheme)?raw.systemTheme:null,entry:'live',captureId:raw.captureId};
 return {document,frame,captureId:raw.captureId};
}
