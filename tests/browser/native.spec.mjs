import {test as base,expect} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {nativeSourceFixture} from '../native-source-fixture.mjs';
import {buddyFrame,metadata} from '../native-fixture.mjs';
const test=base.extend({native:async({page},use)=>{
  const data=await mkdtemp(path.join(tmpdir(),'bridge-native-browser-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});
  try {
    const url=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',c=>{text+=c;const m=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.on('error',reject);child.on('exit',()=>reject(Error(text)));});
    const state=async()=>await (await fetch(url+'/api/native')).json();
    const post=async(route,input)=>{const response=await fetch(url+'/api/native'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,revision:(await state()).revision})});return {status:response.status,value:await response.json()};};
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/native');await use({url,state,post});expect(errors).toEqual([]);
  }finally{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await rm(data,{recursive:true,force:true});}
}});

test('N01: настоящий PNG, точные bounds, намерение, подтверждение и неизменяемая передача',async({page,native})=>{
  await expect(page.locator('#nativeEmpty')).toBeVisible();
  await native.post('/frame',{...metadata,frame:buddyFrame()});await page.locator('#reloadNative').click();
  await expect(page.locator('#nativeImage')).toBeVisible();await expect(page.locator('#nativeTree .native-row')).toHaveCount(2);
  const image=await page.locator('#nativeImage').boundingBox();const target=page.getByRole('button',{name:'Выбрать: Нативный текст',exact:true});const box=await target.boundingBox();
  expect(Math.abs(box.x-image.x-image.width*.2)).toBeLessThan(1);expect(Math.abs(box.y-image.y-image.height*.2)).toBeLessThan(1);expect(Math.abs(box.width-image.width*.6)).toBeLessThan(1);
  await target.click();await page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:/^Точная правка/})}).locator('summary').first().click();await expect(page.locator('#nativeInspector')).toContainText('Settings.kt:42');
  await page.locator('#nativeProperty').selectOption('fontSize');await expect(page.locator('#nativeValue')).toHaveValue('14.0');await page.locator('#nativeValue').fill('16');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();await expect(page.locator('#nativeDraft')).toContainText('16');
  const unchanged=await page.locator('#nativeImage').getAttribute('src');await expect(page.locator('#applyNative')).toBeEnabled();
  await page.locator('#applyNative').click();await expect.poll(async()=>(await native.state()).applied?.mode).toBe('test');
  await page.locator('#nativeAck').check();await page.locator('#confirmNative').click();await expect(page.locator('#applyNative')).toBeEnabled();await page.locator('#applyNative').click();await expect(page.locator('#nativeSaveStatus')).toContainText('Снимок native-');
  const handoff=await(await fetch(native.url+'/api/native/handoff')).json();expect(handoff.intent.changes[0].value).toBe(16);expect(handoff.frame.sourceRevision).toBe(metadata.sourceRevision);expect(handoff.intent.changes[0].sourceRequiresResolution).toBe(true);
  await page.locator('#nativeValue').fill('18');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();await expect(page.locator('#nativeDraft')).toContainText('18');expect(await page.locator('#nativeImage').getAttribute('src')).toBe(unchanged);
  expect(await(await fetch(native.url+'/api/native/handoff')).json()).toEqual(handoff);
  expect((await native.post('/frame',{...metadata,frame:buddyFrame('Новый кадр')})).status).toBe(409);
  await page.reload();await expect(page.locator('#nativeDraft')).toContainText('18');await expect(page.locator('#nativeSaveStatus')).toContainText(handoff.applied.directory);
});

