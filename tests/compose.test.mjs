import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseCompose,importCompose,composePatch,instrumentCompose,bindCapture,planCompose,writeComposePlan,instrumentWorkspace,restoreWorkspace,generateCompose,bindWorkspaceCapture} from '../compose.mjs';
import {clone,indexTree} from '../public/model.mjs';
import {composeCapability, transferNeeds} from '../public/compose-capabilities.mjs';
const code=`package test
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
@Composable fun Screen(value: String) {
 Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
  Text("Повтор", fontSize = 14.sp)
  Text("Повтор", fontSize = 14.sp)
  Text(stringResource(R.string.label))
  Button(onClick = { callback("keep { this }") }) { Text(value) }
 }
}
`;
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'cvb-compose-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'Screen.kt'),code);await writeFile(path.join(root,'.bridge-native-workspace.json'),JSON.stringify({format:'compose-visual-bridge-workspace-v1',sourceProject:root+'-original',module:':app'}));return {root,doc:await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}})};}
test('Capture preserves known font families; typography and scrolling survive patch and reimport',async t=>{
 const {doc}=await fixture(t);doc.root.children[0].props.fontFamily='Serif';
 const nodes=Object.entries(doc.compose.bindings).map(([id,b],i)=>({id:String(i),text:b.type==='Text'?b.label:null,bounds:{left:0,top:0,right:360,bottom:id===doc.root.id?640:30},properties:{bridgeSourceKey:id}}));
 for(const [id,e] of indexTree(doc.root)){if(e.node.type==='Text')nodes.find(n=>n.properties.bridgeSourceKey===id).text=e.node.props.text;if(e.node.type==='Button')nodes.find(n=>n.properties.bridgeSourceKey===doc.compose.bindings[id].label).text=e.node.props.text;}
 const captured=bindCapture(doc,{image:'fixture',nodes,densityDpi:160,preview:'Test',sourceRevision:'test',digest:'test',screenState:'Test'});
 assert.equal(captured.root.children[0].props.fontFamily,'Serif');
 const next=clone(doc);next.root.props.scrollable=true;next.root.children[0].props.textDecoration='underline';
 const patch=composePatch(code,doc,next),parsed=parseCompose(patch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});
 assert.equal(parsed.root.props.scrollable,true);assert.equal(parsed.root.children[0].props.textDecoration,'underline');
 const cleared=clone(next);delete cleared.root.props.scrollable;delete cleared.root.children[0].props.textDecoration;
 const meta={...next,compose:{...next.compose,...parseCompose(patch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}})}};const clearedMeta={...cleared,compose:meta.compose};
 const reset=composePatch(patch.code,meta,clearedMeta);assert.ok(!reset.code.includes('.verticalScroll('));assert.ok(!reset.code.includes('textDecoration ='));
 const centered=clone(doc);centered.root.props.align='center';const centerPatch=composePatch(code,doc,centered),centerParsed=parseCompose(centerPatch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});
 const centerBase={...centered,root:centerParsed.root,compose:{...centered.compose,...centerParsed}},defaultAlign=clone(centerBase);delete defaultAlign.root.props.align;
 const defaultPatch=composePatch(centerPatch.code,centerBase,defaultAlign);assert.equal(parseCompose(defaultPatch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}}).root.props.align,'start');
});
test('Stretch transfers cross-axis fill without overriding fixed child dimensions',async t=>{
 const {doc}=await fixture(t);for(const type of ['Column','Row']){const source=type==='Row'?code.replace('Column(', 'Row(').replace('verticalArrangement', 'horizontalArrangement'):code;const parsedSource=parseCompose(source,{symbol:'Screen',file:'Screen.kt',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});const baseline={...clone(doc),root:parsedSource.root,compose:{...doc.compose,...parsedSource}};const next=clone(baseline);next.root.props.align='stretch';const axis=type==='Column'?'width':'height';next.root.children[1].props[axis]=80;
 const patch=composePatch(source,baseline,next),parsed=parseCompose(patch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});
 assert.equal(parsed.root.children[0].props[axis],'fill');assert.equal(parsed.root.children[1].props[axis],80);
 }
});
test('Transfer capabilities distinguish direct edits from work requiring an agent',async t=>{
 const {doc}=await fixture(t),next=clone(doc);next.root.children.push({id:'input',type:'TextField',props:{text:'Имя'}});next.root.children[0].props.fontFamily='Roboto Flex';next.root.children[2].props.text='Новый ресурсный текст';
 const needs=transferNeeds(doc,next);assert.ok(needs.some(n=>n.id==='input'));assert.ok(needs.some(n=>n.property==='fontFamily'));assert.ok(needs.some(n=>n.id===doc.root.children[2].id&&n.property==='text'));
 assert.equal(composeCapability('Text','textDecoration','underline').mode,'direct');assert.equal(composeCapability('Column','scrollable',true).mode,'direct');assert.equal(composeCapability('TextField').mode,'agent');
 const changes=(await import('../public/model.mjs')).diff(doc,next);assert.deepEqual(changes.transfer.requiresAgent,needs);
});
test('Compose imports exact distinct call sites, source expressions and nested callbacks; unsupported syntax is explicit',async t=>{const {doc}=await fixture(t);assert.equal(doc.root.props.gap,12);assert.equal(doc.root.children[2].props.text,'Ресурс');assert.notEqual(doc.root.children[0].id,doc.root.children[1].id);assert.equal(doc.root.children[3].props.text,'Кнопка');assert.throws(()=>parseCompose(code.replace('Text("Повтор", fontSize = 14.sp)','if (true) { Text("Повтор") }'),{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}}),/адаптер/);assert.throws(()=>parseCompose(code.replace('.padding(16.dp)','.unknownThing()'),{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}}),/адаптер/);});
test('Compose patch changes one repeated instance, preserves resources/callbacks and rejects stale input',async t=>{const {root,doc}=await fixture(t),next=clone(doc);next.root.children[1].props.fontSize=18;next.root.children[0].props.offsetX=20;const patch=await planCompose({baseline:doc,current:next,workspace:root});assert.equal((patch.code.match(/fontSize = 14.sp/g)||[]).length,1);assert.equal((patch.code.match(/fontSize = 18.sp/g)||[]).length,1);assert.ok(patch.code.includes('Text(stringResource(R.string.label))'));assert.ok(patch.code.includes('callback("keep { this }")'));assert.ok(patch.code.includes('x = 20.dp'));assert.equal(composePatch(code,doc,doc).code,code);await writeComposePlan(patch);assert.equal(await readFile(path.join(root,'Screen.kt'),'utf8'),patch.code);await assert.rejects(writeComposePlan(patch),/изменился/);});
test('Compose source instrumentation inserts valid named modifiers and capture rejects repeated/unknown runtime links',async t=>{const {doc}=await fixture(t),tagged=instrumentCompose(code,doc);assert.match(tagged.code,/Text\("Повтор", fontSize = 14.sp, modifier = dev/);assert.match(tagged.code,/Column\(dev\.composevisualbridge/);const nodes=Object.entries(doc.compose.bindings).map(([id,b],i)=>({id:String(i),text:b.type==='Text'?b.label:null,bounds:{left:0,top:i*20,right:100,bottom:i*20+20},properties:{bridgeSourceKey:id}}));for(const [id,entry] of indexTree(doc.root)){if(entry.node.type==='Text')nodes.find(n=>n.properties.bridgeSourceKey===id).text=entry.node.props.text;if(entry.node.type==='Button')nodes.find(n=>n.properties.bridgeSourceKey===doc.compose.bindings[id].label).text=entry.node.props.text;}nodes.find(n=>n.properties.bridgeSourceKey===doc.root.id).bounds={left:0,top:0,right:360,bottom:640};const frame={image:'test-image',nodes,densityDpi:160,preview:'test.Screen',sourceRevision:'a'.repeat(64),digest:'b'.repeat(64),screenState:'Тест'};const bound=bindCapture(doc,frame);assert.equal(bound.layout.mode,'free');assert.equal(Object.keys(bound.layout.frames).length,5);assert.equal(bound.compose.capture.status,'needs-browser-verification');assert.throws(()=>bindCapture(doc,{...frame,nodes:[...nodes,nodes[0]]}),/Повторный runtime/);});
test('Compose structural transfer retains behavior and freezes free geometry as Box layout',async t=>{const {doc}=await fixture(t),next=clone(doc);next.root.children.reverse();next.root.children.push({id:'new-text',type:'Text',props:{text:'Новый',fontSize:16}});let patch=composePatch(code,doc,next);assert.ok(patch.code.indexOf('Button(')<patch.code.indexOf('Text("Повтор"'));assert.match(patch.code,/text = "Новый"/);assert.match(patch.code,/callback\("keep/);next.layout={mode:'free',frames:Object.fromEntries([...indexTree(next.root)].map(([id,e],i)=>[id,{parent:e.parent,x:10,y:i*30,width:100,height:30}]))};patch=composePatch(code,doc,next);assert.match(patch.code,/Box\(/);assert.ok(!patch.code.includes('verticalArrangement'));assert.match(patch.code,/x = 10.dp/);});

test('Whole-workspace revision blocks stale plans and safe instrumentation restores exact source repeatedly',async t=>{
 const {root,doc}=await fixture(t),next=clone(doc);next.root.children[0].props.fontSize=18;
 await writeFile(path.join(root,'Other.kt'),'// changed');await assert.rejects(planCompose({baseline:doc,current:next,workspace:root}),/Рабочая копия изменилась/);await rm(path.join(root,'Other.kt'));
 await instrumentWorkspace(doc);await assert.rejects(instrumentWorkspace(doc),/изменился/);await restoreWorkspace(root);await restoreWorkspace(root);assert.equal(await readFile(path.join(root,'Screen.kt'),'utf8'),code);
 assert.equal((await planCompose({baseline:doc,current:next,workspace:root})).beforeRevision,doc.compose.workspaceRevision);
 await instrumentWorkspace(doc);await restoreWorkspace(root);
 await writeFile(path.join(root,'Screen.kt'),code.replace('14.sp','18.sp'));const updated=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});await instrumentWorkspace(updated);await restoreWorkspace(root);assert.match(await readFile(path.join(root,'Screen.kt'),'utf8'),/18.sp/);
});
test('Conflicting debug adapter is preserved and instrumentation leaves Kotlin unchanged',async t=>{
 const {root,doc}=await fixture(t),helper=path.join(root,'app/src/debug/java/dev/composevisualbridge/capture/BridgeSource.kt');
 const {mkdir}=await import('node:fs/promises');await mkdir(path.dirname(helper),{recursive:true});await writeFile(helper,'// user adapter');
 const fresh=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});
 await assert.rejects(instrumentWorkspace(fresh),/EEXIST/);assert.equal(await readFile(helper,'utf8'),'// user adapter');assert.equal(await readFile(path.join(root,'Screen.kt'),'utf8'),code);
});
test('Geometry-only edits transfer, free layout strips scope weight, clipping transfers and resource expressions remain protected',async t=>{
 const {doc}=await fixture(t),baseline=clone(doc);baseline.layout={mode:'free',frames:Object.fromEntries([...indexTree(doc.root)].map(([id,e],i)=>[id,{parent:e.parent,x:0,y:i*30,width:100,height:30}]))};
 const current=clone(baseline);current.layout.frames[current.root.children[0].id].x=25;
 assert.match(composePatch(code,baseline,current).code,/x = 25.dp/);assert.ok(composePatch(code,baseline,current).operations.some(op=>op.property==='frame'));
 const weightedCode=code.replace('fontSize = 14.sp)','fontSize = 14.sp, modifier = Modifier.weight(1f))');
 const {root}=await fixture(t);await writeFile(path.join(root,'Screen.kt'),weightedCode);const weighted=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}}),free=clone(weighted);free.layout=clone(baseline.layout);
 assert.ok(!composePatch(weightedCode,weighted,free).code.includes('.weight('));
 const invalid=clone(doc);invalid.root.props.clipContent=true;assert.match(composePatch(code,doc,invalid).code,/clipToBounds\(\)/);
 const resourceEdit=clone(doc);resourceEdit.root.children[2].props.text='Другой';assert.throws(()=>composePatch(code,doc,resourceEdit),/ресурсом/);
});
test('New-screen generation uses same document and capture binding checks compiled revision',async t=>{
 const {root,doc}=await fixture(t),screen=clone(doc);screen.root.children=screen.root.children.slice(0,2);const generated=generateCompose(screen,{packageName:'test.generated',symbol:'NewScreen'});
 assert.match(generated,/@Composable fun NewScreen/);assert.match(generated,/text = "Повтор"/);assert.doesNotThrow(()=>parseCompose(generated,{symbol:'NewScreen'}));
 await instrumentWorkspace(doc);await writeFile(path.join(root,'bridge-native-build.json'),JSON.stringify({sourceRevision:'a'.repeat(64),previews:['test.Screen']}));
 await assert.rejects(bindWorkspaceCapture(doc,{sourceRevision:'b'.repeat(64),preview:'test.Screen'}),/сборке/);
 await restoreWorkspace(root);
});

