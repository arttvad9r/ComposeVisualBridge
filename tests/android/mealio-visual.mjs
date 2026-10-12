import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {decodePng} from '../../scripts/compare-png.mjs';
import {indexTree} from '../../public/model.mjs';
const rgb=hex=>hex.match(/[\da-f]{2}/gi).map(x=>parseInt(x,16));
const distance=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
function pixel(image,x,y){const start=(Math.round(y)*image.width+Math.round(x))*image.channels;return [...image.data.subarray(start,start+3)];}
function ink(image,rect,color){
 const rows=[];let left=Infinity,right=-Infinity;
 for(let y=Math.max(0,Math.ceil(rect.top));y<Math.min(image.height,Math.floor(rect.bottom));y++){
  let found=false;for(let x=Math.max(0,Math.ceil(rect.left));x<Math.min(image.width,Math.floor(rect.right));x++)if(distance(pixel(image,x,y),color)<35){left=Math.min(left,x);right=Math.max(right,x);found=true;}
  if(found)rows.push(y);
 }
 const lines=[];for(const y of rows){if(!lines.length||y-lines.at(-1).bottom>3)lines.push({top:y,bottom:y});else lines.at(-1).bottom=y;}
 return {left,right,lines};
}
export function verifyMealioVisual(document,nativePng,browserPng){
 const native=decodePng(nativePng),browser=decodePng(browserPng),density=document.compose.capture.densityDpi/160;
 assert.equal(native.width,browser.width);assert.equal(native.height,browser.height);const result={text:[],paint:[]},map=indexTree(document.root);
 const absolute=id=>{const f=document.layout.frames[id];if(!f.parent)return {x:f.x,y:f.y};const p=absolute(f.parent),border=map.get(f.parent).node.props.borderWidth||0;return {x:p.x+f.x+border,y:p.y+f.y+border};};
 for(const [id,{node}] of map){const f=document.layout.frames[id],position=absolute(id),rect={left:position.x*density,top:position.y*density,right:(position.x+f.width)*density,bottom:(position.y+f.height)*density};
  if(rect.top<0||rect.bottom>native.height||rect.right>native.width||rect.left<0)continue;
  if(['Text','Button'].includes(node.type)&&node.props.color&&node.props.text){
   const color=rgb(node.props.color),a=ink(native,rect,color),b=ink(browser,rect,color);if(document.compose.capture.textGeometry[id]?.paintVisible===false){assert.equal(a.lines.length,0,id+': нативная подпись скрыта');assert.equal(b.lines.length,0,id+': HTML-подпись скрыта');result.text.push({id,hidden:true});continue;}assert.ok(a.lines.length&&b.lines.length,id+': текст должен быть видим');
   assert.equal(b.lines.length,a.lines.length,id+': число видимых строк');
   for(let i=0;i<a.lines.length;i++)for(const edge of ['top','bottom'])assert.ok(Math.abs(a.lines[i][edge]-b.lines[i][edge])<=2*density,id+': положение строки '+i+'/'+edge+' '+JSON.stringify({a:a.lines,b:b.lines}));
   for(const edge of ['left','right'])assert.ok(Math.abs(a[edge]-b[edge])<=3*density,id+': горизонтальная граница текста '+edge+' '+a[edge]+'/'+b[edge]);
   result.text.push({id,text:node.props.text,native:a,browser:b});
  }
  if(node.props.background){
   const inset=document.compose.capture.textGeometry?.[id]?.paintInsets||{left:0,top:0,right:0,bottom:0},radius=node.props.radius||0,border=node.props.borderWidth||0;
   const x=rect.left+(inset.left+radius+border+3)*density,y=rect.top+(inset.top+border+3)*density,expected=rgb(node.props.background);
   if(x<rect.right&&y<rect.bottom){const a=pixel(native,x,y),b=pixel(browser,x,y);assert.ok(distance(a,expected)<=4,id+': нативная заливка '+a+'/'+expected);assert.ok(distance(b,expected)<=4,id+': HTML-заливка '+b+'/'+expected);result.paint.push({id,x,y,native:a,browser:b});}
   if(inset.top>0){const x=(rect.left+rect.right)/2,y=rect.top+inset.top*density/2;assert.ok(distance(pixel(native,x,y),pixel(browser,x,y))<=4,id+': отступ вне заливки');}
  }
 }
 assert.ok(result.text.length>=10,'Должен быть проверен весь видимый текст сцены');assert.ok(result.paint.length>=5,'Должны быть проверены фоны карточек и кнопок');return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const out=process.argv[2];assert.ok(out);for(const name of ['0','1','2','dark','long','compact-large','large-full']){
  const document=JSON.parse(await readFile(out+'/'+name+'-document.json')),result=verifyMealioVisual(document,await readFile(out+'/'+name+'-native.png'),await readFile(out+'/'+name+'-browser.png'));
  await writeFile(out+'/'+name+'-visual-check.json',JSON.stringify(result,null,2));console.log(name+': '+result.text.length+' текстовых областей, '+result.paint.length+' заливок');
 }
}
