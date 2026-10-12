// Синтетическая проверка импорта Preview: fake Gradle и JDK, без сети и Android-приёмки.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {capturePreviews} from '../previews.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
test('Preview-импорт: все Preview рисуются одной сборкой, несвязанные пропускаются с причиной, исходники не меняются',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-previews-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const project=temp+'/project',jdk=temp+'/jdk';await mkdir(project+'/app/src/main/java/demo',{recursive:true});await mkdir(jdk+'/bin',{recursive:true});
 await writeFile(jdk+'/bin/java','#!/bin/sh\necho \'openjdk version "21.0.2"\' >&2\n',{mode:0o755});
 const source='@Composable fun ListScreen() { Column(Modifier.fillMaxSize()) { Text("Список") } }\n@Composable fun DetailScreen() { Box(Modifier.fillMaxSize()) { Text("Детали") } }';
 await writeFile(project+'/app/src/main/java/demo/Screen.kt',source);
 await writeFile(project+'/build.gradle.kts','plugins {\n    id("org.jetbrains.kotlin.android") version "2.1.0" apply false\n}\n');
 await writeFile(project+'/app/build.gradle.kts','plugins {\n    id("com.android.application")\n}\nandroid { namespace = "demo.app" }\ndependencies { implementation(platform("androidx.compose:compose-bom:2024.12.01")) }\n');
 // Fake Gradle: checks the instrumented copy and writes frames the way BridgePreviewCapture does.
 const node=(id,key,text,children=[])=>({id,bounds:{left:0,top:0,right:360,bottom:640},children,mergedSemantics:{...(key?{bridgeSourceKey:key}:{}),...(text?{text}:{})}});
 const frames={'demo.ListPreview':{type:'frame',preview:'Список',function:'demo.PreviewsKt.ListPreview',image,densityDpi:160,semantics:node('root','/list/',null,[node('a','/title/','Список')])},
  'demo.DetailPreview':{type:'frame',preview:'Детали',function:'demo.PreviewsKt.DetailPreview',image,densityDpi:160,semantics:node('root','/detail/',null)},
  'demo.OtherPreview':{type:'frame',preview:'Без связей',function:'demo.PreviewsKt.OtherPreview',image,densityDpi:160,semantics:node('root',null,'Текст')}};
 await writeFile(project+'/gradlew','#!'+process.execPath+'\n'+`const fs=require('fs');const gradle=fs.readFileSync('app/build.gradle.kts','utf8');
if(!fs.existsSync('app/src/test/java/dev/composevisualbridge/capture/BridgePreviewCapture.kt')||!gradle.includes('"demo.app"')||!gradle.includes('compose-bom:2024.12.01'))process.exit(3);
if(!fs.readFileSync('app/src/main/java/demo/Screen.kt','utf8').includes('bridge'))process.exit(4);
const out=JSON.parse(gradle.match(/systemProperty\\("bridge.output", ("[^"]+")\\)/)[1]);fs.mkdirSync(out,{recursive:true});
for(const [name,frame] of Object.entries(${JSON.stringify(frames)}))fs.writeFileSync(out+'/'+name+'.json',JSON.stringify(frame));`,{mode:0o755});
 execFileSync('git',['init','-q'],{cwd:project});
 const rule=(symbol,call,type,extra={})=>({file:'app/src/main/java/demo/Screen.kt',fileHash:hash(source),symbol,call,type,occurrence:0,...extra});
 const adapter={format:'compose-visual-bridge-live-adapter-v1',calls:[rule('ListScreen','Column','Column',{key:'list',root:true,name:'Список'}),rule('ListScreen','Text','Text',{key:'title'}),rule('DetailScreen','Box','Box',{key:'detail',root:true,name:'Детали'})]};
 const previous=process.env.BRIDGE_JAVA_HOME;process.env.BRIDGE_JAVA_HOME=jdk;t.after(()=>{if(previous===undefined)delete process.env.BRIDGE_JAVA_HOME;else process.env.BRIDGE_JAVA_HOME=previous;});
 const result=await capturePreviews({project,output:temp+'/copy',adapter});
 assert.deepEqual(result.screens.map(s=>s.document.name).sort(),['Детали','Список']);
 const list=result.screens.find(s=>s.document.name==='Список').document;assert.equal(list.state.entry,'preview');assert.equal(list.state.screenState,'превью');assert.equal(list.root.children[0].props.text,'Список');
 assert.deepEqual(result.skipped.map(s=>s.preview),['Без связей']);assert.match(result.skipped[0].reason,/нет элементов сцены/);
 assert.equal(await readFile(project+'/app/src/main/java/demo/Screen.kt','utf8'),source);
 assert.equal(await readFile(temp+'/copy/app/src/main/java/demo/Screen.kt','utf8'),source);
 await assert.rejects(capturePreviews({project,output:temp+'/copy2',adapter:{format:'other'}}),/адаптер/);
 await assert.rejects(capturePreviews({project,output:temp+'/copy3'}),/Не найдено экранов/);
});
test('Карта связей строится из исходников: экраны из @Preview, листья без вложенных связей, цвета Material 3',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt',`import androidx.compose.material3.*
@Composable
fun HomeScreen(items: List<String>, onBack: () -> Unit) {
    Scaffold(topBar = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null) } }) { padding ->
        LazyColumn(Modifier.padding(padding)) { items(items) { Item(it) } }
        TextButton(onClick = {}) { Label("Удалить"); Text("Удалить", color = MaterialTheme.colorScheme.error) }
    }
    if (false) Text("вне корня")
}
@Composable
private fun Item(name: String) { Surface(color = Color.Red) { Text(name) } }
@Composable
private fun Label(text: String) { Text(text) }
@Composable
fun AppTheme(content: @Composable () -> Unit) { MaterialTheme(content = content) }
@Preview(name = "Главная")
@Composable
fun HomePreview() = AppTheme { HomeScreen(listOf("a"), {}) }
`);
 const {adapter,skipped}=await generateAdapter(temp);
 assert.deepEqual(adapter.screens,['HomeScreen']);
 const by=key=>adapter.calls.find(c=>c.key===key);
 assert.equal(by('HomeScreen-Scaffold-0').root,true);assert.equal(by('HomeScreen-Scaffold-0').background,'androidx.compose.material3.MaterialTheme.colorScheme.background');
 assert.equal(by('HomeScreen-IconButton-0').type,'Box');assert.equal(by('HomeScreen-Icon-0').type,'Image');
 assert.equal(by('HomeScreen-TextButton-0').type,'Button');assert.equal(by('HomeScreen-TextButton-0').foreground,'MaterialTheme.colorScheme.error');
 assert.ok(!adapter.calls.some(c=>c.symbol==='HomeScreen'&&c.call==='Text'),'Текст внутри кнопки и вне корня не связывается');
 assert.equal(by('Item-Surface-0').background,'Color.Red');assert.equal(by('Item-Text-0').instance,'dev.composevisualbridge.capture.bridgeSceneInstance');
 assert.ok(!adapter.calls.some(c=>c.symbol==='Label'||c.symbol==='AppTheme'));assert.deepEqual(skipped.map(s=>s.function),['Label']);
});