test('N02: узкий экран, клавиатурный выбор, справка и ошибка значения сохраняют работу',async({page,native})=>{
  await native.post('/frame',{...metadata,frame:buddyFrame()});await page.locator('#reloadNative').click();await page.setViewportSize({width:480,height:800});
  const row=page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'});await row.focus();await page.keyboard.press('Enter');await page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:/^Точная правка/})}).locator('summary').first().click();await expect(page.locator('#nativeEdit')).toBeVisible();
  await page.locator('#nativeHelp').click();await expect(page.locator('#helpDialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#nativeHelp')).toBeFocused();
  await page.locator('#nativeProperty').selectOption('fontSize');await page.locator('#nativeValue').fill('-1');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();await expect(page.locator('#notice')).toContainText('Недопустимый');expect((await native.state()).draft).toEqual([]);
  await page.locator('#nativeValue').fill('17');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();await expect(page.locator('#nativeDraft')).toContainText('17');
  await expect(page.locator('#nativeInspector')).toContainText('0.60 × 0.30 dp');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(overflow).toBe(false);
});


test('N03: выбранный элемент показывает Kotlin-кандидатов и блокирует правки после изменения исходников',async({page,native})=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'bridge-source-browser-'));
  try{
    const f=await nativeSourceFixture(workspace);
    await native.post('/frame',{...metadata,sourceRevision:f.revision,frame:buddyFrame()});await page.locator('#reloadNative').click();
    await page.getByText('Исходники экрана',{exact:true}).click();await page.locator('#nativeWorkspace').fill(workspace);await page.getByRole('button',{name:'Найти в Kotlin',exact:true}).click();
    await expect(page.locator('#notice')).toBeEmpty();
    await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();
    await expect(page.locator('#nativeInspector')).toContainText('Места в исходниках: 3 · требуется проверка связи');
    await page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:/^Связь с кодом/})}).locator('summary').first().click();
    const candidate=page.locator('#nativeInspector details.native-code-candidate').filter({has:page.locator('summary').filter({hasText:'Settings.kt:3'})});await candidate.locator('summary').click();
    await expect(candidate.locator('pre')).toContainText('fontSize = 14.sp');
    await page.setViewportSize({width:480,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.setViewportSize({width:1280,height:720});
    await page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:/^Точная правка/})}).locator('summary').first().click();
    await page.locator('#nativeProperty').selectOption('fontSize');await page.locator('#nativeValue').fill('16');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();
    await expect(page.getByRole('button',{name:'Найти в Kotlin',exact:true})).toBeDisabled();
    await page.locator('#nativeAck').check();await page.locator('#confirmNative').click();await page.locator('#applyNative').click();
    await expect(page.locator('#nativeSaveStatus')).toContainText('Снимок native-');
    const snapshot=await(await fetch(native.url+'/api/native/handoff')).json();expect(snapshot.intent.changes[0].source.candidates).toHaveLength(3);
    await page.reload();await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();await expect(page.locator('#nativeInspector')).toContainText('Settings.kt:3');
    await page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:/^Точная правка/})}).locator('summary').first().click();
    await writeFile(f.file,f.code+'// changed');await page.locator('#nativeValue').fill('18');await page.getByRole('button',{name:'Сохранить намерение',exact:true}).click();
    await expect(page.locator('#notice')).toContainText('устарел');expect(await(await fetch(native.url+'/api/native/handoff')).json()).toEqual(snapshot);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

async function editorFrame(page,native){const frame=buddyFrame();frame.image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=360;c.height=780;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,360,780);ctx.fillStyle='#222';ctx.font='20px sans-serif';ctx.fillText('Нативный текст',30,85);return c.toDataURL('image/png').split(',')[1];});frame.semantics.bounds={left:0,top:0,right:360,bottom:780};frame.semantics.children[0].bounds={left:30,top:50,right:230,bottom:110};frame.semantics.children.push({id:8,name:'Card',bounds:{left:20,top:150,right:340,bottom:350},children:[]});await native.post('/frame',{...metadata,frame});await page.locator('#reloadNative').click();await expect(page.locator('#nativeImage')).toBeVisible();return frame;}
const draftValue=async(native,key,id='7')=>(await native.state()).draft.find(i=>i.nodeId===id&&i.property===key)?.value;
const nativeGroup=(page,name)=>page.locator('#nativeInspector > details').filter({has:page.locator('summary').filter({hasText:new RegExp('^'+name)})});

