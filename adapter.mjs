import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {kotlinTokens} from './compose.mjs';
import {sceneCalls} from './scene.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

// Compose call → editor type. Leaves stand for the whole call: nothing inside them is bound.
const TYPES={__proto__:null,Text:'Text',Column:'Column',LazyColumn:'Column',Row:'Row',LazyRow:'Row',Box:'Box',Surface:'Box',Scaffold:'Box',
 Card:'Card',ElevatedCard:'Card',OutlinedCard:'Card',Button:'Button',FilledTonalButton:'Button',ElevatedButton:'Button',OutlinedButton:'Button',TextButton:'Button',
 IconButton:'Button',FloatingActionButton:'Button',ExtendedFloatingActionButton:'Button',Spacer:'Spacer',TextField:'TextField',OutlinedTextField:'TextField',
 Switch:'Switch',Icon:'Image',Image:'Image'};
const CONTAINERS=new Set(['Column','Row','Box','Card']);
const M3='androidx.compose.material3.MaterialTheme.colorScheme.';
// Material 3 defaults when the call does not set colors explicitly: [background, content].
const DEFAULTS={__proto__:null,Surface:['surface'],Scaffold:['background'],Card:['surfaceContainerHighest'],ElevatedCard:['surfaceContainerLow'],OutlinedCard:['surface'],
 Button:['primary','onPrimary'],FilledTonalButton:['secondaryContainer','onSecondaryContainer'],ElevatedButton:['surfaceContainerLow','primary'],
 OutlinedButton:[null,'primary'],TextButton:[null,'primary'],FloatingActionButton:['primaryContainer','onPrimaryContainer'],ExtendedFloatingActionButton:['primaryContainer','onPrimaryContainer']};
const MODIFIERS=new Set(['private','internal','public','protected','inline','override','open','suspend']);

