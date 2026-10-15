// Синтетическая проверка импорта Preview: fake Gradle и JDK, без сети и Android-приёмки.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {capturePreviews} from '../previews.mjs';
import {sourceRevision} from '../scripts/native-project.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
test('Preview-импорт: все Preview рисуются одной сборкой, несвязанные пропускаются с причиной, исходники не меняются',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-previews-'));let stopPreview;t.after(async()=>{try{stopPreview?.();}finally{await rm(temp,{recursive:true,force:true});}});
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
 for(const screen of result.screens){assert.equal(screen.document.sourceRevision,await sourceRevision(result.workspace));assert.equal(screen.document.compose.workspaceRevision,await sourceRevision(result.workspace));}
 await writeFile(result.workspace+'/.bridge-previews.json','{"audit":"updated metadata"}');
 assert.equal(result.screens[0].document.sourceRevision,await sourceRevision(result.workspace));
 await writeFile(result.workspace+'/app/src/main/java/demo/Screen.kt',source+'\n// Real source edit\n');
 assert.notEqual(result.screens[0].document.sourceRevision,await sourceRevision(result.workspace));
 await assert.rejects(capturePreviews({project,output:temp+'/copy2',adapter:{format:'other'}}),/адаптер/);
 await assert.rejects(capturePreviews({project,output:temp+'/copy3'}),/Не найдено экранов/);
 // Exercise the installed CLI path: obtaining a reference never confirms HTML.
 const env={...process.env,BRIDGE_HOME:temp+'/home'},adapterPath=temp+'/adapter.json';
 await writeFile(adapterPath,JSON.stringify(adapter));
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,['scripts/plugin.mjs',...args,'--project',project],{env,encoding:'utf8',timeout:20_000,stdio:['ignore','pipe','pipe']}));
 const opened=run('edit-previews','--adapter',adapterPath,'--output',temp+'/cli-copy');
 stopPreview=()=>run('stop','--session',opened.session);
 let state=await fetch(opened.url+'/api/session').then(r=>r.json());
 assert.ok(state.reference);assert.equal(state.verification,null);assert.match(opened.next,/Сравните/);
 const apply=mode=>fetch(opened.url+'/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,document:state.current,mode})});
 assert.equal((await apply('review')).status,422);
 state=await (await apply('test')).json();assert.equal(state.applied.mode,'test');
 const response=await fetch(opened.url+'/api/baseline/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,baselineFingerprint:state.baselineFingerprint,acknowledged:true})});
 assert.equal(response.status,200);state=await response.json();assert.equal(state.verification.confirmedBy,'user');
 assert.equal((await apply('review')).status,200);
 const handoff=await fetch(opened.url+'/api/handoff').then(r=>r.json());
 // A successful frame followed by a failing Preview is still a failed render.
 await writeFile(project+'/gradlew',(await readFile(project+'/gradlew','utf8'))+'\nprocess.exit(7);\n');
 await assert.rejects(capturePreviews({project,output:temp+'/failed-copy',adapter}),/Отрисовка Preview не прошла \(код 7\).*bridge-previews.log/);
 assert.throws(()=>run('edit-previews','--adapter',adapterPath,'--output',temp+'/failed-cli-copy'),/код 7/);
 assert.deepEqual(await fetch(opened.url+'/api/handoff').then(r=>r.json()),handoff);
 assert.equal(run('list').sessions.find(session=>session.latest).session,opened.session);
 assert.equal(await readFile(temp+'/failed-copy/app/src/main/java/demo/Screen.kt','utf8'),source);
 assert.equal(await readFile(project+'/app/src/main/java/demo/Screen.kt','utf8'),source);
 const unsupportedSource='@Composable fun UnsafeScreen() { Column { Text("Title"); Canvas(Modifier.size(100.dp)) { drawCircle(Color.Red) }; AndroidView(factory = { View(it) }) } }\n@Preview @Composable fun UnsafePreview() { UnsafeScreen() }';
 await writeFile(project+'/app/src/main/java/demo/Screen.kt',unsupportedSource);
 await assert.rejects(capturePreviews({project,output:temp+'/unsupported-copy'}),/Неполный импорт Preview: .*Screen.kt:1.*UnsafeScreen: Canvas.*UnsafeScreen: AndroidView/);
 assert.equal(await readFile(project+'/app/src/main/java/demo/Screen.kt','utf8'),unsupportedSource);
});

