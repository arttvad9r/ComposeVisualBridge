import {readFile,writeFile,mkdir,rm,readdir,lstat,realpath,copyFile,chmod,open} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
export const TOOLCHAIN={buddy:'0.3.0',ksp:'2.3.6',kotlin:'2.3.20',jdk:21};
const marker='.bridge-native-workspace.json';
const ignored=new Set(['.git','.gradle','.kotlin','build','node_modules','keystore']);
const internal=new Set([marker,'.bridge-compose-import.json','.bridge-scene-import.json','.bridge-scene-frame.json','bridge-native-build.log','bridge-native-build.json','local.properties','.bridge-live.json']);
const secret=name=>name==='keystore.properties'||/^\.env(?:\.|$)/.test(name)||/\.(?:jks|keystore|pem|p12)$/.test(name);

export async function toolchain() {
  let jdkHome=process.env.BRIDGE_JAVA_HOME||process.env.JAVA_HOME;
  if(!jdkHome){const candidate=path.join(process.env.BRIDGE_HOME||path.join(process.env.XDG_DATA_HOME||path.join(homedir(),'.local/share'),'compose-visual-bridge'),'toolchains/jdk-21.0.2');if(await lstat(path.join(candidate,'bin/java')).catch(()=>null))jdkHome=candidate;}
  const version=await exec(jdkHome?path.join(jdkHome,'bin/java'):'java',['-version']).catch(()=>({stdout:'',stderr:''}));
  const jdkMajor=Number((version.stderr+version.stdout).match(/version\s+"(\d+)/)?.[1])||0;
  const candidate=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||path.join(homedir(),'Android/Sdk');
  const sdk=await lstat(path.join(candidate,'platform-tools/adb')).catch(()=>null)?candidate:null;
  return {jdkHome:jdkHome||null,jdkMajor,sdk,nodeReady:Number(process.versions.node.split('.')[0])>=22,buildReady:jdkMajor>=21&&!!sdk};
}
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
function modulePath(value=':app') {
  if(!/^:[A-Za-z][\w-]*(?::[A-Za-z][\w-]*)*$/.test(value))throw Error('Модуль должен иметь вид :app или :feature:ui');
  return value.slice(1).split(':').join(path.sep);
}
export async function files(root,prefix='') {
  const result=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})) {
    if(ignored.has(entry.name)||internal.has(entry.name)||secret(entry.name))continue;
    const relative=path.join(prefix,entry.name);
    if(entry.isSymbolicLink())throw Error(`Символическая ссылка не поддерживается: ${relative}`);
    if(entry.isDirectory())result.push(...await files(root,relative));
    else if(entry.isFile())result.push(relative);
  }
  return result.sort();
}
export async function sourceRevision(root) {
  const hash=createHash('sha256');
  for(const name of await files(root)){hash.update(name.replaceAll(path.sep,'/')+'\0');hash.update(await readFile(path.join(root,name)));hash.update('\0');}
  return hash.digest('hex');
}
function pluginBlock(source,addition) {
  const match=/^plugins\s*\{/m.exec(source);
  if(!match)throw Error('Нужен обычный plugins { … } в Kotlin DSL, aliases/convention plugins пока не поддерживаются');
  // Insert at the start: no need to parse arbitrary Gradle expressions or closing braces.
  return source.slice(0,match.index+match[0].length)+'\n    '+addition+source.slice(match.index+match[0].length);
}
async function loadWorkspace(workspace) {
  const root=await realpath(workspace),meta=JSON.parse(await readFile(path.join(root,marker),'utf8'));
  if(meta.format!=='compose-visual-bridge-workspace-v1')throw Error('Это не подготовленный native workspace');
  modulePath(meta.module);
  return {root,meta};
}
export async function prepare({project,output,module=':app',previewSource,sdk,upgradeKotlin,liveOnly=false}) {
  const source=await realpath(project),requested=path.resolve(output),moduleDir=modulePath(module);
  const dest=path.join(await realpath(path.dirname(requested)),path.basename(requested));
  if(inside(source,dest)||inside(dest,source))throw Error('Копия должна находиться отдельно от исходного проекта');
  const gitRoot=(await exec('git',['rev-parse','--show-toplevel'],{cwd:source})).stdout.trim();
  if(await realpath(gitRoot)!==source)throw Error('Укажите корень Git-проекта');
  let rootGradle=await readFile(path.join(source,'build.gradle.kts'),'utf8');
  let appGradle=await readFile(path.join(source,moduleDir,'build.gradle.kts'),'utf8');
  if(!/id\("com\.android\.application"\)/.test(appGradle))throw Error('Поддерживается Android application-модуль с явным id плагина');
  if(!liveOnly&&/com\.google\.devtools\.ksp|compose-buddy/.test(rootGradle+appGradle))throw Error('У проекта уже есть KSP/Buddy: подготовка не перезаписывает существующую интеграцию');
  const versions=[...rootGradle.matchAll(/id\("org\.jetbrains\.kotlin\.[^"]+"\)\s+version\s+"([^"]+)"/g)].map(m=>m[1]);
  if(!versions.length)throw Error('Версии Kotlin должны быть явно заданы в корневом build.gradle.kts');
  if(!liveOnly){
    if(upgradeKotlin&&upgradeKotlin!==TOOLCHAIN.kotlin)throw Error(`Проверяемый вариант обновления Kotlin: ${TOOLCHAIN.kotlin}`);
    if(versions.some(v=>v!==TOOLCHAIN.kotlin)&&!upgradeKotlin)throw Error(`Buddy KSP требует проверенного Kotlin ${TOOLCHAIN.kotlin}. Для обновления только копии укажите --upgrade-kotlin ${TOOLCHAIN.kotlin}`);
    if(upgradeKotlin)rootGradle=rootGradle.replace(/(id\("org\.jetbrains\.kotlin\.[^"]+"\)\s+version\s+")[^"]+("[^\n]*)/g,`$1${TOOLCHAIN.kotlin}$2`);
    rootGradle=pluginBlock(rootGradle,`id("com.google.devtools.ksp") version "${TOOLCHAIN.ksp}" apply false`);
    appGradle=pluginBlock(appGradle,'id("com.google.devtools.ksp")');
    appGradle+=`\n// Compose Visual Bridge: debug-only native Preview discovery.\ndependencies {\n    debugImplementation("dev.mikepenz.composebuddy:compose-buddy-device:${TOOLCHAIN.buddy}")\n    add("kspDebug", "dev.mikepenz.composebuddy:compose-buddy-device-ksp:${TOOLCHAIN.buddy}")\n}\n`;
  }
  const tracked=(await exec('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,maxBuffer:16*1024*1024})).stdout.split('\0').filter(Boolean);
  const names=[...new Set(tracked)].filter(n=>!n.split('/').some(p=>ignored.has(p)||internal.has(p)||secret(p)));
  if(names.some(n=>n.split('/').includes('BuddyPreviewRegistryImpl.kt')))throw Error('Обнаружен ручной Buddy registry: нельзя смешивать его с KSP-генерацией');
  const extra=previewSource?await realpath(previewSource):null;
  const extraNames=extra?(await files(extra)).filter(n=>n.endsWith('.kt')):[];
  if(extra&&(extraNames.length===0||extraNames.length>100))throw Error('Каталог сцен должен содержать от 1 до 100 Kotlin-файлов');
  // Reserve a new directory; never reuse or remove an existing destination.
  await mkdir(dest);
  try {
    for(const name of names) {
      const origin=path.resolve(source,name);
      if(!inside(source,origin))throw Error('Недопустимый путь в Git');
      const stat=await lstat(origin).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(!stat)continue; // Tracked deletion in the working tree stays deleted in the copy.
      if(!stat.isFile())throw Error(`Поддерживаются обычные файлы: ${name}`);
      const resolved=await realpath(origin);if(!inside(source,resolved))throw Error(`Путь выходит из проекта: ${name}`);
      const target=path.join(dest,name);await mkdir(path.dirname(target),{recursive:true});await copyFile(origin,target);await chmod(target,stat.mode&0o777);
    }
    await writeFile(path.join(dest,'build.gradle.kts'),rootGradle);
    await writeFile(path.join(dest,moduleDir,'build.gradle.kts'),appGradle);
    if(!liveOnly){
      const manifest=path.join(dest,moduleDir,'src/debug/AndroidManifest.xml');
      if(await lstat(manifest).catch(()=>null))throw Error('Есть debug AndroidManifest.xml: автоматическое слияние пока не поддерживается');
      await mkdir(path.dirname(manifest),{recursive:true});
      await writeFile(manifest,'<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application><activity android:name="dev.mikepenz.composebuddy.device.BuddyPreviewActivity" android:exported="true" android:theme="@android:style/Theme.Material.Light.NoActionBar.Fullscreen" tools:replace="android:exported,android:theme" /></application></manifest>\n');
    }
    for(const name of extraNames) {
      const target=path.join(dest,moduleDir,'src/debug/java/composevisualbridge_scenes',name);
      const sourceFile=await realpath(path.join(extra,name));if(!inside(extra,sourceFile))throw Error('Файл сцены выходит из каталога');
      await mkdir(path.dirname(target),{recursive:true});await writeFile(target,await readFile(sourceFile),{flag:'wx'});
    }
    sdk||=(await toolchain()).sdk;
    if(sdk){const sdkPath=await realpath(sdk);await writeFile(path.join(dest,'local.properties'),'sdk.dir='+sdkPath.replaceAll('\\','\\\\').replaceAll(':','\\:')+'\n');}
    const meta={format:'compose-visual-bridge-workspace-v1',sourceProject:source,module,mode:liveOnly?'live':'preview',toolchain:liveOnly?{kotlin:versions[0],ksp:rootGradle.match(/id\("com.google.devtools.ksp"\)\s+version\s+"([^"]+)"/)?.[1]||null,buddy:null,jdk:21}:TOOLCHAIN,extraScenes:extraNames,createdAt:new Date().toISOString()};
    await writeFile(path.join(dest,marker),JSON.stringify(meta,null,2)+'\n');
    return {workspace:dest,module,mode:meta.mode,toolchain:meta.toolchain,extraScenes:extraNames,sourceRevision:await sourceRevision(dest),next:'Запустите build с JAVA_HOME на JDK 21. Catalog доступен после успешной сборки.',limitations:['Каталог содержит @Preview, а не все экраны приложения','Экрану с обязательными аргументами нужна воспроизводимая Preview-сцена']};
  }catch(error){await rm(dest,{recursive:true,force:true});throw error;}
}
async function generatedCatalog(root,module) {
  const relative=path.join(modulePath(module),'build/generated/ksp/debug/kotlin/dev/mikepenz/composebuddy/device/BuddyPreviewRegistryImpl.kt');
  const code=await readFile(path.join(root,relative),'utf8');
  const previews=[...code.matchAll(/"([^"\n]+)"\s+to\s+dev\.mikepenz\.composebuddy\.device\.model\.BuddyPreviewEntry\(/g)].map(m=>m[1]);
  if(new Set(previews).size!==previews.length)throw Error('KSP сгенерировал повторяющиеся ключи Preview');
  if(!previews.length&&!code.includes('emptyMap()'))throw Error('Неизвестный формат опубликованного Buddy registry');
  return {previews,generatedRegistry:relative,emptyReason:previews.length?null:'В модуле нет обнаруженных @Preview. Добавьте сцену, вызывающую оригинальный экран с тестовыми данными.'};
}
export async function build(workspace) {
  const {root,meta}=await loadWorkspace(workspace);
  const tools=await toolchain();
  if(tools.jdkMajor<21)throw Error('Для опубликованного Buddy KSP нужен JDK 21+. Задайте BRIDGE_JAVA_HOME или JAVA_HOME; JDK 17 подходит только для runtime без KSP.');
  const buildEnv=tools.jdkHome?{...process.env,JAVA_HOME:tools.jdkHome}:process.env;
  const before=await sourceRevision(root),log=path.join(root,'bridge-native-build.log');
  await rm(path.join(root,'bridge-native-build.json'),{force:true});
  const handle=await open(log,'w');
  let code;
  try {
    code=await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'gradlew'),[meta.module+':assembleDebug','--console=plain','-Pksp.incremental=false'],{cwd:root,env:buildEnv,stdio:['ignore',handle.fd,handle.fd]});child.on('error',reject);child.on('close',resolve);});
  }finally{await handle.close();}
  if(code!==0)throw Error(`Сборка не прошла (код ${code}). Лог: ${log}. Проверьте совместимость и доступность Preview, не заменяйте экран реконструкцией.`);
  const after=await sourceRevision(root);if(before!==after)throw Error('Исходники изменились во время сборки. Повторите build.');
  const moduleDir=modulePath(meta.module),output=path.join(moduleDir,'build/outputs/apk/debug');
  const apks=(await readdir(path.join(root,output))).filter(n=>n.endsWith('.apk'));
  if(apks.length!==1)throw Error('Ожидается один debug APK без splits/flavors');
  const apk=path.join(output,apks[0]),apkSha256=createHash('sha256').update(await readFile(path.join(root,apk))).digest('hex');
  const result={format:'compose-visual-bridge-catalog-v1',workspace:root,module:meta.module,sourceRevision:after,apk,apkSha256,...(meta.mode==='live'?{previews:[],emptyReason:'Сборка работающего приложения без Preview',kind:'live'}:await generatedCatalog(root,meta.module)),toolchain:meta.toolchain,builtAt:new Date().toISOString()};
  await writeFile(path.join(root,'bridge-native-build.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
export async function catalog(workspace) {
  const {root}=await loadWorkspace(workspace);let result;
  try{result=JSON.parse(await readFile(path.join(root,'bridge-native-build.json'),'utf8'));}catch(e){if(e.code==='ENOENT')throw Error('Сначала выполните успешный build; сгенерированный Kotlin сам по себе не подтверждает сборку.');throw e;}
  if(result.format!=='compose-visual-bridge-catalog-v1')throw Error('Неверный формат каталога сборки');
  if(result.sourceRevision!==await sourceRevision(root))throw Error('Каталог устарел: исходники изменились. Повторите build.');
  if(!inside(root,path.resolve(root,result.apk)))throw Error('Недопустимый путь APK');
  if(createHash('sha256').update(await readFile(path.join(root,result.apk))).digest('hex')!==result.apkSha256)throw Error('Каталог устарел: APK изменился. Повторите build.');
  return result;
}
async function main() {
  const [command,...args]=process.argv.slice(2),options={};
  if(!command||command==='--help'){console.log('Native project: prepare --project <Git root> --output <новый каталог> [--module :app] [--preview-source <каталог Kotlin>] [--sdk <SDK>] [--upgrade-kotlin 2.3.20] | build --workspace <копия> | catalog --workspace <копия>');return;}
  const allowed=command==='prepare'?new Set(['--project','--output','--module','--preview-source','--sdk','--upgrade-kotlin']):new Set(['--workspace']);
  if(!['prepare','build','catalog'].includes(command))throw Error('Неизвестная команда native project');
  for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||options[args[i]])throw Error('Некорректные параметры');options[args[i]]=args[i+1];}
  let result;
  if(command==='prepare'){if(!options['--project']||!options['--output'])throw Error('Нужны --project и --output');result=await prepare({project:options['--project'],output:options['--output'],module:options['--module'],previewSource:options['--preview-source'],sdk:options['--sdk'],upgradeKotlin:options['--upgrade-kotlin']});}
  else {if(!options['--workspace'])throw Error('Нужен --workspace');result=await (command==='build'?build:catalog)(options['--workspace']);}
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Ошибка: '+error.message);process.exitCode=1;});
