import {readFile,writeFile,mkdir,readdir,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prepare,sourceRevision,toolchain} from './scripts/native-project.mjs';
import {prepareScene,instrumentScene,restoreScene,bindScene} from './scene.mjs';
import {normalizeBuddyFrame} from './native.mjs';
import {blankPng} from './live.mjs';
import {writeTextAtomic} from './storage.mjs';
import {generateAdapter} from './adapter.mjs';

// Test-only dependencies: Robolectric renders on the JVM, Roborazzi captures, the scanner finds @Preview.
export const PREVIEW_TOOLCHAIN={robolectric:'4.16',roborazzi:'1.46.1',scanner:'0.7.0'};
const gradleSnippet=(bom,pkg,output)=>`
// Compose Visual Bridge: JVM rendering of @Preview for the editor (test-only).
android { testOptions { unitTests.isIncludeAndroidResources = true } }
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:${PREVIEW_TOOLCHAIN.robolectric}")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:${PREVIEW_TOOLCHAIN.roborazzi}")
    testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:${PREVIEW_TOOLCHAIN.scanner}")
    testImplementation(platform("androidx.compose:compose-bom:${bom}"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
tasks.withType<Test>().configureEach {
    systemProperty("roborazzi.test.record", "true")
    systemProperty("bridge.package", ${JSON.stringify(pkg)})
    systemProperty("bridge.output", ${JSON.stringify(output)})
}
`;

/** Renders every @Preview of the project copy on the JVM and binds each frame to the adapter's Kotlin calls. */
export async function capturePreviews({project,output,adapter,module=':app',sdk}){
 if(adapter&&(!['compose-visual-bridge-live-adapter-v1','compose-visual-bridge-scene-adapter-v1'].includes(adapter.format)||!Array.isArray(adapter.calls)))throw Error('Нужен адаптер со связями экранов');
 const tools=await toolchain();if(!tools.jdkHome||tools.jdkMajor<21)throw Error('Нужен JDK 21');
 const {workspace}=await prepare({project,output,module,sdk,liveOnly:true});
 // Without an explicit adapter the bindings are derived from the copy's Kotlin sources.
 const generated=adapter?null:await generateAdapter(workspace,{module});
 if(generated?.unsupported.length)throw Error('Неполный импорт Preview: '+generated.unsupported.map(item=>`${item.file}:${item.line || '?'} — ${item.symbol}: ${item.call || item.symbol} (${item.reason})`).join('; ')+'. Подготовьте отдельную проверяемую сцену или явный адаптер, затем сверьте макет с кадром.');
 if(generated&&!generated.adapter.calls.length)throw Error('Не найдено экранов: нужны @Preview, вызывающие Composable-экраны проекта'+(generated.skipped.length?' ('+generated.skipped.map(s=>s.function+' — '+s.reason).join('; ')+')':''));
 // The host is only needed for the live overlay; previews call screens directly.
 const sceneAdapter={...structuredClone(adapter||generated.adapter),format:'compose-visual-bridge-live-adapter-v1'};
 const moduleDir=path.join(workspace,module.slice(1).replaceAll(':','/')),gradle=path.join(moduleDir,'build.gradle.kts');
 const appGradle=await readFile(gradle,'utf8');
 const pkg=appGradle.match(/namespace\s*=\s*"([\w.]+)"/)?.[1];if(!pkg)throw Error('В build.gradle.kts модуля нужен явный namespace');
 const bom=(appGradle.match(/compose-bom:([\w.-]+)"/)||(await readFile(path.join(workspace,'gradle/libs.versions.toml'),'utf8').catch(()=>'')).match(/composeBom\s*=\s*"([\w.-]+)"/))?.[1];
 if(!bom)throw Error('Не найдена версия Compose BOM');
 const frames=path.join(moduleDir,'build/compose-visual-bridge-previews');
 if(generated){await mkdir(path.join(moduleDir,'build'),{recursive:true});await writeFile(path.join(moduleDir,'build/compose-visual-bridge-adapter.json'),JSON.stringify(generated,null,1));}
 await writeFile(gradle,appGradle+gradleSnippet(bom,pkg,frames));
 const helper=path.join(moduleDir,'src/test/java/dev/composevisualbridge/capture/BridgePreviewCapture.kt');
 await mkdir(path.dirname(helper),{recursive:true});await writeFile(helper,await readFile(new URL('./integrations/android/BridgePreviewCapture.kt',import.meta.url)),{flag:'wx'});
 const scene=await prepareScene(workspace,sceneAdapter);let revision,instrumented=false;
 try{
  await instrumentScene(scene);instrumented=true;revision=scene.instrumentedRevision;
  await rm(frames,{recursive:true,force:true});
  await mkdir(path.join(moduleDir,'build'),{recursive:true});const log=path.join(moduleDir,'build/bridge-previews.log'),handle=await open(log,'w');let code;
  try{code=await new Promise((resolve,reject)=>{const child=spawn(path.join(workspace,'gradlew'),[module+':testDebugUnitTest','--tests','dev.composevisualbridge.capture.BridgePreviewCapture','--console=plain'],{cwd:workspace,env:{...process.env,JAVA_HOME:tools.jdkHome},stdio:['ignore',handle.fd,handle.fd]});child.on('error',reject);child.on('close',resolve);});}
  finally{await handle.close();}
  if(await sourceRevision(workspace)!==revision)throw Error('Исходники изменились во время отрисовки');
  if(code!==0){
   if(/No tests found for given includes/.test(await readFile(log,'utf8').catch(()=>'')))throw Error(`Сканер не нашёл ни одного @Preview в пакете ${pkg}. Лог: ${log}`);
   throw Error(`Отрисовка Preview не прошла (код ${code}). Лог: ${log}`);
  }
 }finally{if(instrumented)await restoreScene(workspace);}
 const screens=[],skipped=[];
 for(const name of (await readdir(frames).catch(()=>[])).filter(n=>n.endsWith('.json')).sort()){
  const raw=JSON.parse(await readFile(path.join(frames,name),'utf8'));
  try{
   if(blankPng(raw.image))throw Error('Пустой кадр');
   const frame=normalizeBuddyFrame(raw,{sourceRevision:revision,screenState:raw.preview});frame.provider='compose-visual-bridge-jvm';
   const document=await bindScene(scene,frame),rootRule=document.compose.bindings[document.root.id];
   document.name=raw.preview;document.state={...document.state,screen:rootRule.key,screenState:'превью',entry:'preview',function:raw.function};
   screens.push({document,frame});
  }catch(error){skipped.push({preview:raw.preview,function:raw.function,reason:error.message});}
 }
 await writeTextAtomic(path.join(workspace,'.bridge-previews.json'),JSON.stringify({format:'compose-visual-bridge-previews-v1',revision,screens:screens.map(s=>s.document.name),skipped,unbound:generated?.skipped||[]}));
 if(!screens.length)throw Error('Ни один Preview не связан с экранами адаптера'+(skipped.length?': '+skipped.map(s=>s.preview+' — '+s.reason).join('; '):'. Добавьте @Preview с тестовыми данными.'));
 return {workspace,screens,skipped,adapter:sceneAdapter,unbound:generated?.skipped||[]};
}
