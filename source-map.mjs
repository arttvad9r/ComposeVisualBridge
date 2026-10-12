import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {catalog,files,sourceRevision} from './scripts/native-project.mjs';

// A lexical index, not a Kotlin parser or a proof of a semantics -> source relation.
export function kotlinTokens(code) {
  const tokens=[];let i=0;
  while(i<code.length) {
    if(code.startsWith('//',i)){const end=code.indexOf('\n',i);i=end<0?code.length:end;continue;}
    if(code.startsWith('/*',i)){let depth=1;i+=2;while(i<code.length&&depth){if(code.startsWith('/*',i)){depth++;i+=2;}else if(code.startsWith('*/',i)){depth--;i+=2;}else i++;}continue;}
    const start=i;
    if(code[i]==='"'||code[i]==="'") {
      const quote=code[i],triple=code.startsWith('"""',i);i+=triple?3:1;let value='',literal=true,closed=false;
      while(i<code.length){if(code.startsWith(triple?'"""':quote,i)){i+=triple?3:1;closed=true;break;}
        const c=code[i++];if(c==='$'&&quote==='"')literal=false;
        if(c==='\\'&&!triple){const e=code[i++],esc={n:'\n',r:'\r',t:'\t',b:'\b','"':'"',"'":"'",'\\':'\\','$':'$'};
          if(e==='u'&&/^[a-f\d]{4}$/i.test(code.slice(i,i+4))){value+=String.fromCharCode(parseInt(code.slice(i,i+4),16));i+=4;}
          else if(Object.hasOwn(esc,e))value+=esc[e];else literal=false;
        }else value+=c;
      }
      tokens.push({kind:'string',value:literal&&closed&&quote==='"'?value:null,start,end:i});continue;
    }
    const word=/^[A-Za-z_][\w]*/.exec(code.slice(i));
    if(word){i+=word[0].length;tokens.push({kind:'word',value:word[0],start,end:i});}
    else {if(!/\s/.test(code[i]))tokens.push({kind:'symbol',value:code[i],start,end:i+1});i++;}
  }
  return tokens;
}
const lineAt=(code,offset)=>code.slice(0,offset).split('\n').length;
function location(file,line,reason) {
  const lines=file.lines||file.code.split('\n'),start=Math.max(1,line-1);
  return {file:file.name,line,reason,excerpt:lines.slice(start,line+1).map(value=>value.slice(0,800)).join('\n').slice(0,800),excerptStartLine:start};
}
function xmlText(value) {
  // Only plain strings; styled text and Android escapes remain unknown.
  if(/[<>\\]/.test(value))return null;
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[m]);
}
export async function indexWorkspace(workspace,revision) {
  const root=await realpath(workspace),build=await catalog(root);
  if(build.sourceRevision!==revision)throw Error('Ревизия кадра не совпадает со сборкой рабочей копии');
  const names=(await files(root)).filter(n=>/\.kt$/.test(n)||/[/\\]res[/\\]values[^/\\]*[/\\][^/\\]+\.xml$/.test(n));
  if(names.length>4000)throw Error('Слишком много файлов для индекса исходников');
  let bytes=0;const kotlin=[],resources=new Map();
  for(const name of names){const code=await readFile(path.join(root,name),'utf8');bytes+=Buffer.byteLength(code);if(bytes>32_000_000)throw Error('Индекс исходников больше 32 MB');
    const file={name:name.replaceAll(path.sep,'/'),code,lines:code.split('\n')};
    if(name.endsWith('.kt'))kotlin.push({...file,tokens:kotlinTokens(code)});
    else {const clean=code.replace(/<!--[\s\S]*?-->/g,m=>m.replace(/[^\n]/g,' '));
      for(const match of clean.matchAll(/<string\b[^>]*\bname="([\w]+)"[^>]*>([^]*?)<\/string>/g)){const value=xmlText(match[2]);if(value!==null){const entries=resources.get(value)||[];entries.push({key:match[1],...location(file,lineAt(code,match.index),'string-resource')});resources.set(value,entries);}}
    }
  }
  if(await sourceRevision(root)!==revision)throw Error('Исходники изменились во время индексации');
  const textLocations=new Map(),resourceReferences=new Map();
  const append=(map,key,value)=>{const entries=map.get(key)||[];entries.push(value);map.set(key,entries);};
  for(const file of kotlin){let line=1,offset=0;for(let i=0;i<file.tokens.length;i++){const token=file.tokens[i];while(offset<token.start){if(file.code[offset++]==='\n')line++;}
    if(token.kind==='string'&&token.value?.trim())append(textLocations,token.value,{file,line});
    if(token.value==='R'&&file.tokens[i+1]?.value==='.'&&file.tokens[i+2]?.value==='string'&&file.tokens[i+3]?.value==='.')append(resourceReferences,file.tokens[i+4]?.value,{file,line});
  }}
  return {root,build,kotlin,resources,textLocations,resourceReferences};
}
export function mapFrame(frame,index) {
  if(!index.build.previews?.includes(frame.preview))throw Error('Кадр не относится к Preview из каталога этой сборки');
  const nodes=frame.nodes.map(node=>{
    const candidates=[],seen=new Set();
    const add=(file,line,reason,resource)=>{const key=JSON.stringify([file.name,line,reason]);if(seen.has(key))return;seen.add(key);if(candidates.length<12)candidates.push({...location(file,line,reason),...(resource?{resource}:{})});};
    if(node.source.file&&node.source.line)for(const file of index.kotlin){const hint=node.source.file.replaceAll('\\','/');if((file.name===hint||(!hint.includes('/')&&path.posix.basename(file.name)===hint))&&node.source.line<=file.lines.length)add(file,node.source.line,'runtime-hint');}
    if(typeof node.text==='string'&&node.text.trim()){
      for(const hit of index.textLocations.get(node.text)||[])add(hit.file,hit.line,'text-literal');
      for(const resource of index.resources.get(node.text)||[])for(const hit of index.resourceReferences.get(resource.key)||[])add(hit.file,hit.line,'string-resource-reference',resource);
    }
    return {...node,source:{...node.source,candidates:candidates.slice(0,12),candidateCount:seen.size,confidence:seen.size?'candidate':'unknown'}};
  });
  const mapped={...frame,nodes,sourceFrameDigest:frame.sourceFrameDigest||frame.digest,sourceMapping:{format:'compose-visual-bridge-source-candidates-v1',workspace:index.root,sourceRevision:index.build.sourceRevision,apkSha256:index.build.apkSha256,requiresResolution:true}};
  mapped.digest=createHash('sha256').update(JSON.stringify({originalDigest:mapped.sourceFrameDigest,nodes,sourceMapping:mapped.sourceMapping})).digest('hex');
  return mapped;
}
export async function verifyMapping(frame) {
  if(!frame?.sourceMapping)return;
  const mapping=frame.sourceMapping,build=await catalog(mapping.workspace);
  if(build.sourceRevision!==frame.sourceRevision||build.apkSha256!==mapping.apkSha256)throw Error('Связь с исходниками устарела. Подключите новый кадр и рабочую копию.');
}