test('Unknown UI calls are diagnosed inside branches and slots without flagging values or callbacks',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt',`@Composable
fun Screen(visible: Boolean) {
 val state = remember { FormState() }
 val color = Color(0xff000000)
 val drawn = UnknownAssignedPanel()
 val content: @Composable () -> Unit = { Text("Slot") }
 LaunchedEffect(Unit) { SaveRequest() }
 Column {
  val fallback = state.value ?: FormState()
  Text(title())
  Text("Title", color = Color(0xff000000))
  Button(onClick = { SaveRequest() }) { Text("Save") }
  Canvas(Modifier.size(100.dp)) { drawCircle(Color.Red) }
  AndroidView(factory = { View(it) })
  if (visible) { AsyncImage(model = "example") }
  Box(content = { UnknownPanel() })
 }
}
@Preview @Composable fun ScreenPreview() { Screen(true) }
data class FormState(val value: FormState? = null)
@Composable private fun title(): String = "Title"`);
 const generated=await generateAdapter(temp);
 assert.deepEqual(generated.unsupported.map(item=>item.call),['UnknownAssignedPanel','Canvas','AndroidView','AsyncImage','UnknownPanel']);
 for(const item of generated.unsupported){assert.equal(item.file,'app/src/main/java/demo/Screen.kt');assert.equal(item.symbol,'Screen');assert.ok(item.line>0);assert.match(item.reason,/не связан/);}
 assert.ok(generated.adapter.calls.some(item=>item.call==='Text'));
});

test('An expression-body component is explicitly unsupported instead of silently losing its content',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt','@Composable fun Header() = Text("Title")\n@Composable fun Screen() { Column { Header() } }\n@Preview @Composable fun ScreenPreview() { Screen() }');
 const generated=await generateAdapter(temp);
 assert.equal(generated.unsupported.length,1);assert.equal(generated.unsupported[0].symbol,'Header');assert.match(generated.unsupported[0].reason,/блочное тело/);
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
test('Карта связей: функции LazyListScope, рамки BorderStroke и рисуемые элементы',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt',`import androidx.compose.material3.*
@Composable
fun DayScreen(checked: Boolean) {
    LazyColumn {
        item { LinearProgressIndicator(progress = { 0.5f }) }
        section("Завтрак", checked)
    }
}
private fun LazyListScope.section(header: String, checked: Boolean) {
    item { Text(header) }
    item { Mark(checked) }
}
@Composable
private fun Mark(checked: Boolean) {
    Surface(border = if (checked) null else BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline)) { Text("x") }
}
@Preview
@Composable
fun DayPreview() { DayScreen(false) }
`);
 const {adapter}=await generateAdapter(temp);const by=key=>adapter.calls.find(c=>c.key===key);
 assert.equal(by('DayScreen-LinearProgressIndicator-0').type,'Image');
 assert.equal(by('section-Text-0').instance,'dev.composevisualbridge.capture.bridgeSceneInstance');
 assert.match(by('Mark-Surface-0').border,/^\(if \(checked\) null else BorderStroke\(1\.5\.dp, MaterialTheme\.colorScheme\.outline\)\)\?\.brush/);
 assert.match(by('Mark-Surface-0').borderWidth,/\?\.width\?\.value \?: 0f$/);
 const {sceneCalls}=await import('../scene.mjs');assert.deepEqual(sceneCalls(await readFile(temp+'/app/src/main/java/demo/Screen.kt','utf8'),'section').map(c=>c.call),['Text','Mark']);
});
test('Карта связей: чипы и неактивные кнопки получают цвета Material 3',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt',`import androidx.compose.material3.*
@Composable
fun FormScreen(dark: Boolean, ready: Boolean) {
    Column(Modifier) {
        FilterChip(selected = dark, onClick = {}, label = { Text("Dark") })
        Button(onClick = {}, enabled = ready) { Text("Go") }
    }
}
@Preview
@Composable
fun FormPreview() { FormScreen(true, false) }
`);
 const {adapter}=await generateAdapter(temp);const by=key=>adapter.calls.find(c=>c.key===key);
 const chip=by('FormScreen-FilterChip-0');assert.equal(chip.type,'Button');assert.match(chip.background,/^if \(dark\) .*secondaryContainer/);assert.match(chip.borderWidth,/^if \(dark\) 0f else 1f$/);assert.match(chip.shape,/FilterChipDefaults\.shape$/);
 const button=by('FormScreen-Button-0');assert.match(button.background,/^if \(ready\) .*primary else dev\.composevisualbridge\.capture\.bridgeDisabledContainer\(\)$/);assert.match(button.foreground,/bridgeDisabledContent\(\)$/);
});
test('Карта связей: ветки экрана дают несколько корней, вызов без скобок связывается',async t=>{
 const {generateAdapter}=await import('../adapter.mjs');const {sceneCalls}=await import('../scene.mjs');
 const temp=await mkdtemp(path.join(tmpdir(),'cvb-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));await mkdir(temp+'/app/src/main/java/demo',{recursive:true});
 const code=`import androidx.compose.material3.*
@Composable
fun DetailScreen(loading: Boolean, ask: Boolean) {
    if (ask) AlertDialog(onDismissRequest = {}, title = { Text("Удалить?") }, confirmButton = {})
    when {
        loading -> Box(Modifier.fillMaxSize()) { Text("Загрузка") }
        else -> Column {
            Text("Рецепт")
        }
    }
}
@Preview
@Composable
fun DetailPreview() { DetailScreen(false, false) }
`;
 await writeFile(temp+'/app/src/main/java/demo/Screen.kt',code);
 const {adapter}=await generateAdapter(temp);const by=key=>adapter.calls.find(c=>c.key===key);
 assert.equal(by('DetailScreen-Box-0').root,true);assert.equal(by('DetailScreen-Column-0').root,true);
 assert.equal(by('DetailScreen-Text-2').instance,'dev.composevisualbridge.capture.bridgeSceneInstance');
 assert.ok(!by('DetailScreen-Text-0'),'Текст диалога не корень и не связывается');
 const bare=sceneCalls(code,'DetailScreen').find(c=>c.call==='Column');assert.equal(bare.bare,true);assert.equal(code.slice(bare.close,bare.close+2),' {');
});
