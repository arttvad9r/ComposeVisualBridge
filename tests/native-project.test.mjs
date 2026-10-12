import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepare,catalog,sourceRevision} from '../scripts/native-project.mjs';
const exec=promisify(execFile);
async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-discovery-')),project=path.join(root,'project'),output=path.join(root,'copy');
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(project,'app/src/main'),{recursive:true});
  await exec('git',['init','--quiet'],{cwd:project});
  await writeFile(path.join(project,'build.gradle.kts'),'plugins {\n id("org.jetbrains.kotlin.android") version "2.1.0" apply false\n id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false\n}\n');
  await writeFile(path.join(project,'app/build.gradle.kts'),'plugins {\n id("com.android.application")\n}\n');
  await writeFile(path.join(project,'app/src/main/Original.kt'),'// Original source\n');
  await writeFile(path.join(project,'keystore.properties'),'SECRET=must-not-copy');
  await writeFile(path.join(project,'.env.local'),'SECRET=must-not-copy');
  await writeFile(path.join(project,'.gitignore'),'build/\n');
  return {root,project,output,options:{project,output,upgradeKotlin:'2.3.20'}};
}
test('native preparation creates an isolated compiler-discovery copy and preserves dirty original sources',async t=>{
  const f=await fixture(t),before=await sourceRevision(f.project);
  const scenes=path.join(f.root,'scenes');await mkdir(scenes);await writeFile(path.join(scenes,'Screen.kt'),'@Preview @Composable fun Screen() {}');
  const result=await prepare({...f.options,previewSource:scenes});
  assert.equal(await sourceRevision(f.project),before);assert.equal(result.workspace,f.output);
  const root=await readFile(path.join(f.output,'build.gradle.kts'),'utf8'),app=await readFile(path.join(f.output,'app/build.gradle.kts'),'utf8');
  assert.match(root,/ksp.*2\.3\.6/);assert.match(root,/compose.*2\.3\.20/);assert.match(app,/kspDebug/);assert.doesNotMatch(app,/releaseImplementation/);
  assert.equal(await readFile(path.join(f.output,'app/src/main/Original.kt'),'utf8'),'// Original source\n');
  assert.equal(await readFile(path.join(f.output,'app/src/debug/java/composevisualbridge_scenes/Screen.kt'),'utf8'),'@Preview @Composable fun Screen() {}');
  await assert.rejects(stat(path.join(f.output,'keystore.properties')),{code:'ENOENT'});await assert.rejects(stat(path.join(f.output,'.env.local')),{code:'ENOENT'});
  await assert.rejects(catalog(f.output),/успешный build/);
});
test('native preparation rejects reuse, unsupported integrations and unsafe paths without overwriting files',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepare({project:f.project,output:f.output}),/upgrade-kotlin/);
  await assert.rejects(prepare({...f.options,output:path.join(f.project,'copy')}),/отдельно/);
  await symlink(f.project,path.join(f.root,'alias'));await assert.rejects(prepare({...f.options,output:path.join(f.root,'alias','copy')}),/отдельно/);await assert.rejects(stat(path.join(f.project,'copy')),{code:'ENOENT'});
  await mkdir(f.output);await writeFile(path.join(f.output,'keep'),'user');
  await assert.rejects(prepare(f.options),{code:'EEXIST'});assert.equal(await readFile(path.join(f.output,'keep'),'utf8'),'user');await rm(f.output,{recursive:true});
  await symlink('/etc/hosts',path.join(f.project,'external.kt'));
  await assert.rejects(prepare(f.options),/обычные файлы/);await assert.rejects(stat(f.output),{code:'ENOENT'});await rm(path.join(f.project,'external.kt'));
  await writeFile(path.join(f.project,'app/build.gradle.kts'),'plugins { id("com.android.application"); id("com.google.devtools.ksp") }');
  await assert.rejects(prepare(f.options),/уже есть KSP/);await assert.rejects(stat(f.output),{code:'ENOENT'});
});
test('catalog binds successful compilation to both current dirty sources and exact APK',async t=>{
  const f=await fixture(t);await prepare(f.options);
  const apk='app/build/outputs/apk/debug/app-debug.apk';await mkdir(path.dirname(path.join(f.output,apk)),{recursive:true});await writeFile(path.join(f.output,apk),'APK fixture');
  const manifest={format:'compose-visual-bridge-catalog-v1',sourceRevision:await sourceRevision(f.output),apk,apkSha256:createHash('sha256').update('APK fixture').digest('hex'),previews:['sample.ScreenKt.Preview']};
  await writeFile(path.join(f.output,'bridge-native-build.json'),JSON.stringify(manifest));assert.deepEqual(await catalog(f.output),manifest);
  await writeFile(path.join(f.output,'app/src/main/Original.kt'),'Changed source');await assert.rejects(catalog(f.output),/исходники изменились/);
  await writeFile(path.join(f.output,'app/src/main/Original.kt'),'// Original source\n');await writeFile(path.join(f.output,apk),'Different APK');await assert.rejects(catalog(f.output),/APK изменился/);
});
test('compiler discovery refuses JDK 17 before invoking Gradle',async t=>{
  const f=await fixture(t);await prepare(f.options);
  const home=path.join(f.root,'jdk17');await mkdir(path.join(home,'bin'),{recursive:true});
  await writeFile(path.join(home,'bin/java'),'#!/bin/sh\necho \'openjdk version "17.0.2"\' >&2\n',{mode:0o755});
  const previous=process.env.JAVA_HOME;process.env.JAVA_HOME=home;
  try{const {build}=await import('../scripts/native-project.mjs');await assert.rejects(build(f.output),/JDK 21/);await assert.rejects(stat(path.join(f.output,'bridge-native-build.log')),{code:'ENOENT'});}
  finally{if(previous===undefined)delete process.env.JAVA_HOME;else process.env.JAVA_HOME=previous;}
});

test('Live-копия сохраняет исходные Kotlin/KSP и debug-манифест без подключения Buddy Preview',async t=>{
 const f=await fixture(t);const originalRoot=(await readFile(path.join(f.project,'build.gradle.kts'),'utf8')).replace('\n}', '\n id("com.google.devtools.ksp") version "2.1.0-1.0.29" apply false\n}');await writeFile(path.join(f.project,'build.gradle.kts'),originalRoot);
 const originalApp='plugins { id("com.android.application"); id("com.google.devtools.ksp") }';await writeFile(path.join(f.project,'app/build.gradle.kts'),originalApp);await mkdir(path.join(f.project,'app/src/debug'));const manifest='<manifest><application><receiver android:name="ExistingReceiver" /></application></manifest>';await writeFile(path.join(f.project,'app/src/debug/AndroidManifest.xml'),manifest);
 const before=await sourceRevision(f.project);await prepare({project:f.project,output:f.output,liveOnly:true});assert.equal(await sourceRevision(f.project),before);assert.equal(await readFile(path.join(f.output,'build.gradle.kts'),'utf8'),originalRoot);assert.equal(await readFile(path.join(f.output,'app/build.gradle.kts'),'utf8'),originalApp);assert.equal(await readFile(path.join(f.output,'app/src/debug/AndroidManifest.xml'),'utf8'),manifest);const meta=JSON.parse(await readFile(path.join(f.output,'.bridge-native-workspace.json')));assert.equal(meta.mode,'live');assert.equal(meta.toolchain.kotlin,'2.1.0');assert.equal(meta.toolchain.ksp,'2.1.0-1.0.29');assert.equal(meta.toolchain.buddy,null);
});
