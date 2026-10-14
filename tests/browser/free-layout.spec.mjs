import {test as base,expect} from '@playwright/test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
// A captured Preview screen in free layout: every element has a measured frame, the title keeps native metrics.
const title={text:'BridgeLab',fontSize:32,lineHeight:24,fontWeight:700,fontFamily:'Roboto',maxLines:1};
const baseline={schemaVersion:1,name:'Вход',viewport:{width:400,height:520,presentation:'content'},
 root:{id:'root',type:'Column',props:{background:'#FFFFFF'},children:[
  {id:'title',type:'Text',props:title},
  {id:'login',type:'Button',props:{text:'Войти',fontSize:14,background:'#6750A4',color:'#FFFFFF',radius:24}},
  {id:'register',type:'Button',props:{text:'Регистрация',fontSize:14,color:'#6750A4',radius:24}},
  {id:'card',type:'Card',props:{background:'#EEEEEE'},children:[]}]},
 layout:{mode:'free',frames:{root:{parent:null,x:0,y:0,width:400,height:520},title:{parent:'root',x:125,y:20,width:150,height:37.333},
  login:{parent:'root',x:24,y:90,width:352,height:48},register:{parent:'root',x:145,y:150,width:110,height:48},card:{parent:'root',x:24,y:260,width:352,height:200}}},
 compose:{capture:{textGeometry:{title:{...title,lineCount:1,textHeight:37.333,layoutWidth:150}}}}};
const test=base.extend({bridge:async({page},use)=>{
 const data=await mkdtemp(path.join(tmpdir(),'cvb-free-layout-'));let child,exited;const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));
  child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',reject);child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  const state=async()=>(await fetch(`${url}/api/session`)).json(), saved=()=>expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  await page.goto(url);await saved();await page.locator('#single').click();await page.locator('#zoom').selectOption('1');
  await use({state,saved});
  expect(errors).toEqual([]);
 }finally{if(child?.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
}});
const box=(page,id)=>page.evaluate(id=>{const n=document.querySelector(`#after [data-node-id="${id}"]`),r=n.getBoundingClientRect(),o=document.querySelector('#after .phone').getBoundingClientRect();return {x:r.left-o.left,y:r.top-o.top,width:r.width,height:r.height};},id);
async function dragTo(page,from,x,y){
 const start=await from.boundingBox();await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
 await page.mouse.move(x,y,{steps:15});await page.mouse.up();await expect(page.locator('body')).not.toHaveClass(/dragging/);
}

test('Правка текста: рамка растёт по содержимому, центр на месте, буквы не обрезаны строкой темы',async({page,bridge})=>{
 const before=await box(page,'title');
 await page.locator('#after [data-node-id="title"]').click();await page.locator('[data-property=text]').fill('BridgeLab для всех');await page.locator('[data-property=text]').press('Tab');await bridge.saved();
 const after=await box(page,'title'),label=page.locator('#after [data-node-id="title"] .text-content');
 expect(after.width).toBeGreaterThan(before.width+50);
 expect(after.x+after.width/2).toBeCloseTo(before.x+before.width/2,0);
 expect(await label.evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
 await expect(label).toHaveCSS('overflow-y','visible');
 await expect(page.locator('#after [data-node-id="title"]')).toHaveCSS('line-height','37.333px');
});

test('Порядок в колонке меняет места элементов, остальные не сдвигаются',async({page,bridge})=>{
 const title=await box(page,'title'),card=await box(page,'card'),login=await box(page,'login');
 const target=await page.locator('#tree [data-node-id="login"]').boundingBox();
 await dragTo(page,page.locator('#tree [data-node-id="register"]'),target.x+target.width/2,target.y+4);await bridge.saved();
 expect((await bridge.state()).current.root.children.map(n=>n.id)).toEqual(['title','register','login','card']);
 expect(await box(page,'title')).toEqual(title);expect(await box(page,'card')).toEqual(card);
 expect((await box(page,'register')).y).toBeCloseTo(login.y,1);
 expect((await box(page,'login')).y).toBeCloseTo(login.y+48+12,1);
});

test('Перенос в другой контейнер на макете ставит элемент под указатель и сохраняет размер',async({page,bridge})=>{
 const others=await Promise.all(['title','register','card'].map(id=>box(page,id)));
 const card=await page.locator('#after [data-node-id="card"]').boundingBox();
 await dragTo(page,page.locator('#tree [data-node-id="login"]'),card.x+card.width/2,card.y+card.height/2);await bridge.saved();
 const current=(await bridge.state()).current;
 expect(current.root.children.find(n=>n.id==='card').children.map(n=>n.id)).toEqual(['login']);
 expect(current.layout.frames.login).toMatchObject({parent:'card',width:352,height:48});
 const login=await box(page,'login'),cardBox=await box(page,'card');
 expect(login.y+login.height/2).toBeCloseTo(cardBox.y+cardBox.height/2,0);
 expect(await Promise.all(['title','register','card'].map(id=>box(page,id)))).toEqual(others);
});