test('PNG comparison detects localized errors instead of hiding them in empty canvas',async()=>{
 const {deflateSync}=await import('node:zlib'),{comparePng}=await import('../scripts/compare-png.mjs');
 function png(width,height,blackX=-1){const signature=Buffer.from([137,80,78,71,13,10,26,10]),header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const chunk=(name,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);return out;};
 const scan=Buffer.alloc((width*3+1)*height,255);for(let y=0;y<height;y++){scan[y*(width*3+1)]=0;if(blackX>=0)scan.fill(0,y*(width*3+1)+1+blackX*3,y*(width*3+1)+1+(blackX+1)*3);}
 return Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);}
 const same=png(10,10),changed=png(10,10,2);assert.equal(comparePng(same,same).overall.differentFraction,0);
 const comparison=comparePng(same,changed,{regions:{element:{left:2,top:0,right:3,bottom:10}}});assert.equal(comparison.overall.differentFraction,.1);assert.equal(comparison.regions.element.differentFraction,1);
 assert.equal(comparePng(same,png(9,10)).sameSize,false);assert.throws(()=>comparePng(Buffer.from('broken'),same),/PNG/);
});

test('Material Surface retains Kotlin wrapper, exact tags and explicit background transfer',async t=>{const {root}=await fixture(t),wrapped=code.replace(' Column(', ' Surface(modifier = Modifier.fillMaxSize()) { Column(').replace('\n}\n','\n} }\n');await writeFile(path.join(root,'Screen.kt'),wrapped);const doc=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});assert.equal(doc.root.type,'Box');assert.equal(doc.compose.bindings[doc.root.id].callType,'Surface');assert.match(instrumentCompose(wrapped,doc).code,/kind = "Surface"/);const next=clone(doc);next.root.props.background='#112233';const patch=composePatch(wrapped,doc,next);assert.match(patch.code,/Surface\(.*color = androidx.compose.ui.graphics.Color\(0xFF112233\)/);assert.doesNotThrow(()=>parseCompose(patch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}}));});

