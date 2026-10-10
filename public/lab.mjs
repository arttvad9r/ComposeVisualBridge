import { createDrag } from './drag-dnd.mjs';
import { createPragmatic } from './drag-pragmatic.mjs';
import { History, move, indexTree } from './model.mjs';
const fixture = {schemaVersion:1,name:'Проверка drag',viewport:{width:390,height:844},root:{id:'root',type:'Column',props:{},children:[{id:'a',type:'Text',props:{text:'А'}},{id:'b',type:'Text',props:{text:'Б'}},{id:'box',type:'Card',props:{},children:[{id:'c',type:'Text',props:{text:'В'}}]}]}};
const $ = id => document.getElementById(id);
let history = new History(fixture), adapter, intent, ghost;
function clean() { ghost?.remove(); document.querySelectorAll('[data-drop]').forEach(n => delete n.dataset.drop); }
function render() {
  adapter?.clear($('tree')); $('tree').replaceChildren();
  function visit(node, depth) { const row=document.createElement('button');row.className='tree-node';row.dataset.nodeId=node.id;row.textContent=`⠿ ${node.id} · ${node.type}`;row.style.paddingLeft=`${10+depth*24}px`;$('tree').append(row);if(node.id!=='root')adapter.wire(row,node.id);for(const child of node.children||[])visit(child,depth+1); }
  visit(history.current.root,0);$('labState').textContent=JSON.stringify(history.current.root,null,2);$('labUndo').disabled=!history.past.length;
}
function setup() {
  adapter?.destroy();clean();
  adapter=($('engine').value==='dnd'?createDrag:createPragmatic)({
    start(id) {intent=null;ghost=document.createElement('div');ghost.className='drag-ghost';ghost.textContent=id;document.body.append(ghost);},
    update(id,event) {
      document.querySelectorAll('[data-drop]').forEach(n=>delete n.dataset.drop);
      const row=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-node-id]'), map=indexTree(history.current.root),source=map.get(id),target=map.get(row?.dataset.nodeId);intent=null;
      if(row && target && !indexTree(source.node).has(target.node.id)) {
        const bounds=row.getBoundingClientRect(),fraction=(event.clientY-bounds.top)/bounds.height,inside=target.node.children && (fraction>.3&&fraction<.7||!target.parent);
        let parentId=inside?target.node.id:target.parent,position=inside?target.node.children.length:target.index+(fraction>=.5?1:0);
        if(source.parent===parentId&&source.index<position)position--;
        if(parentId){intent={parentId,position};row.dataset.drop=inside?'inside':fraction>=.5?'after':'before';}
      }
      if(ghost){ghost.style.left=`${event.clientX+12}px`;ghost.style.top=`${event.clientY+12}px`;ghost.textContent=intent?`${intent.parentId}: ${intent.position}`:'Недопустимое место';}
    },
    finish(id,event,canceled) {const target=intent;clean();intent=null;if(!canceled&&target)history.commit(move(history.current,id,target.parentId,target.position));$('notice').textContent=canceled?'Отменено':'Завершено';render();},
  });render();
}
$('engine').onchange=setup;$('labUndo').onclick=()=>{history.undo();render();};$('labReset').onclick=()=>{history=new History(fixture);setup();};setup();
