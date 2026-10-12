import {test, expect} from '@playwright/test';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {importCompose, composePatch} from '../../compose.mjs';
import {decodePng} from '../../scripts/compare-png.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
test('Compose geometry: external sizes, Box fill and padding-aware paint survive edits, resize and reload',async({page})=>{
 const data=await mkdtemp(path.join(tmpdir(),'cvb-compose-geometry-'));let child,exited;const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const code=await readFile(new URL('../android/GeometryScreen.kt',import.meta.url),'utf8');await writeFile(path.join(data,'Screen.kt'),code);
  const baseline=await importCompose({workspace:data,file:'Screen.kt',symbol:'GeometryScreen'});baseline.viewport.presentation='content';
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));
  child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  const saved=()=>expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  const nodes=Object.fromEntries(baseline.root.children.map(node=>[node.children[0].props.text,node]));
  const locator=id=>page.locator(`#after [data-node-id="${id}"]`);
  const geometry=label=>locator(nodes[label].id).evaluate(element=>{const outer=element.getBoundingClientRect(),inner=element.querySelector('[data-node-id]').getBoundingClientRect();return [outer.width,outer.height,inner.width,inner.height,inner.x-outer.x,inner.y-outer.y];});
  const field=async(label,key,value)=>{await page.locator(`#tree [data-node-id="${nodes[label].id}"]`).click();const input=page.locator(`#inspector [data-property="${key}"]`),details=input.locator('xpath=ancestor::details');if(await details.getAttribute('open')===null)await details.locator('summary').first().click();await input.fill(value);await input.press('Tab');await saved();};
  await page.setViewportSize({width:1500,height:1000});await page.goto(url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await saved();
  expect(await geometry('A')).toEqual([100,64,68,32,16,16]);expect(await geometry('B')).toEqual([132,64,100,32,16,16]);
  await field('B','width','120');await field('C','paddingHorizontal','8');await field('D','paddingHorizontal','');
  expect(await geometry('B')).toEqual([120,64,88,32,16,16]);expect(await geometry('C')).toEqual([100,64,84,32,8,16]);expect(await geometry('D')).toEqual([100,64,100,32,0,16]);
  await page.locator('#tree [data-node-id="'+nodes.B.id+'"]').click();
  const handle=page.locator('.resize-handle[data-direction="e"]'),box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+20,box.y+box.height/2,{steps:6});await page.mouse.up();await saved();
  expect(await geometry('B')).toEqual([140,64,108,32,16,16]);await page.locator('#undo').click();await saved();expect(await geometry('B')).toEqual([120,64,88,32,16,16]);
  await page.locator('#redo').click();await saved();await page.reload();await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await saved();expect(await geometry('B')).toEqual([140,64,108,32,16,16]);
  await page.locator('#apply').click();await expect(page.locator('#notice')).toContainText('Снимок сохранён');
  const handoff=await(await fetch(url+'/api/handoff')).json();expect(handoff.document.root.children[1].props.width).toBe(140);expect(composePatch(code,baseline,handoff.document).code).toContain('.width(108.dp)');
  await page.addStyleTag({content:'.layout-node.selected{outline:none!important}.layout-node.selected:before,.selection-frame{visibility:hidden!important}'});await page.mouse.move(0,0);
  const png=decodePng(await page.locator('#after .phone').screenshot()),pixel=(x,y)=>Array.from(png.data.subarray((y*png.width+x)*png.channels,(y*png.width+x)*png.channels+3));
  expect(pixel(17,17)).toEqual([255,255,255]);expect(pixel(33,33)).toEqual([224,239,255]);
  const phone=await page.locator('#after .phone').boundingBox(),b=await locator(nodes.B.id).boundingBox();
  expect(b.y-phone.y).toBeCloseTo(88,1);
  expect(pixel(17,89)).toEqual([255,255,255]);expect(pixel(60,120)).toEqual([255,224,239]);
  expect(errors).toEqual([]);
 }finally{if(child?.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
test('Compose: actual HTML drag, resize, typography and Undo retain Kotlin binding',async({page})=>{
  const data=await mkdtemp(path.join(tmpdir(),'cvb-compose-browser-'));
  let child, exited;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    const code=`package browser.fixture
import androidx.compose.runtime.Composable
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
@Composable fun Screen() {
 Column(Modifier.fillMaxSize()) { Text("Редактируемый текст", fontSize = 14.sp) }
}`;
    await writeFile(path.join(data,'Screen.kt'),code);
    const baseline=await importCompose({workspace:data,file:'Screen.kt',symbol:'Screen'}),id=baseline.root.children[0].id;
    baseline.root.children[0].props.fontWeight=400;baseline.root.children[0].props.maxLines=1;baseline.root.children[0].props.lineHeight=20;baseline.compose.capture={textGeometry:{[id]:{text:'Редактируемый текст',fontWeight:400,fontSize:14,lineHeight:20,textHeight:16}}};
    baseline.layout={mode:'free',frames:{[baseline.root.id]:{parent:null,x:0,y:0,width:360,height:640},[id]:{parent:baseline.root.id,x:16,y:32,width:220,height:40}}};
    await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));
    child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
    const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.stderr.on('data',chunk=>{output+=chunk;});});
    const state=async()=> (await fetch(url+'/api/session')).json();
    const saved=()=>expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
    await page.setViewportSize({width:1600,height:1000});await page.goto(url);await page.locator('#zoom').selectOption('1');await saved();
    await page.locator('#advancedTools > summary').click();await expect(page.locator('.native-link')).toHaveText('Эталон Android');await page.locator('.native-link').click();await expect(page.locator('#baselineDialog')).toBeVisible();expect(new URL(page.url()).pathname).toBe('/');await expect(page.locator('#nativeImage')).toHaveCount(0);await page.locator('#closeBaseline').click();if(await page.locator('#advancedTools').getAttribute('open')!==null)await page.locator('#advancedTools > summary').click();
    await page.locator('#single').click();
    const beforeZoom=(await state()).current;
    const slider=page.getByRole('slider',{name:'Масштаб в процентах'});await slider.focus();await slider.press('Home');await slider.press('ArrowRight');
    await expect(slider).toHaveValue('26');await expect(page.locator('#zoomValue')).toHaveText('26%');await expect(page.locator('#zoom')).toHaveValue('');await expect(page.locator('#zoom option:not([hidden])')).toHaveText(['Вписать','55%','65%','80%','100%','125%','150%','175%','200%']);
    await page.locator('#single').click();await expect(slider).toHaveValue('26');await expect(page.locator('#newType option')).toHaveText(['Колонка','Строка','Контейнер','Карточка','Текст','Кнопка','Поле ввода','Переключатель','Иконка','Изображение','Промежуток']);await slider.press('End');
    await expect(slider).toHaveValue('200');expect(await slider.evaluate(e=>({padding:getComputedStyle(e).padding,border:getComputedStyle(e).borderWidth}))).toEqual({padding:'0px',border:'0px'});await expect(page.locator('#zoom')).toHaveValue('2');expect((await state()).current).toEqual(beforeZoom);
    const element=page.locator(`#after [data-node-id="${id}"]`);
    await element.click();const before=await element.boundingBox();
    await page.mouse.move(before.x+before.width*.75,before.y+before.height/2);await page.mouse.down();await page.mouse.move(before.x+before.width*.75+40,before.y+before.height/2+20,{steps:8});await expect(page.locator('body')).toHaveClass(/dragging/);await page.mouse.up();await expect(page.locator('body')).not.toHaveClass(/dragging/);await saved();
    const moved=await element.boundingBox(),parent=await element.locator('..').boundingBox();expect(moved.x-parent.x).toBeCloseTo(72,0);expect(moved.y-parent.y).toBeCloseTo(84,0);
    await page.locator('#undo').click();await saved();expect((await state()).current.root.children[0].props.offsetX).toBeUndefined();
    await page.locator('#inspector summary').filter({hasText:'Форматирование текста'}).click();await page.getByLabel('Шрифт · sp',{exact:true}).fill('18');await saved();expect(await element.evaluate(e=>getComputedStyle(e).fontSize)).toBe('18px');expect(parseFloat(await element.evaluate(e=>getComputedStyle(e).lineHeight))).toBeCloseTo(16*18/14,2);expect(parseFloat(await page.locator('#before [data-node-id="'+id+'"]').evaluate(e=>getComputedStyle(e).lineHeight))).toBeCloseTo(16,2);await page.getByLabel('Толщина шрифта',{exact:true}).selectOption('700');expect(parseFloat(await element.evaluate(e=>getComputedStyle(e).lineHeight))).toBeCloseTo(20,2);await page.getByLabel('Толщина шрифта',{exact:true}).selectOption('400');
    const handle=page.locator('.resize-handle[data-direction="e"]'),box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2,{steps:6});await page.mouse.up();await saved();
    const current=(await state()).current;expect(current.root.children[0].props.width).toBe(250);expect((await element.boundingBox()).width).toBeCloseTo(500,0);
    expect(current.compose).toEqual(baseline.compose);const patch=composePatch(code,baseline,current);expect(patch.code).toContain('fontSize = 18.sp');expect(patch.code).toContain('width(250.dp)');await page.locator('#tree [data-node-id="'+baseline.root.id+'"]').click();
    await page.locator('#newType').selectOption('TextField');await page.locator('#addTransferHelp').click();await expect(page.locator('#helpText')).toContainText('выполнит агент');await page.locator('#closeHelp').click();
    await page.locator('#add').click();await page.getByRole('button',{name:'Справка: Подключение элемента',exact:true}).click();await expect(page.locator('#helpText')).toContainText('передаются');await page.locator('#closeHelp').click();
    await page.locator('#apply').click();const transferred=await(await fetch(url+'/api/handoff')).json();expect(transferred.document.root.children.at(-1).type).toBe('TextField');expect(transferred.report).toContain('требующие работы агента');
    expect(errors).toEqual([]);
  } finally {if(child?.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});

