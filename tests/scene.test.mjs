import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {prepareScene,instrumentScene,restoreScene,bindScene,sceneCalls,sceneHelper} from '../scene.mjs';import {clone,diff,indexTree} from '../public/model.mjs';import {composePatch} from '../compose.mjs';
const source=`package fixture
@Composable fun Screen() {
 val state = remember { mutableStateOf(false) }
 Column(Modifier.fillMaxSize()) {
  items.forEach { item -> FilterChip(selected = state.value, onClick = { callback(item) }, label = { Text(item.name) },) }
  Value("one")
  Value("two")
 }
 if (state.value) { ConfirmDialog(onConfirm = { callback("confirmed") }) }
}
@Composable private fun Value(value: String) { Text(text = value, style = MaterialTheme.typography.bodyLarge,) }
`;
const sha=s=>createHash('sha256').update(s).digest('hex');
test('Scene preflight rejects independent Icon/Spacer/Text bindings inside Button before changing sources',async t=>{
 const {workspace}=await fixture(t),original='@Composable fun Screen() { Column() { Button(onClick = { save() }) { Icon(Icons.Add, null); Spacer(Modifier.width(8.dp)); Text("Добавить") } } }';
 await writeFile(path.join(workspace,'Screen.kt'),original);
 const rule=(call,type,extra={})=>({file:'Screen.kt',fileHash:sha(original),symbol:'Screen',call,type,occurrence:0,key:call,...extra});
 const adapter={format:'compose-visual-bridge-live-adapter-v1',calls:[rule('Column','Column',{root:true}),rule('Button','Button')]};
 for(const [call,type] of [['Icon','Image'],['Spacer','Spacer'],['Text','Text']])await assert.rejects(prepareScene(workspace,{...adapter,calls:[...adapter.calls,rule(call,type)]}),/внутри листа Button \(Button\)/);
 assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),original);
 await assert.rejects(readFile(path.join(workspace,'.bridge-scene-import.json')),error=>error.code==='ENOENT');
 const scene=await prepareScene(workspace,adapter);await instrumentScene(scene);
 const instrumented=await readFile(path.join(workspace,'Screen.kt'),'utf8');assert.match(instrumented,/Icon\(Icons.Add, null\)/);assert.match(instrumented,/Spacer\(Modifier.width\(8.dp\)\)/);assert.match(instrumented,/bridgeSceneTextLayout\("Button"/);
 await restoreScene(workspace);assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),original);
});
async function fixture(t){const workspace=await mkdtemp(path.join(tmpdir(),'cvb-scene-'));t.after(()=>rm(workspace,{recursive:true,force:true}));await writeFile(path.join(workspace,'Screen.kt'),source);await writeFile(path.join(workspace,'.bridge-native-workspace.json'),JSON.stringify({format:'compose-visual-bridge-workspace-v1',module:':app',sourceProject:workspace+'-original'}));const rule=(call,type,occurrence=0,extra={})=>({file:'Screen.kt',fileHash:sha(source),symbol:'Screen',call,type,occurrence,...extra});const adapter={format:'compose-visual-bridge-scene-adapter-v1',name:'Полный экран',calls:[rule('Column','Column',0,{root:true}),rule('FilterChip','Button',0,{instance:'item.name'}),rule('Value',undefined,0,{scope:true}),rule('Value',undefined,1,{scope:true}),rule('Text','Text',0,{symbol:'Value'})]};return {workspace,adapter};}
function frame(scene){const keys=Object.keys(scene.bindings),node=(id,parentId,key,text,bounds={left:0,top:0,right:100,bottom:30})=>({id,parentId,text,bounds,properties:{bridgeSourceKey:key,fontSize:'14.0.sp',lineHeight:'20.0.sp',textLineCount:'1'}});return {image:'fixture',densityDpi:160,sourceRevision:scene.instrumentedRevision,preview:'Screen',screenState:'state=false',digest:'native',nodes:[node('root',null,'/'+keys[0]+'/',null,{left:0,top:0,right:360,bottom:640}),node('a','root','/'+keys[1]+'/A','A'),node('b','root','/'+keys[1]+'/B','B'),node('v1','root','/'+keys[2]+'/'+keys[4]+'/','one'),node('v2','root','/'+keys[3]+'/'+keys[4]+'/','two')]};}
test('Runtime scene instruments state, repeated chips and custom scopes without replacing behavior; restores exact sources',async t=>{const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const code=await readFile(path.join(workspace,'Screen.kt'),'utf8');assert.match(code,/val state = remember/);assert.match(code,/onClick = \{ callback\(item\) \}/);assert.match(code,/instance = item.name.toString\(\)/);assert.match(code,/label = \{ Text\(item.name, onTextLayout = dev.composevisualbridge.capture.bridgeSceneTextLayout/);assert.doesNotMatch(code,/,\s*,/);assert.equal((code.match(/bridgeSceneScope/g)||[]).length,2);await assert.rejects(instrumentScene(scene),/изменилась|восстановите/);await restoreScene(workspace);await restoreScene(workspace);assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),source);await assert.rejects(prepareScene(workspace,{...adapter,calls:adapter.calls.map(r=>({...r,fileHash:'stale'}))}),/устарел/);});
test('Runtime instances have stable distinct IDs; full semantic handoff requires agent even for frame-only/delete intent',async t=>{const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const capture=frame(scene);await restoreScene(workspace);const baseline=await bindScene(scene,capture),nodes=[...indexTree(baseline.root).values()].map(e=>e.node);assert.equal(nodes.length,5);const a=nodes.find(n=>n.props.text==='A'),b=nodes.find(n=>n.props.text==='B');assert.notEqual(a.id,b.id);assert.notEqual(nodes.find(n=>n.props.text==='one').id,nodes.find(n=>n.props.text==='two').id);const reversed=await bindScene(scene,{...capture,nodes:[capture.nodes[0],...capture.nodes.slice(1).reverse()]});assert.equal([...indexTree(reversed.root).values()].find(e=>e.node.props.text==='A').node.id,a.id);const next=clone(baseline);next.layout.frames[a.id].x=20;assert.equal(diff(baseline,next).transfer.requiresAgent[0].property,'scene');next.root.children.splice(1,1);assert.equal(diff(baseline,next).transfer.requiresAgent.length,1);const resized=clone(baseline);resized.viewport.width=400;assert.equal(diff(baseline,resized).transfer.requiresAgent.length,1);assert.throws(()=>composePatch(source,baseline,next),/Runtime-сцену переносит агент/);assert.equal(baseline.compose.sourceHashes['Screen.kt'],sha(source));assert.ok(a.source.instance.endsWith('/A'));await assert.rejects(bindScene(scene,{...capture,nodes:[...capture.nodes,capture.nodes[1]]}),/Повторный экземпляр/);await assert.rejects(bindScene(scene,{...capture,sourceRevision:'stale'}),/сборке/);await assert.rejects(bindScene(scene,{...capture,nodes:capture.nodes.slice(1)}),/один корень/);});
test('Conflicting files/helper are preserved; restoration validates every file before writing',async t=>{const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);await writeFile(path.join(workspace,'Screen.kt'),'// newer user source');await assert.rejects(restoreScene(workspace),/восстановление запрещено/);assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),'// newer user source');await writeFile(path.join(workspace,'Screen.kt'),scene.files['Screen.kt'].instrumented);await writeFile(path.join(workspace,'app/src/debug/java/dev/composevisualbridge/capture/BridgeScene.kt'),'// user helper');await assert.rejects(restoreScene(workspace),/Адаптер сцены изменился/);assert.equal(await readFile(path.join(workspace,'app/src/debug/java/dev/composevisualbridge/capture/BridgeScene.kt'),'utf8'),'// user helper');await writeFile(path.join(workspace,'app/src/debug/java/dev/composevisualbridge/capture/BridgeScene.kt'),sceneHelper);await restoreScene(workspace);});

