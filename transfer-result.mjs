import {clone,validate,indexTree,History} from './public/model.mjs';
import {readReference,fingerprint} from './baseline.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const text=(value,label,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+': нужен непустой текст до '+max+' символов');return value.trim();};
export function readTransferResult(input,snapshot){
 if(!['succeeded','failed'].includes(input.status))throw Error('status: succeeded или failed');
 if(input.beforeSourceRevision!==snapshot.baseline.sourceRevision)throw Error('Ревизия исходников снимка устарела');
 const result={snapshot:input.snapshot,status:input.status,message:text(input.message,'Результат'),beforeSourceRevision:text(input.beforeSourceRevision,'beforeSourceRevision',500)};
 if(input.status==='failed')return result;
 if(!input.document||typeof input.document!=='object')throw Error('Нужен новый baseline document');
 const document=validate(clone(input.document));
 result.sourceRevision=text(input.sourceRevision,'sourceRevision',500);
 if(document.sourceRevision!==result.sourceRevision||result.sourceRevision===input.beforeSourceRevision||result.sourceRevision==='demo-only')throw Error('Нужен новый baseline с ревизией изменённых исходников');
 if(document.root.id!==snapshot.baseline.root.id)throw Error('Результат относится к другому экрану');
 if(snapshot.baseline.compose?.format!==document.compose?.format)throw Error('Формат результата не соответствует снимку');
 result.checks={build:text(input.checks?.build,'Проверка сборки'),visual:text(input.checks?.visual,'Проверка настоящего экрана')};
 result.document=document;result.reference=readReference(input.reference||{});
 return result;
}
// Conservative replay of edits made after Apply. A changed structure, identity,
// or competing value preserves the complete old draft in the archived session.
export function rebaseLateDraft(proposed,current,baseline){
 if(same(proposed,current))return {current:clone(baseline),conflicts:[]};
 const shape=d=>[...indexTree(d.root)].map(([id,e])=>[id,e.parent,e.index,e.node.type]);
 if(!same(shape(proposed),shape(current)))return {current:clone(baseline),conflicts:['Поздние структурные правки требуют отдельного переноса']};
 const next=clone(baseline),old=indexTree(proposed.root),late=indexTree(current.root),fresh=indexTree(next.root),conflicts=[];
 function replay(a,b,target,key,label){if(same(a?.[key],b?.[key]))return;if(!same(target?.[key],a?.[key])&&!same(target?.[key],b?.[key])){conflicts.push(label);return;}if(b?.[key]===undefined)delete target[key];else target[key]=clone(b[key]);}
 for(const [id,e] of old){const edited=late.get(id).node;if(!same({...e.node,props:null,children:null},{...edited,props:null,children:null}))conflicts.push('Поздняя связь с исходниками '+id);const keys=new Set([...Object.keys(e.node.props),...Object.keys(edited.props)]);if([...keys].every(k=>same(e.node.props[k],edited.props[k])))continue;
  const target=fresh.get(id)?.node,identity=d=>d.compose?.bindings?.[id]?.runtimeIdentity||d.compose?.bindings?.[id]?.key||d.root.id;
  if(!target||target.type!==e.node.type||(proposed.compose&&!proposed.compose.bindings?.[id]?.runtimeIdentity)||identity(proposed)!==identity(next)){conflicts.push('Элемент '+id+' изменился или отсутствует');continue;}
  for(const key of keys)replay(e.node.props,edited.props,target.props,key,id+' / '+key);
 }
 for(const key of new Set([...Object.keys(proposed.viewport),...Object.keys(current.viewport)]))replay(proposed.viewport,current.viewport,next.viewport,key,'Экран / '+key);
 replay(proposed,current,next,'name','Название экрана');
 if(!same(proposed.layout,current.layout)){
  if(proposed.layout?.mode!==current.layout?.mode||!proposed.layout?.frames||!current.layout?.frames||!next.layout?.frames||!same(Object.keys(proposed.layout.frames).sort(),Object.keys(current.layout.frames).sort()))conflicts.push('Поздняя компоновка требует отдельного переноса');
  else for(const [id,frame] of Object.entries(current.layout.frames)){
   const a=proposed.layout.frames[id],target=next.layout.frames[id];if(same(a,frame))continue;if(!a||!target){conflicts.push('Геометрия '+id);continue;}
   for(const key of Object.keys(frame))replay(a,frame,target,key,'Геометрия '+id+' / '+key);
  }
 }
 if(!same({...proposed,root:null,viewport:null,layout:null,name:null},{...current,root:null,viewport:null,layout:null,name:null}))conflicts.push('Позднее изменение состояния или связи с исходниками');
 if(conflicts.length)return {current:clone(baseline),conflicts};
 try{validate(next);}catch{ return {current:clone(baseline),conflicts:['Поздний черновик несовместим с новым baseline']}; }
 return {current:next,conflicts:[]};
}
export function resultHistory(baseline,current){const history=new History(baseline);history.commit(current);return history.snapshot();}
export function publicResult(result){const {document,reference,...summary}=result;return {...summary,reference:reference?{mime:reference.mime,label:reference.label,digest:reference.digest,url:`/api/results/${result.id}/reference`}:null,documentFingerprint:document?fingerprint(document):null};}