test('Runtime-сцена: отдельный повторный элемент меняется, перетаскивается и передаёт экземпляр агенту',async({page})=>{
 const data=await mkdtemp(path.join(tmpdir(),'cvb-runtime-browser-'));let child,exited;
 try{
  const root={id:'root',type:'Column',props:{},children:['a','b'].map((id,i)=>({id,type:'Button',props:{text:i?'Вторая':'Первая',background:'#FFFFFF'},source:{file:'Screen.kt',symbol:'Screen',line:8,instance:'chip/'+id}}))};
  const baseline={schemaVersion:1,name:'Повторные элементы',sourceRevision:'a'.repeat(64),viewport:{width:360,height:640,presentation:'content'},layout:{mode:'free',frames:{root:{parent:null,x:0,y:0,width:360,height:640},a:{parent:'root',x:16,y:30,width:120,height:40},b:{parent:'root',x:16,y:100,width:120,height:40}}},root,compose:{format:'compose-visual-bridge-runtime-scene-v1',workspace:data,sourceHashes:{'Screen.kt':'a'.repeat(64)},bindings:{root:{root:true,agentOnly:true},a:{agentOnly:true,runtimeIdentity:'chip/a'},b:{agentOnly:true,runtimeIdentity:'chip/b'}}}};
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.stderr.on('data',chunk=>{output+=chunk;});});
  await page.goto(url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.locator('#tree [data-node-id="a"]').click();await page.locator('summary').filter({hasText:'Оформление'}).first().click();await page.getByLabel('Фон',{exact:true}).fill('#fff2cc');await page.getByLabel('Фон',{exact:true}).blur();
  const element=page.locator('#after [data-node-id="a"]');expect(await element.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgb(255, 242, 204)');expect(await page.locator('#after [data-node-id="b"]').evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');const box=await element.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+30,box.y+box.height/2+20,{steps:8});await page.mouse.up();await expect(page.locator('#saveStatus')).toContainText('Черновик сохранён');
  await page.locator('#apply').click();await expect(page.locator('#apply')).toContainText('Передать агенту');let handoff;await expect.poll(async()=>{const r=await fetch(url+'/api/handoff');if(!r.ok)return false;handoff=await r.json();return handoff.document.root.children[0].props.offsetX===30;}).toBe(true);expect(handoff.document.root.children[0].props.offsetY).toBe(20);expect(handoff.document.layout.frames.a).toEqual(baseline.layout.frames.a);expect(handoff.document.root.children[1]).toEqual(baseline.root.children[1]);expect(handoff.document.root.children[0].source.instance).toBe('chip/a');expect(handoff.transfer.requiresAgent[0].property).toBe('scene');expect(handoff.report).toContain('runtime-сцены');
 }finally{if(child?.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