test('Compose transfers generic fonts and italic; free content sizing does not restore frozen height',async t=>{
 const {doc}=await fixture(t);
 for(const [family,native] of [['system','Default'],['Sans Serif','SansSerif'],['Serif','Serif'],['Monospace','Monospace'],['Cursive','Cursive']]){
  const next=clone(doc);next.root.children[0].props.fontFamily=family;next.root.children[0].props.fontStyle='italic';
  const patch=composePatch(code,doc,next);assert.ok(patch.code.includes('FontFamily.'+native));assert.ok(patch.code.includes('FontStyle.Italic'));
  const parsed=parseCompose(patch.code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});assert.equal(parsed.root.children[0].props.fontFamily,family==='Sans Serif'?'Roboto':family);
 }
 const next=clone(doc);next.layout={mode:'free',frames:Object.fromEntries([...indexTree(doc.root)].map(([id,e])=>[id,{parent:e.parent,x:0,y:0,width:300,height:240}]))};next.root.children[0].props.height='auto';next.root.children[0].props.width='auto';
 const parsed=parseCompose(composePatch(code,doc,next).code,{symbol:'Screen',parameters:{value:'Кнопка'},resources:{label:'Ресурс'}});assert.equal(parsed.root.children[0].props.height,undefined);assert.equal(parsed.root.children[0].props.width,undefined);
});

