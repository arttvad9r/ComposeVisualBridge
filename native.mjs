import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readReference } from './baseline.mjs';
import {indexWorkspace,mapFrame,verifyMapping} from './source-map.mjs';

const fail = (message, status=400) => { throw Object.assign(Error(message), {status}); };
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, name, limit=500) => {
  if(typeof value!=='string'||!value.trim()||value.length>limit)fail(`Некорректное поле ${name}`);
  return value.trim();
};
export function sourceMetadata(input) {
  const sourceRevision=text(input.sourceRevision,'sourceRevision',128);
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceRevision))fail('Нужен фактический Git SHA или SHA-256 исходников');
  const screenState=text(input.screenState,'состояние экрана');
  const origin=input.origin||{x:0,y:0};
  if(![origin.x,origin.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=8192))fail('Некорректное начало координат');
  return {sourceRevision,screenState,origin:{x:origin.x,y:origin.y}};
}
export function buddyEndpoint(value) {
  let url;try{url=new URL(value);}catch{fail('Нужен loopback WebSocket URL Buddy');}
  if(url.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||url.username||url.password||url.hash)fail('Buddy доступен только через ws://127.0.0.1:PORT или localhost');
  return url.href;
}
export function normalizeBuddyFrame(input, metadata) {
  const meta=sourceMetadata(metadata);
  if(input?.type!=='frame')fail('Ожидался RenderFrame Compose Buddy');
  const preview=text(input.preview,'Preview',1000);
  const reference=readReference({image:input.image,mime:'image/png',label:meta.screenState});
  const png=Buffer.from(reference.image,'base64');
  if(png.length<33||png.toString('ascii',12,16)!=='IHDR')fail('Повреждённый PNG');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(!width||!height||width>8192||height>8192||width*height>24_000_000)fail('Недопустимые размеры кадра');
  const densityDpi=input.densityDpi;
  if(!Number.isFinite(densityDpi)||densityDpi<80||densityDpi>1280)fail('Кадр должен содержать densityDpi');
  const nodes=[],ids=new Set();
  const small=value=>typeof value==='string'?value.slice(0,2000):null;
  function visit(node,parentId=null,depth=0) {
    if(!node||depth>64||nodes.length>=5000)fail('Недопустимое дерево Buddy');
    const id=String(node.id);
    if(!['string','number'].includes(typeof node.id)||!id||id.length>100||ids.has(id))fail('ID узлов должны быть уникальными');
    ids.add(id);
    const b=node.bounds;
    if(!b||![b.left,b.top,b.right,b.bottom].every(n=>Number.isFinite(n)&&Math.abs(n)<=32768)||b.right<b.left||b.bottom<b.top)fail('Недопустимые bounds узла');
    if(!Array.isArray(node.children))fail('У узла нет children');
    const properties={};
    for(const [key,value] of Object.entries(node.mergedSemantics||{})) {
      if(Object.keys(properties).length>=100)break;
      if(key.length<=100&&['string','number','boolean'].includes(typeof value))properties[key]=String(value).slice(0,2000);
    }
    if(typeof node.colors?.background==='string')properties.backgroundColor=node.colors.background;
    if(typeof node.colors?.foreground==='string')properties.foregroundColor=node.colors.foreground;
    nodes.push({id,parentId,depth,name:small(node.name)||'Элемент',role:small(node.role),bounds:{...b},text:properties.text||node.contentDescription||null,properties,source:{file:small(node.sourceFile),line:Number.isInteger(node.sourceLine)&&node.sourceLine>0?node.sourceLine:null,confidence:small(node.sourceFile)?'hint':'unknown'}});
    node.children.forEach(child=>visit(child,id,depth+1));
  }
  visit(input.semantics);
  const frame={preview,...meta,width,height,densityDpi,nodes,image:reference.image,capturedAt:new Date().toISOString(),provider:'compose-buddy'};
  frame.digest=hash(JSON.stringify({preview,meta,width,height,densityDpi,nodes,image:frame.image}));
  return frame;
}
export function validateNativeIntents(intents,frame) {
  if(!frame)fail('Сначала получите кадр');
  if(!Array.isArray(intents)||intents.length>500)fail('Слишком много правок');
  const allowed=new Set(['text','fontSize','lineHeight','fontWeight','fontFamily','letterSpacing','borderWidth','color','background','borderColor','width','height','offsetX','offsetY','note','padding','paddingHorizontal','paddingVertical','gap','radius','opacity','weight','alignX','alignY','align','justify','textAlign','layoutMode','moveTo','addChild','remove']);
  const enums={alignX:['start','center','end'],alignY:['start','center','end'],align:['start','center','end','stretch'],justify:['start','center','end','space-between'],textAlign:['start','center','end','justify'],layoutMode:['free','auto']};
  const seen=new Set(),parents=new Map(frame.nodes.map(n=>[n.id,n.parentId]));
  const result=intents.map(item=>{
    const node=frame.nodes.find(n=>n.id===item.nodeId);
    if(!node||!allowed.has(item.property))fail('Неизвестный элемент или свойство');
    const key=node.id+'\0'+item.property;if(seen.has(key))fail('Повторная правка одного свойства');seen.add(key);
    let value=item.value;
    if(item.property==='text'){if(typeof value!=='string'||value.length>4000)fail('Некорректный текст');}
    else if(item.property==='fontFamily')value=text(value,'семейство шрифта',500);
    else if(item.property==='note')value=text(value,'значение',4000);
    else if(enums[item.property]){if(!enums[item.property].includes(value))fail('Неизвестный вариант свойства');}
    else if(['width','height'].includes(item.property)&&['auto','fill'].includes(value)){}
    else if(item.property==='remove'){if(value!==true||node.parentId===null)fail('Нельзя удалить корень экрана');}
    else if(item.property==='addChild'){
      const items=Array.isArray(value)?value:[value];if(!items.length||items.length>20)fail('Добавьте от 1 до 20 элементов');
      value=items.map(child=>{
        if(!child||!['Text','Button','Card','Column','Row','Box','Image','Spacer'].includes(child.type)||typeof child.text!=='string'||child.text.length>4000)fail('Некорректный новый элемент');
        const properties=child.properties||{};if(!properties||typeof properties!=='object'||Array.isArray(properties)||Object.keys(properties).length>30)fail('Некорректные свойства нового элемента');
        const entries=Object.entries(properties);if(entries.some(([key])=>!allowed.has(key)||['text','addChild','moveTo','remove','note'].includes(key)))fail('Неизвестное свойство нового элемента');
        validateNativeIntents(entries.map(([property,value])=>({nodeId:'new',property,value})),{nodes:[{id:'new',parentId:null,source:{confidence:'unknown'},name:child.type,text:child.text,bounds:node.bounds}]});
        return {type:child.type,text:child.text,properties};
      });
    }
    else if(item.property==='moveTo'){
      if(!value||!frame.nodes.some(n=>n.id===value.parentId)||!Number.isInteger(value.index)||value.index<0||value.index>5000||node.parentId===null)fail('Некорректный родитель или порядок');
      value={parentId:value.parentId,index:value.index};parents.set(node.id,value.parentId);
    }
    else if(['color','background','borderColor'].includes(item.property)) {if(typeof value!=='string'||!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))fail('Нужен цвет #RRGGBB или #RRGGBBAA');}
    else if(item.property==='opacity'){if(!Number.isFinite(value)||value<0||value>1)fail('Прозрачность: от 0 до 1');}
    else if(item.property==='fontWeight'){if(!Number.isInteger(value)||value<100||value>900)fail('Толщина шрифта: от 100 до 900');}
    else if(['padding','paddingHorizontal','paddingVertical','gap','radius','borderWidth','weight'].includes(item.property)){if(!Number.isFinite(value)||value<0||value>4000)fail('Некорректный отступ или размер');}
    else if(!Number.isFinite(value)||Math.abs(value)>4000||(['fontSize','width','height'].includes(item.property)&&value<=0))fail('Недопустимый размер или смещение');
    return {nodeId:node.id,property:item.property,value,source:node.source,context:{name:node.name,text:node.text,bounds:node.bounds,parentId:node.parentId},sourceRequiresResolution:true};
  });
  for(const id of parents.keys()){const visited=new Set();let current=id;while(current!==null){if(visited.has(current))fail('Перенос создаёт цикл вложенности');visited.add(current);current=parents.get(current)??null;}}
  return result;
}