function matching(t){
 const map=new Map(),back=new Map(),stack=[];
 for(let i=0;i<t.length;i++){if('({['.includes(t[i].v)&&!t[i].string)stack.push(i);else if(')}]'.includes(t[i].v)&&!t[i].string){const s=stack.pop();if(s!==undefined){map.set(s,i);back.set(i,s);}}}
 return {map,back};
}
/** Top-level-ish functions of a file with their annotations and body token range. */
export function kotlinFunctions(code){
 const t=kotlinTokens(code),{map,back}=matching(t),result=[];
 for(let i=0;i<t.length;i++){
  if(t[i].v!=='fun'||!/^[A-Za-z_]\w*$/.test(t[i+1]?.v||'')||t[i+2]?.v!=='(')continue;
  const annotations=[];let j=i-1;
  while(j>=0){
   if(MODIFIERS.has(t[j].v)){j--;continue;}
   let k=j;if(t[k].v===')'&&back.has(k))k=back.get(k)-1;
   let name=t[k]?.v;while(t[k-1]?.v==='.'&&/^\w+$/.test(t[k-2]?.v||''))k-=2;
   if(t[k-1]?.v==='@'&&/^\w+$/.test(name||'')){annotations.push(name);j=k-2;continue;}
   break;
  }
  const close=map.get(i+2);let body=close+1,end;
  while(body<t.length&&!['{','='].includes(t[body].v)&&t[body].v!=='fun')body++;
  if(t[body]?.v==='{')end=map.get(body);
  else if(t[body]?.v==='='){end=body;while(end+1<t.length&&t[end+1].v!=='fun'&&t[end+1].v!=='@')end=end+1;}
  else continue;
  result.push({name:t[i+1].v,annotations,composable:annotations.includes('Composable'),preview:annotations.some(a=>/Preview/.test(a)),blockBody:t[body].v==='{',
   calls:t.slice(body,end+1).flatMap((v,k,a)=>/^[A-Za-z_]\w*$/.test(v.v)&&['(','{'].includes(a[k+1]?.v)&&a[k-1]?.v!=='.'&&a[k-1]?.v!=='fun'?[v.v]:[])});
 }
 return result;
}
async function kotlinFiles(root,dir){
 const out=[];
 for(const entry of await readdir(path.join(root,dir),{withFileTypes:true}).catch(()=>[])){
  const relative=path.join(dir,entry.name);
  if(entry.isDirectory()&&!['build','.gradle','test','androidTest'].includes(entry.name))out.push(...await kotlinFiles(root,relative));
  else if(entry.isFile()&&entry.name.endsWith('.kt'))out.push(relative);
 }
 return out;
}
const argument=(call,name)=>call.args.find(a=>a.name===name)?.value;
function colors(call,source,calls){
 const [bg,fg]=DEFAULTS[call.call]||[];const m3=source.includes('androidx.compose.material3');
 const explicit=argument(call,'containerColor')||argument(call,'colors')?.match(/containerColor\s*=\s*([^,()]+(?:\([^()]*\))?)/)?.[1]
  ||(call.call==='Surface'?argument(call,'color'):null)||argument(call,'modifier')?.match(/\.background\(\s*([^,()]+(?:\([^()]*\))?)/)?.[1];
 const content=argument(call,'contentColor')||argument(call,'colors')?.match(/contentColor\s*=\s*([^,()]+(?:\([^()]*\))?)/)?.[1];
 // A button label with its own color wins over the button's content color.
 const labels=call.type==='Button'?calls.filter(c=>c.call==='Text'&&call.start<c.start&&c.end<=call.end):[];
 const label=labels.length===1?argument(labels[0],'color'):null;
 // Outlined fields and cards draw a 1dp outline by default.
 const outline=/^Outlined(TextField|Card|Button)$/.test(call.call)&&m3?{border:M3+'outline',borderWidth:'1f'}:{};
 return {...outline,...(explicit?{background:explicit.trim()}:bg&&m3?{background:M3+bg}:{}),...(label?{foreground:label.trim()}:content?{foreground:content.trim()}:fg&&m3?{foreground:M3+fg}:{})};
}

/** Builds a live/preview adapter from source: screens are the project composables called by @Preview functions. */
export async function generateAdapter(root,{module=':app'}={}){
 const moduleDir=module.slice(1).split(':').join('/');
 const files=[...await kotlinFiles(root,moduleDir+'/src/main'),...await kotlinFiles(root,moduleDir+'/src/debug')];
 const sources={},owners=new Map();
 for(const file of files){
  const code=await readFile(path.join(root,file),'utf8');let functions;try{functions=kotlinFunctions(code);}catch{continue;}
  sources[file]={code,functions};
  for(const fn of functions)if(fn.composable)owners.set(fn.name,owners.has(fn.name)?null:{file,fn});
 }
 const skipped=[],screens=new Set();
 for(const {functions} of Object.values(sources))for(const fn of functions.filter(f=>f.preview))
  for(const name of fn.calls)if(owners.get(name)&&!owners.get(name).fn.preview&&!/Theme$/.test(name))screens.add(name);
 const plans=new Map(),queue=[...screens],underLeaf=new Set();
 while(queue.length){
  const name=queue.shift();if(plans.has(name))continue;const owner=owners.get(name);if(!owner){continue;}
  let calls;try{calls=sceneCalls(sources[owner.file].code,name);}catch(error){if(!/блочное тело/.test(error.message))skipped.push({function:name,reason:error.message});plans.set(name,null);continue;}
  const candidates=calls.filter(c=>TYPES[c.call]),inside=(a,b)=>b.start<=a.start&&a.end<=b.end&&a!==b;
  // The editor's Button needs a label; an icon-only button becomes a container around its icon.
  for(const c of candidates)c.type=TYPES[c.call]==='Button'&&!calls.some(o=>o.call==='Text'&&inside(o,c))?'Box':TYPES[c.call];
  const leaves=candidates.filter(c=>!CONTAINERS.has(c.type));
  let bound=candidates.filter(c=>!leaves.some(l=>inside(c,l)));
  let root=null;
  if(screens.has(name)){root=bound.filter(c=>!bound.some(o=>inside(c,o)))[0];if(!root){skipped.push({function:name,reason:'Нет корневого Compose-вызова'});plans.set(name,null);continue;}bound=bound.filter(c=>c===root||inside(c,root));}
  plans.set(name,{owner,calls,bound,root});
  for(const c of calls){if(!owners.get(c.call)||c.call===name)continue;if(leaves.some(l=>inside(c,l)))underLeaf.add(c.call);else queue.push(c.call);}
 }
 // A function drawn inside a leaf (Button content and similar) cannot have its own bound children.
 const blocked=[...underLeaf];for(let i=0;i<blocked.length;i++){const plan=plans.get(blocked[i]);for(const c of plan?.calls||[])if(owners.get(c.call)&&!blocked.includes(c.call))blocked.push(c.call);}
 for(const name of blocked)if(owners.get(name)?.fn.blockBody)skipped.push({function:name,reason:'Рисуется внутри кнопки или другого листа: связывается вся кнопка'});
 const adapter={format:'compose-visual-bridge-live-adapter-v1',name:path.basename(root),generated:true,screens:[...screens],calls:[]};
 for(const [name,plan] of plans){
  if(!plan||blocked.includes(name))continue;
  const {owner:{file},calls,bound,root}=plan,code=sources[file].code;
  for(const call of bound){
   const occurrence=calls.filter(c=>c.call===call.call).indexOf(call),type=call.type;
   adapter.calls.push({file,fileHash:hash(code),symbol:name,call:call.call,occurrence,key:`${name}-${call.call}-${occurrence}`,type,
    props:type==='Text'?{fontSize:14,fontFamily:'Roboto'}:{},...(call===root?{root:true,name}:{instance:'dev.composevisualbridge.capture.bridgeSceneInstance'}),...colors(call,code,calls)});
  }
 }
 return {adapter,skipped};
}