test('Real project Text keeps MaterialTheme style, colors and parameter Modifier through a scoped patch',async t=>{
 const {root}=await fixture(t);const source=`package test
@Composable fun Metric(modifier: Modifier) { Column(modifier = modifier) { Text(text = "Калории", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
) } }`;await writeFile(path.join(root,'Metric.kt'),source);
 const doc=await importCompose({workspace:root,file:'Metric.kt',symbol:'Metric',parameters:{modifier:'Modifier'}});const next=clone(doc);next.root.children[0].props.fontSize=18;const patch=composePatch(source,doc,next);assert.match(patch.code,/style = MaterialTheme.typography.labelMedium/);assert.match(patch.code,/color = MaterialTheme.colorScheme.onSurfaceVariant/);assert.match(patch.code,/modifier = modifier/);assert.match(patch.code,/fontSize = 18.sp/);const tagged=instrumentCompose(source,doc).code;assert.match(tagged,/explicitColor = MaterialTheme.colorScheme.onSurfaceVariant/);assert.doesNotMatch(tagged,/,\s*,/);
 assert.throws(()=>parseCompose(source.replace('MaterialTheme.typography.labelMedium','customStyle()'),{symbol:'Metric',parameters:{modifier:'Modifier'}}),/адаптер стиля/);assert.throws(()=>parseCompose(source,{symbol:'Metric',parameters:{modifier:'unsafe()'}}),/Modifier должен/);
});

