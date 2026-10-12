import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {decodePng} from '../../scripts/compare-png.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('Runtime scene: nonlinear sp, trimmed multiline text and paint inside the touch target survive reload',async({page})=>{
 const data=await mkdtemp(path.join(tmpdir(),'cvb-scene-browser-'));let child,exited;const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const text={text:'Первая строка\nВторая строка',fontSize:15,lineHeight:21,fontFamily:'Roboto',fontWeight:400,maxLines:2};
 const curve=Array.from({length:301},(_,i)=>Math.round((i*.5+Math.min(i*.3,15))*100));
 const baseline={schemaVersion:1,name:'Нативная типографика',viewport:{width:360,height:300,fontScale:1.6,presentation:'content'},root:{id:'root',type:'Column',props:{background:'#FFFFFF',borderWidth:2},children:[{id:'text',type:'Text',props:text},{id:'chip',type:'Button',props:{text:'Кнопка',fontSize:13.5,fontFamily:'Roboto',fontWeight:500,background:'#FFF2CC',radius:8}}]},layout:{mode:'free',frames:{root:{parent:null,x:0,y:0,width:360,height:300},text:{parent:'root',x:-2,y:-2,width:200,height:64},chip:{parent:'root',x:18,y:98,width:100,height:48}}},compose:{capture:{fontHashes:{Roboto:'d5633ff957d2ecb1ce7716e86e11057091c3526042efe16fe1f65dfc06a65551'},fontScale:1.6,fontScaleCurve:curve,textGeometry:{text:{...text,lineCount:2,textHeight:40,fontDp:25,lineAdvance:33.6,lineWidths:[140,155],layoutWidth:200,lineRanges:[{start:0,end:13,ellipsis:false},{start:14,end:27,ellipsis:false}]},chip:{text:'Кнопка',fontSize:13.5,fontFamily:'Roboto',fontWeight:500,lineCount:1,textHeight:10,paintInsets:{left:0,top:8,right:0,bottom:8}}}}}};
 baseline.root.children.push({id:'wrapped-chip',type:'Button',props:{...text}});baseline.layout.frames['wrapped-chip']={parent:'root',x:18,y:178,width:200,height:70};baseline.compose.capture.textGeometry['wrapped-chip']={...baseline.compose.capture.textGeometry.text,textBoxWidth:170};
 try{
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));
  child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',reject);child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  const check=async()=>{
   await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);await page.addStyleTag({content:'.layout-node.selected{outline:none!important}.layout-node.selected:before,.selection-frame{visibility:hidden!important}'});
   const metrics=await page.locator('#after [data-node-id="text"]').evaluate(element=>{const rect=element.getBoundingClientRect(),root=document.querySelector('#after .phone').getBoundingClientRect(),style=getComputedStyle(element),label=getComputedStyle(element.querySelector('.text-content'));return {x:rect.x-root.x,y:rect.y-root.y,size:style.fontSize,line:style.lineHeight,transform:label.transform};});
   await expect(page.locator('#after [data-node-id=\"text\"] .native-line')).toHaveCount(2);
   const widths=await page.locator('#after [data-node-id="text"] .native-line-glyphs').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));expect(widths[0]).toBeCloseTo(140,2);expect(widths[1]).toBeCloseTo(155,2);
   expect(await page.evaluate(()=>document.fonts.check('24px \"Roboto 3.015\"'))).toBe(true);
   await expect(page.locator('#after [data-node-id=\"text\"]')).toHaveCSS('font-family','\"Roboto 3.015\"');
   expect(metrics).toEqual({x:0,y:0,size:'25px',line:'33.6px',transform:'matrix(1, 0, 0, 1, 0, -1.6)'});
   const wrapped=page.locator('#after [data-node-id="wrapped-chip"] .text-content');await expect(wrapped).toHaveCSS('transform','none');await expect(wrapped).toHaveCSS('width','170px');await expect(wrapped).toHaveCSS('text-align','left');const starts=await wrapped.locator('.native-line-glyphs').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().left));expect(starts[0]).toBe(starts[1]);
   const paint=await page.locator('#after [data-node-id="chip"] .native-paint').boundingBox();expect(paint.height).toBe(32);
   const image=decodePng(await page.locator('#after .phone').screenshot()),pixel=(x,y)=>Array.from(image.data.subarray((y*image.width+x)*image.channels,(y*image.width+x)*image.channels+3));expect(pixel(30,103)).toEqual([255,255,255]);expect(pixel(30,112)).toEqual([255,242,204]);
  };
  await page.goto(url);await check();await page.reload();await check();
  const changed=structuredClone(baseline);changed.viewport.fontScale=1;await page.locator('#file').setInputFiles({name:'font-scale.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(changed))});await expect(page.locator('#notice')).toContainText('Загружен макет');await expect(page.locator('#after [data-node-id=\"text\"]')).toHaveCSS('font-size','15px');await expect(page.locator('#after [data-node-id=\"text\"]')).toHaveCSS('line-height','21px');
  expect(errors).toEqual([]);
 }finally{if(child?.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