test('Offscreen layout bounds and font scale survive a clipped native frame',async t=>{const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const capture=frame(scene);capture.nodes[0].properties.bridgeFontScale='1.6';const text=capture.nodes[3];text.bounds={left:0,top:640,right:0,bottom:640};text.properties.bridgeBounds='0,800,100,40';await restoreScene(workspace);const doc=await bindScene(scene,capture),node=[...indexTree(doc.root).values()].find(e=>e.node.props.text==='one').node;assert.equal(doc.viewport.fontScale,1.6);assert.equal(doc.layout.frames[node.id].y,800);assert.equal(doc.layout.frames[node.id].height,40);assert.equal(doc.compose.capture.textGeometry[node.id].textHeight,25);assert.equal(Object.values(doc.compose.calls).filter(c=>c.scope).length,2);assert.match(Object.values(doc.compose.calls).find(c=>c.scope).args[0].value,/one/);await assert.rejects(bindScene(scene,{...capture,nodes:capture.nodes.map(n=>n===text?{...n,properties:{...n.properties,bridgeBounds:'0,0,Infinity,40'}}:n)}),/геометрия/);});

test('Failed edit-scene keeps the latest session and does not touch sources',async t=>{const {workspace,adapter}=await fixture(t);const home=await mkdtemp(path.join(tmpdir(),'cvb-scene-home-'));t.after(()=>rm(home,{recursive:true,force:true}));const {mkdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');const projectData=path.join(home,sha(workspace).slice(0,24));await mkdir(projectData);await writeFile(path.join(projectData,'latest.json'),'same-session');adapter.calls[0].fileHash='stale';const filename=path.join(home,'adapter.json');await writeFile(filename,JSON.stringify(adapter));await assert.rejects(promisify(execFile)(process.execPath,['scripts/plugin.mjs','edit-scene','--project',workspace,'--workspace',workspace,'--adapter',filename,'--serial','emulator-5584','--state','fixture','--preview','fixture.Screen'],{env:{...process.env,BRIDGE_HOME:home}}),e=>e.stderr.includes('Адаптер устарел'));assert.equal(await readFile(path.join(projectData,'latest.json'),'utf8'),'same-session');assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),source);});

test('Runtime typography defaults to normal instead of inheriting bold; native PNG assets preserve pixels',async t=>{
 const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const capture=frame(scene);await restoreScene(workspace);const doc=await bindScene(scene,capture);assert.equal(doc.root.children[0].props.fontWeight,400);
 const {cropPng,decodePng}=await import('../scripts/compare-png.mjs');const {validate}=await import('../public/model.mjs');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==','base64');
 const src=cropPng(png,{left:0,top:0,right:1,bottom:1});assert.deepEqual(decodePng(Buffer.from(src.split(',')[1],'base64')).data,decodePng(png).data);
 const image={schemaVersion:1,name:'PNG-ассет',viewport:doc.viewport,root:{id:'asset',type:'Image',props:{src}}};validate(image);assert.throws(()=>validate({...image,root:{...image.root,props:{src:'data:image/svg+xml,<svg onload="alert(1)"/>'}}}),/Image.src/);assert.throws(()=>cropPng(png,{left:2,top:2,right:3,bottom:3}),/вне кадра/);
});

test('Runtime capture expresses children from the inner border edge without moving the native content',async t=>{
 const {workspace,adapter}=await fixture(t),scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const capture=frame(scene);capture.nodes[0].properties.bridgeBorderWidth='2';await restoreScene(workspace);
 const doc=await bindScene(scene,capture);assert.equal(doc.root.props.borderWidth,2);
 for(const child of doc.root.children){const frame=doc.layout.frames[child.id];assert.equal(frame.x,-2);assert.equal(frame.y,-2);assert.equal(frame.x+doc.root.props.borderWidth,0);}
});


test('Native nonlinear font conversion and minimum touch target paint survive capture; malformed metrics fail',async t=>{
 const {workspace,adapter}=await fixture(t);adapter.calls.find(r=>r.type==='Button').props={maxLines:2,textOverflow:'ellipsis'};
 const scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const capture=frame(scene),curve=Array.from({length:301},(_,i)=>Math.round((i*.5+Math.min(i*.3,15))*100));
 capture.nodes[0].properties.bridgeFontScaleCurve=curve.join(',');capture.nodes[0].properties.bridgeSystemFontSha256='d5633ff957d2ecb1ce7716e86e11057091c3526042efe16fe1f65dfc06a65551';capture.nodes[1].properties.bridgeBounds='0,0,100,48';capture.nodes[1].bounds={left:0,top:8,right:100,bottom:40};await restoreScene(workspace);
 const doc=await bindScene(scene,capture),button=doc.root.children[0];assert.deepEqual(doc.compose.capture.fontScaleCurve,curve);assert.equal(doc.compose.capture.fontHashes.Roboto,capture.nodes[0].properties.bridgeSystemFontSha256);assert.equal(button.props.maxLines,2);assert.equal(button.props.textOverflow,'ellipsis');assert.deepEqual(doc.compose.capture.textGeometry[button.id].paintInsets,{left:0,top:8,right:0,bottom:8});
 const {scaledSp,robotoFamily}=await import('../public/typography.mjs'),{validate}=await import('../public/model.mjs');assert.equal(robotoFamily(doc.compose.capture.fontHashes.Roboto),'Roboto 3.015');assert.equal(robotoFamily('unknown'),'Roboto');assert.equal(scaledSp(30,1.6,curve),45);assert.equal(scaledSp(30,1.6),48);assert.equal(scaledSp(13.25,1.6,curve),(curve[26]+curve[27])/200);assert.equal(scaledSp(-.25,1.6,curve),-curve[1]/200);
 for(const invalid of [[],curve.slice(1),[...curve.slice(0,300),NaN]]){const bad=clone(doc);bad.compose.capture.fontScaleCurve=invalid;assert.throws(()=>validate(bad),/fontScaleCurve/);}
 const bad=clone(doc);bad.compose.capture.textGeometry[button.id].paintInsets.top=-1;assert.throws(()=>validate(bad),/paintInsets/);
});


test('Native text line offsets preserve ellipsis and wrap the existing layout callback without losing behavior',async t=>{
 const {workspace,adapter}=await fixture(t),original=source.replace('style = MaterialTheme.typography.bodyLarge,','style = MaterialTheme.typography.bodyLarge, onTextLayout = { result -> callbackLayout(result) },');await writeFile(path.join(workspace,'Screen.kt'),original);adapter.calls.forEach(rule=>rule.fileHash=sha(original));
 const scene=await prepareScene(workspace,adapter);await instrumentScene(scene);assert.match(await readFile(path.join(workspace,'Screen.kt'),'utf8'),/callback = \{ result -> callbackLayout\(result\) \}/);
 const captured=frame(scene);captured.nodes[3].properties.bridgeTextLines='0,2,1';captured.nodes[3].properties.bridgeTextWidths='42';captured.nodes[3].properties.bridgeTextStyleMetrics='24,0.5';captured.nodes[3].properties.bridgeTextSize='90,30';await restoreScene(workspace);assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),original);
 const {validate:validateMetric}=await import('../public/model.mjs');const doc=await bindScene(scene,captured),node=doc.root.children.find(n=>n.props.text==='one');assert.deepEqual(doc.compose.capture.textGeometry[node.id].lineRanges,[{start:0,end:2,ellipsis:true}]);assert.equal(doc.compose.capture.textGeometry[node.id].fontDp,24);assert.equal(node.props.letterSpacing,.5);assert.deepEqual(doc.compose.capture.textGeometry[node.id].lineWidths,[42]);assert.equal(doc.compose.capture.textGeometry[node.id].textBoxWidth,90);const bad=clone(doc);bad.compose.capture.textGeometry[node.id].lineWidths=[NaN];assert.throws(()=>validateMetric(bad),/lineWidths/);
 captured.nodes[3].properties.bridgeTextLines='0,1000,0';await assert.rejects(bindScene(scene,captured),/lineRanges/);
});


test('Text with an existing modifier gains a layout callback without duplicating arguments',async t=>{
 const {workspace,adapter}=await fixture(t),original=source.replace('Text(text = value,','Text(text = value, modifier = Modifier.width(100.dp),');await writeFile(path.join(workspace,'Screen.kt'),original);adapter.calls.forEach(rule=>rule.fileHash=sha(original));
 const scene=await prepareScene(workspace,adapter);await instrumentScene(scene);const code=await readFile(path.join(workspace,'Screen.kt'),'utf8');assert.match(code,/bridgeSceneModifier\([^\n]+Modifier.width\(100.dp\)/);assert.match(code,/onTextLayout = dev.composevisualbridge.capture.bridgeSceneTextLayout/);assert.doesNotMatch(code,/,\s*,/);await restoreScene(workspace);assert.equal(await readFile(path.join(workspace,'Screen.kt'),'utf8'),original);
});

test('TextField: подпись, текст под полем и иконки берутся из кадра',async t=>{
 const workspace=await mkdtemp(path.join(tmpdir(),'cvb-field-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const code='@Composable fun Screen() { Column() { OutlinedTextField(value = v, onValueChange = {}, label = { Text("Token") }, supportingText = { Text("Help") }) } }';
 await writeFile(path.join(workspace,'Screen.kt'),code);await writeFile(path.join(workspace,'.bridge-native-workspace.json'),JSON.stringify({format:'compose-visual-bridge-workspace-v1',module:':app',sourceProject:workspace+'-original'}));
 const rule=(call,type,extra={})=>({file:'Screen.kt',fileHash:sha(code),symbol:'Screen',call,type,occurrence:0,key:call,...extra});
 const scene=await prepareScene(workspace,{format:'compose-visual-bridge-scene-adapter-v1',name:'Поле',calls:[rule('Column','Column',{root:true}),rule('OutlinedTextField','TextField')]});await instrumentScene(scene);await restoreScene(workspace);
 const [root,field]=Object.keys(scene.bindings),image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
 const node=(id,parentId,properties,bounds,text)=>({id,parentId,text,bounds,properties});
 const capture={image,densityDpi:160,sourceRevision:scene.instrumentedRevision,preview:'Screen',screenState:'s',digest:'native',nodes:[
  node('r',null,{bridgeSourceKey:'/'+root+'/'},{left:0,top:0,right:360,bottom:640}),
  node('f','r',{bridgeSourceKey:'/'+field+'/',editableText:'abc'},{left:0,top:0,right:300,bottom:88}),
  node('l','f',{},{left:16,top:0,right:60,bottom:16},'Token'),
  node('h','f',{},{left:16,top:68,right:200,bottom:88},'Help'),
  node('i','f',{role:'Image'},{left:0,top:0,right:1,bottom:1})]};
 const doc=await bindScene(scene,capture),p=doc.root.children[0].props;
 assert.equal(p.text,'abc');assert.equal(p.label,'Token');assert.equal(p.supportingText,'Help');assert.equal(p.placeholder,undefined);assert.match(p.leadingIcon,/^data:image\/png;base64,/);
 const {validate}=await import('../public/model.mjs');validate(doc);
 assert.throws(()=>validate({...doc,root:{...doc.root,children:[{...doc.root.children[0],props:{...p,trailingIcon:'https://x/y.png'}}]}}),/trailingIcon/);
 capture.nodes[1].properties.editableText='';const empty=(await bindScene(scene,capture)).root.children[0].props;assert.equal(empty.placeholder,'Token');assert.equal(empty.label,undefined);
});