test('Captured small real components retain bounds inside the minimum editor canvas',async t=>{
 const {doc}=await fixture(t);const nodes=Object.entries(doc.compose.bindings).map(([id,b])=>({id,text:null,bounds:{left:0,top:0,right:90,bottom:40},properties:{bridgeSourceKey:id}}));for(const [id,e] of indexTree(doc.root)){const target=nodes.find(n=>n.id===(doc.compose.bindings[id].label||id));if(['Text','Button'].includes(e.node.type))target.text=e.node.props.text;}const bound=bindCapture(doc,{image:'fixture',nodes,densityDpi:160,preview:'Small',digest:'test',sourceRevision:'test',screenState:'Test'});assert.equal(bound.viewport.width,200);assert.equal(bound.viewport.height,200);assert.equal(bound.layout.frames[doc.root.id].width,90);assert.equal(bound.layout.frames[doc.root.id].height,40);
});

test('Modifier edits preserve order, required sizing, both size axes and padding overrides', async t => {
 const {root}=await fixture(t);
 const patch=async(modifier,update)=>{
  const source=`package test\nfun Screen() { Box(${modifier}) { Text("x") } }`;
  await writeFile(path.join(root,'Screen.kt'),source);
  const base=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen'}),next=clone(base);
  update(next.root.props);return composePatch(source,base,next).code;
 };
 assert.match(await patch('Modifier.width(100.dp).padding(16.dp)',p=>p.width=120),/Modifier\.width\(120\.dp\)\.padding\(16\.dp\)/);
 assert.match(await patch('Modifier.padding(16.dp).width(100.dp)',p=>p.width=120),/Modifier\.padding\(16\.dp\)\.width\(88\.dp\)/);
 assert.match(await patch('Modifier.requiredWidth(100.dp).padding(16.dp)',p=>p.width=120),/requiredWidth\(120\.dp\)\.padding\(16\.dp\)/);
 assert.match(await patch('Modifier.size(100.dp, 40.dp).padding(16.dp)',p=>p.width=120),/width\(120\.dp\)\.height\(40\.dp\)\.padding\(16\.dp\)/);
 const horizontal=await patch('Modifier.padding(16.dp).width(100.dp)',p=>p.paddingHorizontal=8);
 assert.match(horizontal,/padding\(horizontal = 8\.dp, vertical = 16\.dp\)\.width\(116\.dp\)/);
 assert.equal(parseCompose(horizontal,{symbol:'Screen'}).root.props.width,132);
 assert.equal((horizontal.match(/\.padding\(/g)||[]).length,1);
 const vertical=await patch('Modifier.padding(16.dp)',p=>p.paddingVertical=0);
 assert.match(vertical,/padding\(horizontal = 16\.dp, vertical = 0\.dp\)/);
 assert.match(await patch('Modifier.padding(horizontal = 8.dp, vertical = 16.dp)',p=>delete p.paddingHorizontal),/padding\(horizontal = 0\.dp, vertical = 16\.dp\)/);
 await assert.rejects(patch('Modifier.width(100.dp).width(80.dp)',p=>p.width=120),/Неоднозначная цепочка/);
});

test('External sizes survive padding-first imports, edits and reimport; legacy transfer requires a fresh session',async t=>{
 const {root}=await fixture(t),source='package test\nfun Screen() { Box(Modifier.padding(16.dp).width(100.dp).height(32.dp).background(Color(0xFFE0EFFF))) { Text("x", Modifier.fillMaxSize()) } }';
 await writeFile(path.join(root,'Screen.kt'),source);
 const base=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen'});
 assert.equal(base.root.props.width,132);assert.equal(base.root.props.height,64);
 assert.equal(composePatch(source,base,base).code,source);
 const next=clone(base);next.root.props.width=120;next.root.props.paddingHorizontal=8;
 const patched=composePatch(source,base,next),parsed=parseCompose(patched.code,{symbol:'Screen'});
 assert.match(patched.code,/padding\(horizontal = 8\.dp, vertical = 16\.dp\)\.width\(104\.dp\)\.height\(32\.dp\)/);
 assert.equal(parsed.root.props.width,120);assert.equal(parsed.root.props.height,64);
 const insetOnly=clone(base);insetOnly.root.props.paddingVertical=0;
 const changed=composePatch(source,base,insetOnly);
 assert.match(changed.code,/\.height\(64\.dp\)/);assert.equal(parseCompose(changed.code,{symbol:'Screen'}).root.props.height,64);
 const tooSmall=clone(base);tooSmall.root.props.width=10;assert.throws(()=>composePatch(source,base,tooSmall),/меньше внешних отступов/);
 const legacy=clone(base);delete legacy.compose.modifierModel;const legacyNext=clone(legacy);legacyNext.root.props.width=140;
 assert.equal(composePatch(source,legacy,legacy).code,source);assert.throws(()=>composePatch(source,legacy,legacyNext),/Повторно импортируйте/);
 const {validate}=await import('../public/model.mjs'),invalid=clone(base);invalid.compose.bindings[base.root.id].modifierLayout.order=['unsafe'];assert.throws(()=>validate(invalid),/modifierLayout/);
 assert.throws(()=>parseCompose(source.replace('.padding(16.dp)','.padding(16.dp).padding(8.dp)'),{symbol:'Screen'}),/повторяющихся/);
 const free=clone(base);free.layout={mode:'free',frames:{[base.root.id]:{parent:null,x:0,y:0,width:132,height:64},[base.root.children[0].id]:{parent:base.root.id,x:16,y:16,width:100,height:32}}};
 assert.throws(()=>composePatch(source,base,free),/background после padding требует адаптера/);
});

test('Removing Button enabled restores the Kotlin default and retains callback', async t => {
 const {root}=await fixture(t),source='package test\nfun Screen() { Button(onClick = { callback() }, enabled = false) { Text("x") } }';
 await writeFile(path.join(root,'Screen.kt'),source);
 const base=await importCompose({workspace:root,file:'Screen.kt',symbol:'Screen'}),next=clone(base);delete next.root.props.enabled;
 const patch=composePatch(source,base,next);assert.doesNotMatch(patch.code,/enabled\s*=/);assert.match(patch.code,/onClick = \{ callback\(\) \}/);
 assert.equal(parseCompose(patch.code,{symbol:'Screen'}).root.props.enabled,undefined);
});