test('N04: общая оболочка, drag, восемь resize, Esc, сохранённая история и масштаб',async({page,native})=>{
  await page.setViewportSize({width:1600,height:1000});await editorFrame(page,native);await expect(page.locator('.workspace')).toBeVisible();await expect(page.locator('.inspector.panel')).toBeVisible();await expect(page.locator('.layers.panel')).toBeVisible();
  await page.locator('#single').click();const slider=page.getByRole('slider',{name:'Масштаб в процентах'});await slider.focus();await slider.press('End');await expect(slider).toHaveValue('200');
  const target=page.getByRole('button',{name:'Выбрать: Нативный текст',exact:true});let box=await target.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+80,box.y+box.height/2+40,{steps:5});await page.mouse.up();
  await expect.poll(()=>draftValue(native,'offsetX')).toBe(40);await expect.poll(()=>draftValue(native,'offsetY')).toBe(20);expect((await native.state()).history.undo).toBe(1);
  await page.locator('#undo').click();await expect.poll(async()=>(await native.state()).draft.length).toBe(0);await page.locator('#redo').click();await expect.poll(()=>draftValue(native,'offsetX')).toBe(40);
  await page.reload();await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();await expect(page.locator('#nativeField_offsetX')).toHaveValue('40');await page.locator('#undo').click();await expect.poll(async()=>(await native.state()).draft.length).toBe(0);
  await expect(page.locator('#saveStatus')).toContainText('сохранён');
  for(const direction of ['nw','n','ne','e','se','s','sw','w']){await expect(page.locator('#saveStatus')).toContainText('сохранён');const h=page.getByRole('button',{name:'Изменить размер: '+direction,exact:true});box=await h.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+10,box.y+box.height/2+8,{steps:3});await page.mouse.up();await expect.poll(()=>draftValue(native,'width')).not.toBeUndefined();const saved=await native.state();expect(saved.history.undo).toBe(1);expect(saved.draft.find(i=>i.property==='height').value).toBeGreaterThan(0);await page.locator('#undo').click();await expect.poll(async()=>(await native.state()).draft.length).toBe(0);}
  await expect(page.locator('#saveStatus')).toContainText('сохранён');
  const h=page.getByRole('button',{name:'Изменить размер: se',exact:true});box=await h.boundingBox();await page.mouse.move(box.x+4,box.y+4);await page.mouse.down();await page.mouse.move(box.x+30,box.y+20);await page.keyboard.press('Escape');await page.mouse.up();expect((await native.state()).draft).toEqual([]);
});

test('N05: полноценные свойства, структурные намерения, новые элементы, поиск и отчёт',async({page,native})=>{
  await editorFrame(page,native);await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();
  await expect(page.locator('#nativeField_fontWeight')).toHaveValue('400');await expect(page.locator('#nativeField_fontFamily')).toHaveValue('FontFamily.SansSerif');await expect(page.locator('#nativeField_letterSpacing')).toHaveValue('0.5');
  await page.locator('#nativeField_align').selectOption('center');await expect.poll(()=>draftValue(native,'align')).toBe('center');
  await page.locator('#nativeSizeMode_width').selectOption('fill');await expect.poll(()=>draftValue(native,'width')).toBe('fill');
  await page.locator('#nativeField_padding').fill('16');await page.locator('#nativeField_padding').press('Tab');await expect.poll(()=>draftValue(native,'padding')).toBe(16);
  await nativeGroup(page,'Внешний вид').locator('summary').first().click();await page.locator('#nativeField_background').fill('#123456');await page.locator('#nativeField_background').press('Tab');await expect.poll(()=>draftValue(native,'background')).toBe('#123456');
  await nativeGroup(page,'Структура').locator('summary').first().click();await page.locator('#nativeParent').selectOption('8');await expect.poll(()=>draftValue(native,'moveTo')).toEqual({parentId:'8',index:0});
  await page.locator('#nativeTree .native-row').filter({hasText:'Карточка'}).click();await page.locator('#newType').selectOption('Text');await page.locator('#add').click();await expect.poll(async()=>((await draftValue(native,'addChild','8'))||[]).length).toBe(1);
  await page.locator('#nativeTree .native-row').filter({hasText:'Новый текст'}).click();await page.locator('#nativeField_text').fill('Созданный текст');await page.locator('#nativeField_text').press('Tab');await expect.poll(async()=>(await draftValue(native,'addChild','8'))?.[0].text).toBe('Созданный текст');
  await page.locator('#nativeField_fontSize').fill('18');await page.locator('#nativeField_fontSize').press('Tab');await expect.poll(async()=>(await draftValue(native,'addChild','8'))?.[0].properties.fontSize).toBe(18);
  await page.locator('#nativeSearch').fill('Созданный');await expect(page.locator('#nativeTree .native-row')).toHaveCount(1);await page.locator('#nativeSearch').fill('');
  await page.locator('#nativeAck').check();await page.locator('#confirmNative').click();await page.locator('#applyNative').click();await expect.poll(async()=>!!(await native.state()).applied).toBe(true);
  await page.locator('#toggleChanges').click();await page.locator('#advancedTools > summary').click();await page.locator('#readReport').click();await expect(page.locator('#reportDialog')).toBeVisible();await expect(page.locator('#reportText')).toContainText('Созданный текст');await page.locator('#closeReport').click();
  const capture=await(await fetch(native.url+'/api/native/export')).json();expect(capture.frame.image.length).toBeGreaterThan(100);expect(capture.frame.semantics.children).toHaveLength(2);
});

