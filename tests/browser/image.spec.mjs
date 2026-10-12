import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
// 2x2 opaque PNG: any captured icon crop.
const icon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNgYPj/n4GBgQEAFvQB/zsyvPQAAAAASUVORK5CYII=';
test('Захваченная иконка в строке сохраняет размер кадра, а не растягивается до 50px',async({page})=>{
 const data=await mkdtemp(path.join(tmpdir(),'cvb-image-browser-'));let child,exited;
 const baseline={schemaVersion:1,name:'Иконки',viewport:{width:360,height:200,presentation:'content'},
  root:{id:'root',type:'Column',props:{},children:[{id:'row',type:'Row',props:{},children:[{id:'icon',type:'Image',props:{src:icon,text:'Иконка'}},{id:'label',type:'Text',props:{text:'Период',fontSize:14}}]}]},
  layout:{mode:'free',frames:{root:{parent:null,x:0,y:0,width:360,height:200},row:{parent:'root',x:0,y:16,width:360,height:44},icon:{parent:'row',x:12,y:12,width:20,height:20},label:{parent:'row',x:44,y:14,width:200,height:17}}}};
 try{
  await writeFile(path.join(data,'session.json'),JSON.stringify({revision:0,baseline,current:baseline,applied:null}));
  child=spawn(process.execPath,['server.mjs'],{cwd:repo,env:{...process.env,PORT:'0',BRIDGE_DATA:data},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
  const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output)),10000);child.once('error',reject);child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  await page.goto(url);await page.locator('#single').click();await page.locator('#zoom').selectOption('1');
  const box=await page.locator('#after [data-node-id="icon"] img').boundingBox(),row=await page.locator('#after [data-node-id="row"]').boundingBox();
  expect(box.width).toBeCloseTo(20,1);expect(box.height).toBeCloseTo(20,1);expect(box.y-row.y).toBeCloseTo(12,1);
 }finally{if(child&&child.exitCode===null){child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
