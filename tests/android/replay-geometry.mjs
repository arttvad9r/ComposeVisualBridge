// Compare the current renderer with retained, provenance-checked real Android captures.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {importCompose} from '../../compose.mjs';
import {decodePng} from '../../scripts/compare-png.mjs';

const [captures,output]=process.argv.slice(2);
if(!captures||!output)throw Error('Нужны каталог сохранённого Android-прогона и новый каталог результатов');
await mkdir(output);
const repo=fileURLToPath(new URL('../../',import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'cvb-geometry-replay-'));
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:2}),evidence={freshAndroidBuild:false,cycles:[],browserErrors:[]};
page.on('pageerror',error=>evidence.browserErrors.push(error.message));
try{
 for(let cycle=0;cycle<=2;cycle++){
  const old=JSON.parse(await readFile(path.join(captures,`${cycle}-import.json`),'utf8'));
  const source=cycle?JSON.parse(await readFile(path.join(captures,`${cycle}-plan.json`),'utf8')).code:await readFile(new URL('./GeometryScreen.kt',import.meta.url),'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),old.compose.fileHash,'Kotlin должен соответствовать сохранённому импорту');
  const capture=JSON.parse(await readFile(path.join(captures,`${cycle}-capture.json`),'utf8')),build=JSON.parse(await readFile(path.join(captures,`${cycle}-build.json`),'utf8'));
  assert.equal(capture.frame.sourceRevision,build.sourceRevision,'Кадр должен соответствовать успешной сборке');
  const data=path.join(temp,String(cycle));await mkdir(path.join(data,path.dirname(old.compose.file)),{recursive:true});await writeFile(path.join(data,old.compose.file),source);
  const document=await importCompose({workspace:data,file:old.compose.file,symbol:'GeometryScreen'});document.viewport.presentation='content';
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline:document,current:document,applied:null}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');
  try{
   const url=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error(log)),10000);child.once('error',reject);child.stderr.on('data',chunk=>log+=chunk);child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
   await page.goto(url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);
   const geometry=await page.evaluate(root=>{const phone=document.querySelector('#after .phone').getBoundingClientRect(),rect=id=>{const r=document.querySelector(`#after [data-node-id="${id}"]`).getBoundingClientRect();return {x:r.x-phone.x,y:r.y-phone.y,width:r.width,height:r.height};};return Object.fromEntries(root.children.map(box=>[box.children[0].props.text,{outer:rect(box.id),inner:rect(box.children[0].id)}]));},document.root);
   const bytes=await page.locator('#after .phone').screenshot();await writeFile(path.join(output,`${cycle}-browser.png`),bytes);
   const html=decodePng(bytes),native=decodePng(await readFile(path.join(captures,`${cycle}-native.png`))),density=capture.frame.densityDpi/160;
   const pixel=(png,x,y)=>Array.from(png.data.subarray((Math.floor(y*density)*png.width+Math.floor(x*density))*png.channels,(Math.floor(y*density)*png.width+Math.floor(x*density))*png.channels+3));
   assert.equal(html.width,native.width);assert.equal(html.height,native.height);
   const paint=[];
   for(const box of document.root.children){
    const label=box.children[0].props.text;
    for(const [group,id] of [['outer',box.id],['inner',box.children[0].id]]){
     const bounds=capture.frame.nodes.find(node=>node.properties.bridgeSourceKey===id).bounds;
     const actual={x:bounds.left/density,y:bounds.top/density,width:(bounds.right-bounds.left)/density,height:(bounds.bottom-bounds.top)/density};
     for(const key of Object.keys(actual))assert.ok(Math.abs(actual[key]-geometry[label][group][key])<0.5,`${cycle}/${label}/${group}.${key}: Android=${actual[key]}, HTML=${geometry[label][group][key]}`);
    }
    const {outer,inner}=geometry[label],color=box.props.background.slice(1).match(/../g).map(hex=>parseInt(hex,16));
    const samples=[{x:inner.x+inner.width-4,y:inner.y+4,color}];if(inner.y>outer.y)samples.push({x:outer.x+4,y:outer.y+4,color:[255,255,255]});
    for(const sample of samples){assert.deepEqual(pixel(native,sample.x,sample.y),sample.color);assert.deepEqual(pixel(html,sample.x,sample.y),sample.color);paint.push({label,...sample});}
   }
   evidence.cycles.push({cycle,sourceHash:old.compose.fileHash,compiledRevision:build.sourceRevision,geometry,paint});
   console.log(`Сохранённый Android-кадр ${cycle}: размеры, позиции и фон совпадают с новым renderer`);
  }finally{if(child.exitCode===null){child.kill();await exited;}}
 }
 assert.deepEqual(evidence.browserErrors,[]);evidence.visualMatches=true;await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
}finally{await browser.close();await rm(temp,{recursive:true,force:true});}