test('N06: конфликт не теряет локальную правку; загрузка сервера скачивает её',async({page,native})=>{
  await editorFrame(page,native);await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();await page.locator('#nativeField_fontSize').fill('19');
  await native.post('/draft',{digest:(await native.state()).frame.digest,intents:[{nodeId:'7',property:'fontSize',value:22}]});
  await page.locator('#nativeField_fontSize').press('Tab');await expect(page.locator('#notice')).toContainText('изменена');await expect(page.locator('#applyNative')).toBeDisabled();expect(await draftValue(native,'fontSize')).toBe(22);
  const download=page.waitForEvent('download');await page.locator('#reloadNative').click();expect((await download).suggestedFilename()).toBe('несохранённые-правки.json');await expect(page.locator('#nativeField_fontSize')).toHaveValue('22');
});

test('N07: быстрые правки и Apply сохраняют последнее значение; ошибка записи блокирует передачу',async({page,native})=>{
  await editorFrame(page,native);await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();
  let release,started;const gate=new Promise(r=>release=r),requestStarted=new Promise(r=>started=r);let first=true;
  await page.route('**/api/native/draft',async route=>{if(first){first=false;started();await gate;}await route.continue();});
  await page.locator('#nativeField_fontSize').fill('18');await page.locator('#nativeField_fontSize').press('Tab');await requestStarted;
  await page.locator('#nativeField_alignX').selectOption('center');await page.locator('#nativeField_fontSize').fill('20');await page.locator('#nativeField_fontSize').press('Tab');await expect(page.locator('#testMode')).toHaveCount(0);await page.locator('#applyNative').click();release();
  await expect.poll(async()=>!!(await native.state()).applied).toBe(true);const snapshot=await(await fetch(native.url+'/api/native/handoff')).json();expect(snapshot.intent.changes.find(i=>i.property==='fontSize').value).toBe(20);expect(snapshot.intent.changes.find(i=>i.property==='alignX').value).toBe('center');
  await page.unroute('**/api/native/draft');await page.route('**/api/native/draft',route=>route.abort());await page.locator('#nativeField_fontSize').fill('21');await page.locator('#nativeField_fontSize').press('Tab');await expect(page.locator('#saveStatus')).toContainText('несохранённые');await expect(page.locator('#applyNative')).toBeDisabled();expect(await(await fetch(native.url+'/api/native/handoff')).json()).toEqual(snapshot);
  await page.unroute('**/api/native/draft');await page.reload();await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();await expect(page.locator('#nativeField_fontSize')).toHaveValue('21');await expect(page.locator('#applyNative')).toBeDisabled();
});