export async function createNativeBridge({data,atomic,serial}) {
  const filename=path.join(data,'native-session.json');
  let state;
  try {state=JSON.parse(await readFile(filename,'utf8'));if(!Number.isInteger(state.revision))fail('Повреждённая native-сессия');}
  catch(error){if(error.code!=='ENOENT')throw error;state={revision:0,frame:null,draft:[],applied:null,confirmedDigest:null};}
  state.history ||= {past:[],future:[]};
  let comparisonSnapshot=null;
  let socket=null,generation=0,previews=[],latestFrame=null,sceneDescriptions=new Map();
  let sourceWorkspace=state.frame?.sourceMapping?.workspace||null;
  let connection={status:'disconnected',error:null};
  const strip=frame=>frame?(({image,...rest})=>rest)(frame):null;
  const view=()=>({...state,history:{undo:state.history.past.length,redo:state.history.future.length},frame:strip(state.frame),comparisonFrame:strip(state.comparisonFrame),connection,previews,pendingFrame:!!latestFrame});
  const guard=input=>{if(input.revision!==state.revision)fail('Native-сессия изменена. Загрузите актуальную версию.',409);};
  const save=async next=>{await atomic(filename,next);state=next;};
  async function accept(frame) {
    if(sourceWorkspace){frame=mapFrame(frame,await indexWorkspace(sourceWorkspace,frame.sourceRevision));}
    if(state.frame?.digest===frame.digest)return;
    if(state.draft.length){latestFrame=frame;return;}
    let comparisonFrame=null;
    if(state.applied){if(comparisonSnapshot?.directory!==state.applied.directory){const snapshot=JSON.parse(await readFile(path.join(data,state.applied.directory,'changes.json'),'utf8'));comparisonSnapshot={directory:state.applied.directory,frame:snapshot.frame};}
      const original=comparisonSnapshot.frame;if(original.preview===frame.preview&&original.screenState===frame.screenState&&original.sourceRevision!==frame.sourceRevision)comparisonFrame=original;
    }
    await save({...state,revision:state.revision+1,frame,comparisonFrame,history:{past:[],future:[]},confirmedDigest:null});latestFrame=null;
  }
  function stop() {generation++;socket?.close();socket=null;connection={status:'disconnected',error:null};previews=[];}
  function send(command) {if(socket?.readyState!==1)fail('Buddy не подключён',409);socket.send(JSON.stringify(command));}
  async function connect(input) {
    if(typeof WebSocket==='undefined')fail('Для native-подключения нужен Node.js 22+',422);
    if(state.draft.length)fail('Сначала сохраните снимок и завершите текущие правки',409);
    const endpoint=buddyEndpoint(input.endpoint),meta=sourceMetadata(input);
    if(input.workspace)await indexWorkspace(input.workspace,meta.sourceRevision);
    sourceWorkspace=input.workspace||null;
    stop();latestFrame=null;sceneDescriptions=new Map();const current=generation;
    connection={status:'connecting',endpoint,error:null};
    const deadline=Date.now()+10000;
    const timeout=setTimeout(()=>{if(current===generation&&socket?.readyState!==1){socket?.close();connection={status:'error',endpoint,error:'Buddy не ответил за 10 секунд'};}},10000);timeout.unref();
    function attempt() {
    if(current!==generation)return;
    const ws=new WebSocket(endpoint);socket=ws;let opened=false,retryTimer=null;
    const retryOrFinish=()=>{
      if(current!==generation)return;
      socket=null;
      if(Date.now()<deadline&&!state.draft.length){
        connection={status:'connecting',endpoint,error:null};
        if(retryTimer===null){retryTimer=setTimeout(()=>{retryTimer=null;attempt();},500);retryTimer.unref();}
        return;
      }
      clearTimeout(timeout);
      if(!opened)connection={status:'error',endpoint,error:'Не удалось подключиться к Buddy за 10 секунд'};
      else if(connection.status!=='error')connection={status:'disconnected',endpoint,error:null};
    };
    ws.addEventListener('open',()=>{if(current!==generation||Date.now()>deadline){ws.close();return;}opened=true;if(retryTimer!==null){clearTimeout(retryTimer);retryTimer=null;}clearTimeout(timeout);connection={status:'connected',endpoint,error:null};ws.send(JSON.stringify({cmd:'requestPreviewList'}));ws.send(JSON.stringify({cmd:'rerender'}));});
    ws.addEventListener('message',event=>{
      serial(async()=>{
        if(current!==generation)return;
        try {
          if(typeof event.data!=='string'||Buffer.byteLength(event.data)>12_000_000)fail('Недопустимое сообщение Buddy');
          const value=JSON.parse(event.data);
          if(value.type==='previewList'){if(!Array.isArray(value.previews)||value.previews.length>1000)fail('Недопустимый каталог Preview');previews=value.previews.map(p=>text(p,'Preview',1000));}
          else if(value.type==='frame') {
            if(!sceneDescriptions.size)sceneDescriptions.set(value.preview,meta.screenState);
            await accept(normalizeBuddyFrame(value,{...meta,screenState:sceneDescriptions.get(value.preview)||`Preview ${value.preview}`}));
          }
          else fail('Неизвестный тип сообщения Buddy');
          connection={status:'connected',endpoint,error:null};
        }catch(error){connection={status:'error',endpoint,error:error.message};}
      }).catch(error=>{connection={status:'error',endpoint,error:error.message};});
    });
    ws.addEventListener('error',()=>{
      if(current!==generation)return;
      if(!opened){retryOrFinish();return;}
      if(Date.now()>=deadline)connection={status:'error',endpoint,error:'Соединение с Buddy прервано'};
    });
    ws.addEventListener('close',retryOrFinish);
    }
    attempt();
    return view();
  }
  async function handle(req,res,url,reply,body) {
    if(!url.pathname.startsWith('/api/native'))return false;
    if(req.method==='GET') {
      if(url.pathname==='/api/native')reply(200,view());
      else if(url.pathname==='/api/native/export') {
        if(!state.frame)fail('Кадр ещё не получен',404);
        const f=state.frame,map=new Map(f.nodes.map(n=>[n.id,{id:n.id,name:n.name,role:n.role,bounds:n.bounds,sourceFile:n.source.file,sourceLine:n.source.line,mergedSemantics:n.properties,contentDescription:n.text,children:[]}]));
        for(const n of f.nodes)if(n.parentId!==null)map.get(n.parentId).children.push(map.get(n.id));
        reply(200,{frame:{type:'frame',preview:f.preview,image:f.image,densityDpi:f.densityDpi,semantics:map.get(f.nodes[0].id)},sourceRevision:f.sourceRevision,screenState:f.screenState,origin:f.origin});
      }else if(url.pathname==='/api/native/image') {
        const imageFrame=url.searchParams.get('version')==='before'?state.comparisonFrame:state.frame;
        if(!imageFrame)fail('Кадр ещё не получен',404);
        if(url.searchParams.get('digest')&&url.searchParams.get('digest')!==imageFrame.digest)fail('Кадр обновлён',409);
        res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(Buffer.from(imageFrame.image,'base64'));
      }else if(url.pathname==='/api/native/handoff') {
        if(!state.applied)fail('Native-снимок ещё не создан',404);
        reply(200,JSON.parse(await readFile(path.join(data,state.applied.directory,'changes.json'),'utf8')));
      }else reply(404,{error:'Не найдено'});
      return true;
    }
    if(req.method!=='POST'){reply(405,{error:'Метод не поддерживается'});return true;}
    const input=await body(req,url.pathname==='/api/native/frame'?12_000_000:2_000_000);
    await serial(async()=>{
      guard(input);
      switch(url.pathname) {
        case '/api/native/connect':reply(200,await connect(input));break;
        case '/api/native/disconnect':stop();reply(200,view());break;
        case '/api/native/frame':
          if(state.draft.length)fail('Новый кадр не может заменить исходник незавершённых правок',409);
          sourceWorkspace=input.workspace||null;
          await accept(normalizeBuddyFrame(input.frame,input));reply(200,view());break;
        case '/api/native/source': {
          if(!state.frame)fail('Сначала получите кадр');
          if(state.draft.length)fail('Нельзя менять связь с исходниками при незавершённых правках',409);
          if(input.digest!==state.frame.digest)fail('Исходный кадр изменился',409);
          const index=await indexWorkspace(text(input.workspace,'рабочая копия',4000),state.frame.sourceRevision);
          const frame=mapFrame(state.frame,index);
          await save({...state,revision:state.revision+1,frame,history:{past:[],future:[]},confirmedDigest:null});sourceWorkspace=index.root;reply(200,view());break;
        }
        case '/api/native/confirm':
          if(!state.frame||input.digest!==state.frame.digest||input.acknowledged!==true)fail('Подтвердите актуальную сцену',409);
          await save({...state,revision:state.revision+1,confirmedDigest:state.frame.digest});reply(200,view());break;
        case '/api/native/draft': {
          if(input.digest!==state.frame?.digest)fail('Исходный кадр изменился',409);
          if(input.intents?.length)await verifyMapping(state.frame);
          const draft=validateNativeIntents(input.intents,state.frame);
          const history=JSON.stringify(draft)===JSON.stringify(state.draft)?state.history:{past:[...state.history.past,state.draft.map(({nodeId,property,value})=>({nodeId,property,value}))].slice(-100),future:[]};
          await save({...state,revision:state.revision+1,draft,history});reply(200,view());break;
        }
        case '/api/native/history': {
          const undo=input.direction==='undo';if(!undo&&input.direction!=='redo')fail('Неизвестное действие истории');
          const from=undo?state.history.past:state.history.future;if(!from.length)fail('История пуста',409);
          const draft=validateNativeIntents(from.at(-1),state.frame);if(draft.length)await verifyMapping(state.frame);
          const history=undo?{past:from.slice(0,-1),future:[...state.history.future,state.draft.map(({nodeId,property,value})=>({nodeId,property,value}))]}:{past:[...state.history.past,state.draft.map(({nodeId,property,value})=>({nodeId,property,value}))],future:from.slice(0,-1)};
          await save({...state,revision:state.revision+1,draft,history});reply(200,view());break;
        }
        case '/api/native/refresh':
          if(state.draft.length)fail('Сначала завершите текущие правки',409);
          if(latestFrame)await accept(latestFrame);
          if(socket?.readyState===1)send({cmd:'rerender'});
          reply(200,view());break;
        case '/api/native/navigate':
          if(state.draft.length)fail('Нельзя менять сцену с незавершёнными правками',409);
          if(!previews.includes(input.preview))fail('Preview не найден');
          sceneDescriptions.set(input.preview,text(input.screenState||sceneDescriptions.get(input.preview)||input.preview,'описание сцены'));
          send({cmd:'navigate',preview:input.preview});reply(200,view());break;
        case '/api/native/apply': {
          if(!['test','review'].includes(input.mode))fail('Нужен режим test или review');
          if(!state.frame||!state.draft.length)fail('Нет правок для передачи');
          await verifyMapping(state.frame);
          if(input.mode==='review'&&state.confirmedDigest!==state.frame.digest)fail('Сначала подтвердите настоящую сцену',422);
          const directory=`native-${Date.now()}-${randomUUID().slice(0,8)}`,folder=path.join(data,directory);
          const applied={directory,mode:input.mode,createdAt:new Date().toISOString(),frameDigest:state.frame.digest};
          const handoff={format:'compose-visual-bridge-native-v1',applied,frame:state.frame,intent:{changes:state.draft},verification:{confirmedBy:state.confirmedDigest===state.frame.digest?'user':null},requiresUserAuthorizationForCodeTransfer:true};
          try{await mkdir(folder);await atomic(path.join(folder,'changes.json'),handoff);await save({...state,revision:state.revision+1,applied});}
          catch(error){await rm(folder,{recursive:true,force:true});throw error;}
          reply(201,view());break;
        }
        default:reply(404,{error:'Не найдено'});
      }
    });
    return true;
  }
  return {handle,stop};
}