test('N08: resize контейнера сохраняет позиции детей и остаётся одной операцией Undo',async({page,native})=>{
  const frame=await editorFrame(page,native);frame.semantics.children[1].children=[{id:9,name:'Text',bounds:{left:50,top:180,right:120,bottom:220},mergedSemantics:{text:'Внутри'},children:[]}];await native.post('/frame',{...metadata,frame});await page.locator('#reloadNative').click();await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.locator('#nativeTree .native-row').filter({hasText:'Карточка'}).click();
  const handle=page.getByRole('button',{name:'Изменить размер: nw',exact:true}),box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+10,box.y+box.height/2+8,{steps:3});await page.mouse.up();await expect.poll(()=>draftValue(native,'offsetX','8')).toBe(10);await expect.poll(()=>draftValue(native,'offsetX','9')).toBe(-10);expect(await draftValue(native,'offsetY','9')).toBe(-8);expect((await native.state()).history.undo).toBe(1);await expect(page.locator('#saveStatus')).toContainText('сохранён');
  await page.locator('#nativeTree .native-row').filter({hasText:'Внутри'}).click();const original=await page.getByRole('button',{name:'Выбрать: Внутри',exact:true}).boundingBox(),planned=await page.locator('#nativeGhost').boundingBox();expect(Math.abs(original.x-planned.x)).toBeLessThan(1);expect(Math.abs(original.y-planned.y)).toBeLessThan(1);await page.locator('#undo').click();await expect.poll(async()=>(await native.state()).draft.length).toBe(0);
});

test('Ошибка native-операции остаётся ошибкой после опроса сервера и снимается успешной операцией',async({page,native})=>{
  await editorFrame(page,native);await page.locator('#nativeAck').check();
  await page.route('**/api/native/confirm',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Ошибка записи подтверждения'})}));
  await page.locator('#confirmNative').click();await expect(page.locator('#notice')).toContainText('Ошибка записи подтверждения');
  await expect(page.locator('#saveStatus')).toHaveText('Ошибка операции');
  await expect.poll(async()=>{await page.evaluate(()=>fetch('/api/native'));return page.locator('#saveStatus').textContent();}).toBe('Ошибка операции');
  // The periodic refresh must not turn a failed mutation into a successful save.
  await page.waitForTimeout(1700);await expect(page.locator('#saveStatus')).toHaveText('Ошибка операции');
  await page.unroute('**/api/native/confirm');await page.locator('#confirmNative').click();
  await expect.poll(async()=>(await native.state()).confirmedDigest).toBe((await native.state()).frame.digest);
  await expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
});

test('Отказ native Apply и Undo сохраняет снимок, историю и сообщение об ошибке',async({page,native})=>{
  await editorFrame(page,native);await page.locator('#nativeTree .native-row').filter({hasText:'Нативный текст'}).click();
  await page.locator('#nativeField_fontSize').fill('18');await page.locator('#nativeField_fontSize').press('Tab');
  await expect.poll(()=>draftValue(native,'fontSize')).toBe(18);await expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  await page.locator('#applyNative').click();await expect.poll(async()=>!!(await native.state()).applied).toBe(true);
  await expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  const snapshot=await(await fetch(native.url+'/api/native/handoff')).json(),before=await native.state();
  for(const [route,button] of [['apply','applyNative'],['history','undo']]){
    await page.route('**/api/native/'+route,request=>request.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Ошибка операции '+route})}));
    await page.locator('#'+button).click();await expect(page.locator('#notice')).toContainText('Ошибка операции '+route);
    await expect(page.locator('#saveStatus')).toHaveText('Ошибка операции');
    expect(await native.state()).toEqual(before);expect(await(await fetch(native.url+'/api/native/handoff')).json()).toEqual(snapshot);
    await page.unroute('**/api/native/'+route);
  }
  await page.locator('#undo').click();await expect.poll(async()=>(await native.state()).draft.length).toBe(0);
  await expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  expect(await(await fetch(native.url+'/api/native/handoff')).json()).toEqual(snapshot);
});
