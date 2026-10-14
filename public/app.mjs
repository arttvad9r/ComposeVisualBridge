import {setupProject} from './project-ui.mjs';
import {setupResult} from './result-ui.mjs';
import {composeCapability} from './compose-capabilities.mjs';
import {MODIFIER_MODEL,modifierMetrics} from './modifier-layout.mjs';
import {scaledSp,robotoFamily} from './typography.mjs';
import {setupZoom, syncZoom, getZoom} from './zoom.mjs';
import { setupBaseline, updateBaselineSession, handoffMode } from './baseline-ui.mjs';
import { sectionHelp, setupHelp, helpButton } from './help.mjs';
import { shiftedOffsets, resizeRect, anchoredChildFrames } from './geometry.mjs';
import { createDrag } from './drag-dnd.mjs';
import { TYPES, CONTAINERS, FONT_FAMILIES, clone, validate, indexTree, diff, move, History } from './model.mjs';
const $ = id => document.getElementById(id);
let baseline, history, revision = 0, selected = 'screen', scale = .65, dragging = null, draftTimer, saveQueue = Promise.resolve(), conflict = false;
let suppressClick = false, applied = null, appliedDocument = null, appliedReport = '';
async function loadApplied(state) {
  updateBaselineSession(state); updateResult(state);
  $("restoreSession").hidden=!state.previousSession;
  applied = state.applied; appliedDocument = null; appliedReport = '';
  if (applied) { try { const value = await api('/api/handoff'); appliedDocument = value.document; appliedReport = value.report; } catch(error) { appliedReport = `Перенос запрещён. ${error.message}`; } }
}
function renderHandoff() {
  const same = appliedDocument && JSON.stringify(appliedDocument) === JSON.stringify(doc());
  $('handoffStatus').textContent = applied ? `Последняя передача · ${same ? 'совпадает с черновиком' : 'черновик отличается от снимка'}` : 'Снимок ещё не создан';
  $('readReport').disabled = !applied;
}
const updateResult=setupResult({api,notice,accept:async id=>{
  document.body.inert=true;clearTimeout(draftTimer);
  try{
    await queueSave();const state=await api('/api/result/accept','POST',{revision,id});
    revision=state.revision;baseline=clone(state.baseline);history=History.restore(state.current,state.history);conflict=false;selected=doc().root.id;
    await loadApplied(state);localSave();render();setSaveStatus('Черновик сохранён ✓');
    notice(state.result.lateDraft.status==='archived'?'Результат принят. Поздний черновик сохранён в предыдущей сессии.':'Результат принят. Сверьте новый исходник с настоящим экраном.');
  }finally{document.body.inert=false;}
}});
const loadProject=setupProject({api,notice,revision:()=>revision,flush:async()=>{clearTimeout(draftTimer);await queueSave();},addComponent:(component,sourceRevision)=>{const next=clone(doc()),parent=indexTree(next.root).get(selected)?.node;if(!parent||!CONTAINERS.includes(parent.type)){notice('Выберите контейнер для компонента',true);return;}const node=clone(component.node);for(const entry of indexTree(node).values())entry.node.id='palette-'+crypto.randomUUID().slice(0,8);parent.children||=[];parent.children.push(node);next.state={...next.state,paletteInsertions:[...(next.state?.paletteInsertions||[]),{id:node.id,component:component.id,sourceRevision}]};selected=node.id;changed(next);}});
const sectionState = new Map();
const CACHE = 'compose-visual-bridge-draft-v1';
const typeNames={Column:'Колонка',Row:'Строка',Box:'Контейнер',Card:'Карточка',Text:'Текст',Button:'Кнопка',Icon:'Иконка',Image:'Изображение',TextField:'Поле ввода',Switch:'Переключатель',Spacer:'Промежуток'};
const nodeName=node=>node?.props?.text?.trim() || typeNames[node?.type] || 'Элемент';
const icons = { Column: '▥', Row: '▤', Box: '□', Card: '▣', Text: 'T', Button: '▰', Icon: '◇', Image: '▧', TextField: '▭', Switch: '◉', Spacer: '↕' };
const doc = () => history.current;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
let storedSaveStatus = 'Загрузка…';
function setSaveStatus(message) {
  storedSaveStatus = message;
  if (!document.body.classList.contains('dragging') && !document.body.classList.contains('resizing')) $('saveStatus').textContent = message;
}
function restoreSaveStatus() { $('saveStatus').textContent = storedSaveStatus; }
async function api(url, method = 'GET', payload) {
  const response = await fetch(url, { method, ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 409) conflict = true; throw Error(value.error || `HTTP ${response.status}`); }
  return value;
}
function localSave() {
  try { localStorage.setItem(CACHE, JSON.stringify({ revision, baseline, document: doc(), history:history.snapshot() })); } catch { /* Server remains the durable storage. */ }
}
function queueSave(url = '/api/draft', documentValue = clone(doc()), historyValue=history.snapshot()) {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (conflict) throw Error('Обнаружен конфликт. Экспортируйте макет и загрузите версию с сервера.');
    setSaveStatus('Сохранение…');
    const value = await api(url, url === '/api/apply' ? 'POST' : 'PUT', { revision, document: documentValue, history:historyValue, ...(url === '/api/apply' ? { mode: handoffMode(documentValue) } : {}) });
    revision = value.revision; localSave();
    setSaveStatus(url === '/api/apply' ? 'Передано агенту ✓' : 'Черновик сохранён ✓');
    return value;
  });
  return saveQueue;
}
function captureFrames() {
  const frames={}, map=indexTree(doc().root), slot=$('after');
  for(const element of slot.querySelectorAll('[data-node-id]')) {
    const entry=map.get(element.dataset.nodeId), rect=element.getBoundingClientRect();
    const parent=element.parentElement, origin=parent.getBoundingClientRect(), parentStyle=getComputedStyle(parent);
    const round=value=>Math.round(value*1000)/1000;
    frames[entry.node.id]={parent:entry.parent,x:round((rect.left-origin.left)/scale-(parseFloat(parentStyle.borderLeftWidth)||0)+parent.scrollLeft-(entry.node.props.offsetX||0)),y:round((rect.top-origin.top)/scale-(parseFloat(parentStyle.borderTopWidth)||0)+parent.scrollTop-(entry.node.props.offsetY||0)),width:round(rect.width/scale),height:round(rect.height/scale)};
  }
  return frames;
}
function freeMode(value=doc()) {return value.layout?.mode!=='auto';}
// A structural edit keeps every element where it was. A new order inside a column or row swaps the slots of the
// reordered run and keeps the gaps between them; an element moved to another container keeps its size and is placed again.
function keptFrames(next) {
  const before=indexTree(doc().root), after=indexTree(next.root), frames=doc().layout?.frames||captureFrames();
  const kept=Object.fromEntries(Object.entries(frames).filter(([id,frame])=>after.get(id)?.parent===frame.parent).map(([id,frame])=>[id,{...frame}]));
  for(const [id,{node}] of after) {
    if(!before.has(id)||node.type==='Box')continue;
    const order=list=>(list||[]).map(n=>n.id).filter(child=>kept[child]&&before.get(child)?.parent===id);
    const old=order(before.get(id).node.children), now=order(node.children);
    let first=0,last=old.length-1;
    while(first<=last&&old[first]===now[first])first++;
    while(last>=first&&old[last]===now[last])last--;
    if(first>last)continue;
    const [position,size]=node.type==='Row'?['x','width']:['y','height'], run=old.slice(first,last+1);
    const gaps=run.slice(1).map((child,i)=>kept[child][position]-kept[run[i]][position]-kept[run[i]][size]);
    let at=kept[run[0]][position];
    now.slice(first,last+1).forEach((child,i)=>{if(i)at+=gaps[i-1];kept[child][position]=Math.round(at*1000)/1000;at+=kept[child][size];});
  }
  movedSizes=Object.fromEntries(Object.entries(frames).filter(([id])=>after.has(id)&&!kept[id]).map(([id,frame])=>[id,{width:frame.width,height:frame.height}]));
  return kept;
}
// New elements get a frame where the layout puts them; next to framed siblings they go after the last one
// (below in a column, to the right in a row) instead of on top of them.
let dropPoint=null, movedSizes={};
function placeNewNodes() {
  const point=dropPoint, sizes=movedSizes; dropPoint=null; movedSizes={};
  const frames=doc().layout?.frames; if(!frames)return;
  const measured=captureFrames(), map=indexTree(doc().root), added={};
  for(const [id,frame] of Object.entries(measured)) {
    if(frames[id])continue;
    const parent=frame.parent&&map.get(frame.parent).node, siblings=(parent?.children||[]).filter(child=>frames[child.id]);
    const end=(axis,size,offset)=>Math.max(...siblings.map(child=>frames[child.id][axis]+frames[child.id][size]+(child.props[offset]||0)))+(parent.props.gap||0);
    const placed={...frame,...sizes[id]}, box=frame.parent&&(frames[frame.parent]||measured[frame.parent]), last=siblings.length&&frames[siblings.at(-1).id];
    // Across the main axis follow the previous element: centred when it is centred, otherwise its start edge.
    const across=(axis,size)=>Math.abs(last[axis]+last[size]/2-box[size]/2)<2?(box[size]-placed[size])/2:last[axis];
    const parentElement=point?.id===id&&[...$('after').querySelectorAll('[data-node-id]')].find(n=>n.dataset.nodeId===frame.parent);
    if(parentElement){
      const origin=parentElement.getBoundingClientRect(), style=getComputedStyle(parentElement), props=map.get(id).node.props;
      placed.x=(point.x-origin.left)/scale-(parseFloat(style.borderLeftWidth)||0)+parentElement.scrollLeft-placed.width/2-(props.offsetX||0);
      placed.y=(point.y-origin.top)/scale-(parseFloat(style.borderTopWidth)||0)+parentElement.scrollTop-placed.height/2-(props.offsetY||0);
    }
    else if(last&&parent.type==='Row'){placed.x=end('x','width','offsetX');placed.y=across('y','height');}
    else if(last&&parent.type!=='Box'){placed.y=end('y','height','offsetY');placed.x=across('x','width');}
    if(box){placed.x=Math.max(0,Math.min(placed.x,box.width-placed.width));placed.y=Math.max(0,Math.min(placed.y,box.height-placed.height));}
    for(const key of ['x','y'])placed[key]=Math.round(placed[key]*1000)/1000;
    added[id]=placed;
  }
  if(!Object.keys(added).length)return;
  Object.assign(frames,added); validate(doc()); localSave(); renderPreview();
}
function freezePreview(frames) {
  for(const element of $('after').querySelectorAll('[data-node-id]')) applyFrame(element,frames[element.dataset.nodeId]);
}
function applyFrame(element,frame) {
  if(!frame)return;
  Object.assign(element.style,{width:`${frame.width}px`,height:`${frame.height}px`,maxWidth:'none',flexGrow:'0',flexBasis:'auto',gridArea:'auto'});
  if(frame.parent!==null)Object.assign(element.style,{position:'absolute',left:`${frame.x}px`,top:`${frame.y}px`});
}
function changed(next, keepInspector = false, skipFreeze = false) {
  try {
    const structure=value=>[...indexTree(value.root)].map(([id,e])=>[id,e.parent,e.index]);
    const structural=JSON.stringify(structure(next))!==JSON.stringify(structure(doc()));
    if(freeMode(next)&&!skipFreeze) {
      if(structural)next.layout={mode:'free',frames:keptFrames(next)};
      else if(!next.layout?.frames)next.layout={mode:'free',frames:captureFrames()};
    }
    if (!history.commit(next)) return;
    localSave();
    if (keepInspector) { renderTree(); renderPreview(); renderDiff(); $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; }
    else render();
    if(structural&&freeMode(next)&&!skipFreeze)placeNewNodes();
    clearTimeout(draftTimer);
    setSaveStatus('Есть несохранённые правки');
    draftTimer = setTimeout(() => queueSave().catch(error => { notice(error.message, true); setSaveStatus('Не сохранено'); }), 500);
  } catch (error) { notice(error.message, true); }
}
function select(id, focusTree = false) { selected = id; renderTree(focusTree ? id : undefined); renderPreview(); renderInspector(); }
function removeSelected() {
  const entry = indexTree(doc().root).get(selected);
  if (!entry?.parent) return;
  const next = clone(doc()), parent = indexTree(next.root).get(entry.parent).node;
  parent.children = parent.children.filter(child => child.id !== selected);
  selected = entry.parent;
  changed(next);
  notice('Элемент удалён. Отменить — Ctrl+Z.');
}
function updateProperty(key, value, keepInspector = false) {
  const next = clone(doc()), node = indexTree(next.root).get(selected)?.node;
  if (!node) return;
  if (value === undefined) delete node.props[key]; else node.props[key] = value;
  changed(next, keepInspector);
}
function dropIntent(from, targetElement, event) {
  const map = indexTree(doc().root), target = map.get(targetElement?.dataset.nodeId), source = map.get(from);
  if (!target || !source || !source.parent || indexTree(source.node).has(target.node.id)) return null;
  const bounds = targetElement.getBoundingClientRect(), horizontal = target.parent && map.get(target.parent).node.type === 'Row' && targetElement.closest('#after');
  const fraction = horizontal ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height;
  const inside = CONTAINERS.includes(target.node.type) && (event.shiftKey || !target.parent || (fraction > .3 && fraction < .7));
  let parentId = inside ? target.node.id : target.parent;
  if (!parentId) return null;
  let position = inside ? target.node.children?.length || 0 : target.index + (fraction >= .5 ? 1 : 0);
  if (source.parent === parentId && source.index < position) position--;
  return {parentId, position, kind:inside ? 'inside' : fraction >= .5 ? 'after' : 'before', horizontal,
    label:inside ? `Внутрь ${nodeName(target.node)}` : `${fraction >= .5 ? 'После' : 'Перед'} ${nodeName(target.node)}`};
}
function clearDropMarkers() {
  document.querySelectorAll('[data-drop]').forEach(n => { delete n.dataset.drop; delete n.dataset.dropAxis; });
}
function dropOn(event, targetElement, from) {
  const intent = dropIntent(from, targetElement, event);
  clearDropMarkers();
  if (!intent) { notice('Сюда перенести нельзя. Выберите соседний элемент или другой контейнер.'); return; }
  try {
    const next = move(doc(), from, intent.parentId, intent.position);
    selected = from;
    // Dropped on the layout: in free layout the element lands under the pointer, not at the end of its container.
    dropPoint = targetElement.closest('#after') ? {id:from, x:event.clientX, y:event.clientY} : null;
    if (JSON.stringify(next) === JSON.stringify(doc())) notice('Порядок уже такой. Перетащите к другому краю элемента.');
    else { changed(next); notice(`Перемещено: ${intent.label}. Отменить — Ctrl+Z.`); }
  } catch (error) { notice(error.message, true); }
}
let ghost, dragTarget, visualDrag, resizeCleanup;
const drag = createDrag({
  start(id, point, element) {
    dragging = id;
    if (element.closest('#after')) {
      selected=id; const props=clone(indexTree(doc().root).get(id).node.props);
      const frames=freeMode()?captureFrames():null; if(frames)freezePreview(frames);
      visualDrag={frames,id,element,point,props,offsets:{offsetX:props.offsetX||0,offsetY:props.offsetY||0},scale};
      $('after').querySelectorAll('[data-node-id]').forEach(n=>n.classList.toggle('selected',n===element));
      renderTree(); renderInspector(); renderSelectionFrame(); document.body.classList.add('dragging'); return;
    }
    ghost = el('div', 'drag-ghost', id); document.body.append(ghost); document.body.classList.add('dragging'); },
  update(id, event) {
    if (visualDrag) {
      const gesture=visualDrag; let dx=(event.clientX-gesture.point.clientX)/gesture.scale, dy=(event.clientY-gesture.point.clientY)/gesture.scale;
      // Shift keeps one axis; a clearly vertical or horizontal drag drops the hand's small sideways drift.
      if(event.shiftKey){if(Math.abs(dx)<Math.abs(dy))dx=0;else dy=0;}
      else{if(Math.abs(dx)<=8&&Math.abs(dy)>=3*Math.abs(dx))dx=0;if(Math.abs(dy)<=8&&Math.abs(dx)>=3*Math.abs(dy))dy=0;}
      gesture.offsets=shiftedOffsets(gesture.props,dx,dy);
      gesture.element.style.translate=`${gesture.offsets.offsetX}px ${gesture.offsets.offsetY}px`; positionSelectionFrame();
      $('saveStatus').textContent=`Смещение: ${gesture.offsets.offsetX}, ${gesture.offsets.offsetY} dp`; return;
    }
    if (!ghost) return;
    ghost.style.left = `${event.clientX + 12}px`; ghost.style.top = `${event.clientY + 12}px`;
    clearDropMarkers();
    dragTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest('#after [data-node-id], #tree [data-node-id]');
    const intent = dropIntent(id, dragTarget, event);
    ghost.textContent = intent ? intent.label : 'Выберите место вставки';
    if (intent) { dragTarget.dataset.drop = intent.kind; dragTarget.dataset.dropAxis = intent.horizontal ? 'horizontal' : 'vertical'; }
  },
  finish(id, event, canceled) {
    if (visualDrag) {
      const gesture=visualDrag; visualDrag=null; dragging=null; document.body.classList.remove('dragging');
      suppressClick=true; setTimeout(()=>{suppressClick=false;},100);
      restoreSaveStatus();
      if (canceled) {renderPreview(); notice('Перемещение отменено.');}
      else {const next=clone(doc()); if(gesture.frames)next.layout={mode:'free',frames:gesture.frames}; const props=indexTree(next.root).get(id).node.props;
        for (const key of ['offsetX','offsetY']) if (gesture.offsets[key] !== (props[key]||0)) props[key]=gesture.offsets[key];
        changed(next); renderPreview(); notice('Элемент перемещён. Отменить — Ctrl+Z.');}
      return;
    }
    const target = dragTarget; ghost?.remove(); ghost = null; dragTarget = null;
    document.body.classList.remove('dragging'); clearDropMarkers(); dragging = null;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 100);
    if (canceled) notice('Перемещение отменено.');
    else if (target) dropOn(event, target, id);
    else notice('Отпустите над элементом макета или строкой дерева.');
  },
});
function wireDrag(node, id) { if (id !== doc().root.id) drag.wire(node, id); }
function renderTree(focusId = document.activeElement?.closest('#tree [data-node-id]')?.dataset.nodeId) {
  drag.clear($('tree')); $('tree').replaceChildren(); const map = indexTree(doc().root);
  if (!map.has(selected)) selected = doc().root.id;
  $('tree').setAttribute('aria-description', 'Стрелки вверх и вниз — выбор; влево — родитель, вправо — первый ребёнок; Home и End — начало и конец дерева.');
  $('count').textContent = map.size; $('projectName').textContent = doc().name;
  function visit(node, depth) {
    const button = el('button', 'tree-node' + (node.id === selected ? ' selected' : ''));
    button.style.paddingLeft = `${8 + depth * 13}px`; button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', depth + 1); button.setAttribute('aria-selected', node.id === selected); button.dataset.nodeId = node.id;
    button.tabIndex = node.id === selected ? 0 : -1;
    button.append(el('span', 'tree-grip', '⠿'), el('span', 'node-glyph', icons[node.type]), el('span', 'tree-label', nodeName(node)));
    button.title = `${nodeName(node)} · ${typeNames[node.type] || node.type}`;
    button.addEventListener('click', () => { if (!suppressClick) select(node.id); }); wireDrag(button, node.id); $('tree').append(button);
    button.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const ids = [...map.keys()], position = ids.indexOf(node.id), entry = map.get(node.id);
      const next = { ArrowDown: ids[Math.min(ids.length - 1, position + 1)], ArrowUp: ids[Math.max(0, position - 1)], Home: ids[0], End: ids.at(-1), ArrowLeft: entry.parent || node.id, ArrowRight: node.children?.[0]?.id || node.id }[event.key];
      if (next) { event.preventDefault(); select(next, true); }
    });
    (node.children || []).forEach(child => visit(child, depth + 1));
  }
  visit(doc().root, 0);
  if (focusId) {
    const target = [...$('tree').querySelectorAll('[data-node-id]')].find(element => element.dataset.nodeId === (map.has(focusId) ? focusId : selected));
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
  }
  $('add').disabled = !CONTAINERS.includes(map.get(selected)?.node.type);
  renderAddCapability();
}
function capabilityHelp(title,reason) { const button=helpButton(title,reason+' Ваши правки сохраняются и передаются вместе с остальными изменениями.');button.title=reason;return button; }
function renderAddCapability() {
  $('addTransferHelp')?.remove();
  const capability=composeCapability($('newType').value);
  if(capability.mode==='agent'){const button=capabilityHelp('Добавление элемента',capability.reason);button.id='addTransferHelp';document.querySelector('.add-section > label').append(button);}
}
$('newType').addEventListener('change',renderAddCapability);
const alignment = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', 'space-between': 'space-between' };
function renderNode(node, editable, parentType, frames, fontScale=1, parentAlign, textGeometry={}, modifierBindings, fontScaleCurve, fontHashes) {
  const p = node.props, container = CONTAINERS.includes(node.type), n = el('div', 'layout-node');
  n.dataset.nodeId = node.id; n.dataset.label = nodeName(node);
  if (container) {
    n.style.display = node.type === 'Box' ? 'grid' : 'flex';
    n.style.flexDirection = node.type === 'Row' ? 'row' : 'column';
    n.style.alignItems = alignment[p.align || (node.type === 'Row' ? 'center' : 'stretch')];
    n.style.justifyContent = alignment[p.justify || 'start'];
    n.style.gap = `${p.gap || 0}px`;
    if(node.type==='Box') {
      n.style.gridTemplateColumns='minmax(0, 1fr)';n.style.gridTemplateRows='minmax(0, 1fr)';
      n.style.justifyItems='start';n.style.alignItems=alignment[p.align||'start'];
    }
  }
  const size = (key, value) => {
    if (typeof value === 'number') n.style[key] = `${value}px`;
    if (value === 'fill') {
      if ((key === 'width' && parentType === 'Row') || (key === 'height' && parentType && parentType !== 'Row' && parentType !== 'Box')) { n.style.flexGrow = '1'; n.style.flexBasis = '0'; n.style.minHeight = '0'; }
      else n.style[key] = '100%';
    }
    if (value === 'auto') { n.style[key] = 'fit-content'; if(key==='width')n.style.maxWidth='100%'; }
  };
  size('width', p.width); size('height', p.height);
  const stretchAxis=!frames&&parentAlign==='stretch'?(parentType==='Row'?'height':parentType==='Column'?'width':null):null;
  if(stretchAxis&&(p[stretchAxis]===undefined||p[stretchAxis]==='auto'))size(stretchAxis,'fill');
  if (p.weight) { n.style.flexGrow = p.weight; n.style.flexBasis = '0'; }
  if (!container && p.align) n.style.alignSelf = alignment[p.align];
  if (parentType === 'Box') n.style.gridArea = '1 / 1';
  if (p.padding !== undefined) n.style.padding = `${p.padding}px`;
  if (p.paddingHorizontal !== undefined) { n.style.paddingLeft = `${p.paddingHorizontal}px`; n.style.paddingRight = `${p.paddingHorizontal}px`; }
  if (p.paddingVertical !== undefined) { n.style.paddingTop = `${p.paddingVertical}px`; n.style.paddingBottom = `${p.paddingVertical}px`; }
  if (p.radius !== undefined) n.style.borderRadius = `${p.radius}px`;
  if (p.fontSize !== undefined) n.style.fontSize = `${scaledSp(p.fontSize,fontScale,fontScaleCurve)}px`;
  const metrics=textGeometry[node.id];
  const nativeText=metrics&&metrics.fontSize>0&&['text','fontFamily','fontWeight','fontStyle'].every(key=>metrics[key]===undefined||metrics[key]===p[key]);
  if(nativeText&&metrics.fontDp>0)n.style.fontSize=`${metrics.fontDp*scaledSp(p.fontSize||metrics.fontSize,fontScale,fontScaleCurve)/scaledSp(metrics.fontSize,fontScale,fontScaleCurve)}px`;
  const sameTextLayout=nativeText&&['fontSize','lineHeight','letterSpacing','maxLines','textOverflow'].every(key=>metrics[key]===p[key])&&(!frames?.[node.id]||Math.abs(frames[node.id].width-(metrics.layoutWidth??frames[node.id].width))<.02)&&(p.width===undefined||p.width===metrics.layoutWidth);
  // Text edits keep the captured font: a single line stays as tall as Compose draws it, even when the
  // theme's lineHeight is smaller than the font (Compose never clips glyphs to such a line).
  const sameFont=metrics&&metrics.fontSize>0&&['fontFamily','fontWeight','fontStyle','lineHeight'].every(key=>metrics[key]===undefined||metrics[key]===p[key]);
  const nativeSingleLine=sameFont&&(metrics.lineCount===1||(metrics.lineCount==null&&p.maxLines===1));
  // Compose trims leading above/below a single line; CSS line-height includes it.
  const lineHeight=nativeSingleLine?metrics.textHeight*fontScale*scaledSp(p.fontSize||metrics.fontSize,fontScale,fontScaleCurve)/scaledSp(metrics.fontSize,fontScale,fontScaleCurve):sameTextLayout&&metrics.lineAdvance?metrics.lineAdvance:p.lineHeight===undefined?undefined:(p.fontSize?scaledSp(p.fontSize,fontScale,fontScaleCurve)*p.lineHeight/p.fontSize:p.lineHeight*fontScale);
  if (lineHeight !== undefined) n.style.lineHeight = `${lineHeight}px`;
  if (p.fontFamily==='Roboto') n.style.fontFamily=`"${robotoFamily(fontHashes?.Roboto)}"`;
  else if (p.fontFamily) n.style.fontFamily=({system:'system-ui','Sans Serif':'sans-serif',Serif:'serif',Monospace:'monospace',Cursive:'cursive'}[p.fontFamily] || p.fontFamily);
  if (p.letterSpacing !== undefined) n.style.letterSpacing=`${scaledSp(p.letterSpacing,fontScale,fontScaleCurve)}px`;
  if (p.fontWeight !== undefined) n.style.fontWeight = p.fontWeight;
  if (p.borderWidth !== undefined) n.style.border = `${p.borderWidth}px solid ${p.borderColor || '#D6D9D3'}`;
  if (p.scrollable) { n.style.overflowY = 'auto'; n.style.minHeight = '0'; n.style.scrollbarWidth = 'thin'; }
  if (p.color) n.style.color = p.color;
  if (p.background) n.style.background = p.background;
  if(p.background&&modifierBindings) {
    const inset=modifierMetrics(p,modifierBindings[node.id]).backgroundInset;
    if(inset.horizontal||inset.vertical)Object.assign(n.style,{backgroundColor:'transparent',backgroundImage:`linear-gradient(${p.background}, ${p.background})`,backgroundRepeat:'no-repeat',backgroundPosition:`${inset.horizontal}px ${inset.vertical}px`,backgroundSize:`max(0px, calc(100% - ${2*inset.horizontal}px)) max(0px, calc(100% - ${2*inset.vertical}px))`});
  }
  if (p.opacity !== undefined) n.style.opacity = p.opacity;
  if (p.clipContent) n.style.overflow='hidden';
  if (p.offsetX || p.offsetY) n.style.translate = `${p.offsetX || 0}px ${p.offsetY || 0}px`;
  if (node.type === 'Card' && !p.borderWidth && !doc().compose) n.style.boxShadow = '0 3px 14px #26304706';
  if (['Text', 'Icon', 'Button'].includes(node.type)) { n.textContent = p.text || node.type; if (node.type === 'Button') { n.classList.add('button-node'); const label = el('span', 'text-content', n.textContent); n.replaceChildren(label); } }
  if (node.type === 'Icon') n.style.textAlign = 'center';
  if (node.type === 'TextField') { n.classList.add('field-node'); n.textContent = p.text || p.placeholder || 'Введите текст'; }
  if (['Text', 'Button', 'Icon', 'TextField'].includes(node.type)) {
    n.style.whiteSpace = 'pre-wrap';
    if (p.textAlign) n.style.textAlign = p.textAlign;
    if (p.fontStyle) {n.style.fontStyle = p.fontStyle;n.style.fontVariationSettings=p.fontStyle==='italic'?'"ital" 1, "slnt" -10':'"ital" 0, "slnt" 0';}
    if (p.textDecoration) n.style.textDecoration = p.textDecoration;
    if (node.type === 'TextField' || node.type === 'Text') { const label = el('span', 'text-content', n.textContent); n.replaceChildren(label); }
  }
  // A single line measured in the capture (no maxLines in code) wraps again once the text is edited.
  const measuredLine=metrics?.measuredMaxLines&&metrics.text!==p.text&&p.maxLines===1&&p.textOverflow===metrics.textOverflow;
  if ((p.maxLines || p.textOverflow) && !measuredLine) {
    const label=n.querySelector('.text-content') || n;
    label.style.overflow='hidden'; label.style.maxWidth='100%'; label.style.minWidth='0';
    // One line needs no vertical cut: ascenders and descenders may exceed a tight line height.
    if(p.maxLines===1) { label.style.whiteSpace='pre'; label.style.overflowX='clip'; label.style.overflowY='visible'; label.style.textOverflow=p.textOverflow || 'clip'; }
    else if(p.maxLines) { if(p.textOverflow==='ellipsis') { label.style.display='-webkit-box'; label.style.webkitBoxOrient='vertical'; label.style.webkitLineClamp=String(p.maxLines); } else {label.style.display='block'; label.style.maxHeight=`calc(${p.maxLines} * 1lh)`;} }
  }
  // Nearest painted background, inherited through the DOM: an outlined field label cuts its border with it.
  if (p.background) n.style.setProperty('--surface-under', p.background);
  if (node.type === 'TextField' && (p.label || p.supportingText || p.leadingIcon || p.trailingIcon)) {
    // Material layout inside the field bounds: label, 56dp box with icons, supporting text below.
    const outlined = Boolean(p.borderWidth), box = el('div', 'field-box'), content = n.querySelector('.text-content');
    for (const key of ['border', 'borderRadius', 'backgroundColor']) { box.style[key] = n.style[key]; n.style[key] = ''; }
    n.style.border = 'none';
    n.classList.add('field-composite'); n.classList.toggle('outlined', outlined);
    const icon = src => { const image = el('img', 'field-icon'); image.src = src; image.alt = ''; return image; };
    if (p.leadingIcon) box.append(icon(p.leadingIcon));
    if (p.label) box.append(el('span', 'field-label', p.label));
    if (content) box.append(content);
    if (p.trailingIcon) box.append(icon(p.trailingIcon));
    n.replaceChildren(box);
    if (p.supportingText) n.append(el('div', 'field-support', p.supportingText));
  }
  if (node.type === 'Switch') { n.classList.add('switch-node'); n.classList.toggle('checked', Boolean(p.checked)); }
  if (node.type === 'Spacer') { if (p.height === undefined) n.style.height = '16px'; }
  if (node.type === 'Image') {
    if (p.src) { const image = el('img', 'image-node'); image.src = p.src; image.alt = p.text || 'Изображение'; image.style.width = '100%'; image.style.height = '100%';
      // A minimum height only for images without a size; captured icons keep their own frame.
      if (p.height === undefined && !frames?.[node.id]) image.style.minHeight = '50px';
      n.append(image); }
    else { n.textContent = '▧ Изображение'; n.style.background ||= '#e9e6f4'; n.style.padding ||= '24px'; }
  }
  const label=n.querySelector('.text-content');

  // Keep measured native breaks and ellipsis while text, typography and width
  // match the capture; edits restore normal CSS wrapping without rewriting intent.
  if(sameTextLayout&&label&&(metrics.lineCount===1||metrics.lineRanges)){
    if(metrics.lineRanges)label.replaceChildren(...metrics.lineRanges.map((range,i)=>{
      const text=p.text.slice(range.start,range.end)+(range.ellipsis?'…':''),line=el('span','native-line',text);line.style.display='block';
      if(metrics.lineWidths?.[i]>0){
        const width=metrics.lineWidths[i],box=el('span','native-line-width'),glyphs=el('span','native-line-glyphs',text);
        Object.assign(box.style,{display:'inline-block',width:`${width}px`});Object.assign(glyphs.style,{display:'block',width:'max-content',transformOrigin:'left center'});box.append(glyphs);line.replaceChildren(box);
        document.fonts.ready.then(()=>{if(!glyphs.isConnected)return;const actual=parseFloat(getComputedStyle(glyphs).width);if(actual>0)glyphs.style.transform=`scaleX(${width/actual})`;});
      }
      return line;
    }));
    label.style.display='block';label.style.webkitLineClamp='none';label.style.maxHeight='none';label.style.whiteSpace='pre';label.style.overflow='visible';label.style.textOverflow='clip';label.style.maxWidth='none';}
  if(node.type==='Button'&&sameTextLayout&&metrics.textBoxWidth>=0&&label){label.style.width=`${metrics.textBoxWidth}px`;label.style.textAlign=p.textAlign||'left';}
  if(node.type!=='Button'&&sameTextLayout&&metrics.lineCount>1&&label&&p.lineHeight!==undefined){
    const leading=Math.max(0,(lineHeight*metrics.lineCount-metrics.textHeight*fontScale)/2);
    label.style.transform=`translateY(${-leading}px)`;
  }
  if(node.type==='Button'&&metrics?.paintInsets&&Object.values(metrics.paintInsets).some(value=>value>0)){
    const paint=el('div','native-paint'),insets=metrics.paintInsets;
    Object.assign(paint.style,{position:'absolute',pointerEvents:'none',left:`${insets.left}px`,right:`${insets.right}px`,top:`${insets.top}px`,bottom:`${insets.bottom}px`,background:p.background||'transparent',border:p.borderWidth?`${p.borderWidth}px solid ${p.borderColor||'#D6D9D3'}`:'none',borderRadius:`${p.radius||0}px`});
    n.style.background='transparent';n.style.border='none';n.style.borderRadius='0';n.prepend(paint);
    if(label){label.style.position='relative';label.style.zIndex='1';}
  }
  if(sameTextLayout&&metrics.paintVisible===false){n.style.background='transparent';n.style.border='none';if(label)label.style.visibility='hidden';const paint=n.querySelector('.native-paint');if(paint)paint.style.visibility='hidden';}
  (node.children || []).forEach(child => n.append(renderNode(child, editable, node.type, frames, fontScale,p.align,textGeometry,modifierBindings,fontScaleCurve,fontHashes)));
  if(frames?.[node.id]) {
    const frame=frames[node.id]; applyFrame(n,frame);
    for(const key of ['width','height']) {
      if(typeof p[key]==='number')n.style[key]=`${p[key]}px`;else if(p[key]==='auto')size(key,'auto');
    }
    // Edited text sizes to its content as Compose does: a longer label widens the frame (a centred one both ways)
    // and wraps at the container edge instead of being cut by the captured width.
    if(['Text','Button'].includes(node.type)&&typeof metrics?.text==='string'&&metrics.text!==p.text&&frame.parent!==null){
      const parentFrame=frames[frame.parent], centered=parentFrame&&Math.abs(frame.x+frame.width/2-parentFrame.width/2)<2;
      // The container's padding is not captured: the widest siblings show where its content area ends.
      const siblings=Object.entries(frames).filter(([id,f])=>id!==node.id&&f.parent===frame.parent).map(([,f])=>f);
      const start=Math.min(frame.x,...siblings.map(f=>f.x)), end=Math.max(frame.x+frame.width,...siblings.map(f=>f.x+f.width));
      const content=siblings.length&&end-start>frame.width+1?{start:Math.max(0,start),end:parentFrame?Math.min(parentFrame.width,end):end}:null;
      if(p.width===undefined||p.width==='auto'){
        n.style.width='max-content';
        n.style.maxWidth=content?`${centered?content.end-content.start:content.end-frame.x}px`:centered?'100%':`calc(100% - ${frame.x}px)`;
        if(centered){n.style.left='50%';n.style.transform='translateX(-50%)';}
      }
      if(p.height===undefined||p.height==='auto'){n.style.height='auto';n.style.minHeight=`${frame.height}px`;}
    }
  }
  if (editable) {
    n.dataset.editable = 'true'; n.classList.toggle('selected', selected === node.id);
    n.addEventListener('click', event => { event.stopPropagation(); if (!suppressClick && selected !== node.id) select(node.id); });
    wireDrag(n, node.id);
  }
  return n;
}
function renderPreview() {
  if (resizeCleanup) {resizeCleanup(); resizeCleanup=null;}
  drag.clear($('after'));
  if (getZoom() === 'fit') {
    const availableHeight = Math.max(300, $('canvas').clientHeight - 90);
    const availableWidth = Math.max(260, ($('canvas').clientWidth - 85) / ($('beforeStage').hidden ? 1 : 2));
    scale = Math.max(.3, Math.min(.85, availableHeight / Math.max(baseline.viewport.height, doc().viewport.height), availableWidth / Math.max(baseline.viewport.width, doc().viewport.width)));
  }
  syncZoom(scale);
  for (const [target, value, editable] of [['before', baseline, false], ['after', doc(), true]]) {
    const slot = $(target), w = value.viewport.width, h = value.viewport.height;
    const scrollPositions = new Map([...slot.querySelectorAll('[data-node-id]')].filter(n => n.scrollTop).map(n => [n.dataset.nodeId, n.scrollTop]));
    slot.style.width = `${w * scale}px`; slot.style.height = `${h * scale}px`;
    const contentOnly=value.viewport.presentation==='content';
    const phone = el('div', 'phone' + (contentOnly?' content-only':'')); phone.style.width = `${w}px`; phone.style.height = `${h}px`; phone.style.transform = `scale(${scale})`;
    phone.style.background = value.root.props.background || '#F6F7FB';
    const status = el('div', 'statusbar'); status.append(el('span', '', '9:41'), el('span', '', '▴  ▰'));
    const body = el('div', 'phone-body'); body.append(renderNode(value.root, editable, undefined, freeMode(value)?value.layout?.frames:null,value.viewport.fontScale || 1,undefined,(value.compose?.capture?.fontScale==null||value.compose.capture.fontScale===(value.viewport.fontScale||1))?value.compose?.capture?.textGeometry || {}:{},value.compose?.modifierModel===MODIFIER_MODEL?value.compose.bindings:undefined,(value.compose?.capture?.fontScale==null||value.compose.capture.fontScale===(value.viewport.fontScale||1))?value.compose?.capture?.fontScaleCurve:undefined,value.compose?.capture?.fontHashes)); if(contentOnly)phone.append(body); else phone.append(status, body, el('div', 'home-indicator')); slot.replaceChildren(phone);
    slot.querySelectorAll('[data-node-id]').forEach(n => { if (scrollPositions.has(n.dataset.nodeId)) n.scrollTop = scrollPositions.get(n.dataset.nodeId); });
  }
  renderSelectionFrame();
}
const resizeLabels={n:'сверху',ne:'справа сверху',e:'справа',se:'справа снизу',s:'снизу',sw:'слева снизу',w:'слева',nw:'слева сверху'};
function selectedPreview() { return [...$('after').querySelectorAll('[data-node-id]')].find(n=>n.dataset.nodeId===selected); }
function positionSelectionFrame() {
  const frame=$('after').querySelector('.selection-frame'), node=selectedPreview(); if(!frame||!node)return;
  const rect=node.getBoundingClientRect(), slot=$('after').getBoundingClientRect();
  Object.assign(frame.style,{left:`${rect.left-slot.left}px`,top:`${rect.top-slot.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
}
function renderSelectionFrame() {
  $('after').querySelector('.selection-frame')?.remove();
  if(selected===doc().root.id||!selectedPreview())return;
  const frame=el('div','selection-frame');
  for(const [direction,label] of Object.entries(resizeLabels)) {
    const handle=el('button','resize-handle');handle.type='button';handle.dataset.direction=direction;
    handle.title=`Изменить размер ${label}`;handle.setAttribute('aria-label',handle.title);
    handle.addEventListener('click',event=>event.stopPropagation());
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||dragging)return; event.preventDefault();event.stopPropagation();
      beginResize(direction,event);
    });
    handle.addEventListener('keydown',event=>{
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(!delta)return;event.preventDefault();event.stopPropagation();
      const gesture=resizeState(direction), factor=event.shiftKey?10:1;
      applyResize(gesture,delta[0]*factor,delta[1]*factor);commitResize(gesture);
      $('after').querySelector(`[data-direction="${direction}"]`)?.focus();
    });
    frame.append(handle);
  }
  $('after').append(frame);positionSelectionFrame();
}
function resizeState(direction) {
  const element=selectedPreview(), rect=element.getBoundingClientRect(), entry=indexTree(doc().root).get(selected);
  const parentType=indexTree(doc().root).get(entry.parent)?.node.type;
  const frames=freeMode()?captureFrames():null; if(frames)freezePreview(frames);
  return {frames,id:selected,element,direction,scale,scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,props:clone(entry.node.props),rect:{left:rect.left/scale,top:rect.top/scale,width:rect.width/scale,height:rect.height/scale}, parentType, changed:false};
}
function applyResize(gesture,dx,dy) {
  const {element,direction,props}=gesture, horizontal=/[ew]/.test(direction),vertical=/[ns]/.test(direction);
  const next=resizeRect(gesture.rect,direction,dx,dy);
  gesture.changed=(horizontal&&dx!==0)||(vertical&&dy!==0);
  if(horizontal){element.style.width=`${next.width}px`;element.style.maxWidth='none';}
  if(vertical)element.style.height=`${next.height}px`;
  gesture.mainAxis=gesture.parentType==='Row'?horizontal:['Column','Card'].includes(gesture.parentType)&&vertical;
  if(gesture.mainAxis){element.style.flexGrow='0';element.style.flexBasis='auto';}
  element.style.translate=`${props.offsetX||0}px ${props.offsetY||0}px`;
  const actual=element.getBoundingClientRect();
  // Padding/borders can impose a larger rendered minimum than the requested size.
  if(horizontal)next.width=Math.round(actual.width/gesture.scale*10)/10;
  if(vertical)next.height=Math.round(actual.height/gesture.scale*10)/10;
  if(direction.includes('w'))next.left=gesture.rect.left+gesture.rect.width-next.width;
  if(direction.includes('n'))next.top=gesture.rect.top+gesture.rect.height-next.height;
  gesture.offsets=shiftedOffsets(props,next.left-actual.left/gesture.scale,next.top-actual.top/gesture.scale);
  element.style.translate=`${gesture.offsets.offsetX}px ${gesture.offsets.offsetY}px`;
  if(gesture.frames) {
    const origin=element.getBoundingClientRect();
    gesture.anchoredFrames=anchoredChildFrames(gesture.frames,gesture.id,
      origin.left/gesture.scale-gesture.rect.left-(element.scrollLeft-gesture.scrollLeft),
      origin.top/gesture.scale-gesture.rect.top-(element.scrollTop-gesture.scrollTop));
    for(const child of element.children) {
      const frame=gesture.anchoredFrames[child.dataset.nodeId];
      if(frame?.parent===gesture.id) {child.style.left=`${frame.x}px`;child.style.top=`${frame.y}px`;}
    }
  }
  gesture.size=next;positionSelectionFrame();$('saveStatus').textContent=`${next.width.toFixed(1)} × ${next.height.toFixed(1)} dp`;
}
function commitResize(gesture) {
  restoreSaveStatus();
  if(!gesture.changed){renderPreview();return;}
  const next=clone(doc()), props=indexTree(next.root).get(gesture.id).node.props;
  if(gesture.frames)next.layout={mode:'free',frames:gesture.anchoredFrames};
  if(/[ew]/.test(gesture.direction))props.width=gesture.size.width;
  if(/[ns]/.test(gesture.direction))props.height=gesture.size.height;
  if(gesture.mainAxis)delete props.weight;
  for(const key of ['offsetX','offsetY'])if(gesture.offsets[key] !== (props[key]||0))props[key]=gesture.offsets[key];
  changed(next);notice('Размер изменён. Отменить — Ctrl+Z.');
}
function beginResize(direction,event) {
  const gesture=resizeState(direction), x=event.clientX,y=event.clientY;
  const update=event=>{event.preventDefault();applyResize(gesture,(event.clientX-x)/gesture.scale,(event.clientY-y)/gesture.scale);};
  event.currentTarget.setPointerCapture(event.pointerId);
  const cleanup=()=>{window.removeEventListener('blur',cancel);window.removeEventListener('pointermove',update);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',escape,true);document.body.classList.remove('resizing');};
  const cancel=()=>{cleanup();resizeCleanup=null;restoreSaveStatus();renderPreview();notice('Изменение размера отменено.');};
  const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
  const finish=event=>{if(event.clientX!==x||event.clientY!==y)update(event);cleanup();resizeCleanup=null;commitResize(gesture);};
  resizeCleanup=cleanup;document.body.classList.add('resizing');
  window.addEventListener('blur',cancel);window.addEventListener('pointermove',update);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',cancel,{once:true});window.addEventListener('keydown',escape,true);
}
$('after').addEventListener('scroll',positionSelectionFrame,true);
function field(label, key, kind = 'number', options = {}) {
  const node = indexTree(doc().root).get(selected).node, p = node.props, wrapper = el('label', 'prop' + (options.full ? ' full' : ''));
  wrapper.append(el('span', '', label));
  let input, sizeMode;
  if (Array.isArray(kind)) {
    input = el('select');
    const defaultOption = el('option', '', 'По умолчанию'); defaultOption.value = ''; input.append(defaultOption);
    for (const value of kind) { const option = el('option', '', options.labels?.[value] || value); option.value = value; input.append(option); }
    input.value = p[key] ?? '';
  } else if (kind === 'size') {
    sizeMode = el('select'); sizeMode.setAttribute('aria-label', `${label}: режим`); sizeMode.dataset.focusKey = `size-mode-${key}`;
    for (const [value, labelText] of [['','По умолчанию'],['auto','По содержимому'],['fill','Заполнить место'],['fixed','Точный размер']]) { const option = el('option','',labelText); option.value=value; if(freeMode()&&value==='fill')option.disabled=true; sizeMode.append(option); }
    sizeMode.value = typeof p[key] === 'number' ? 'fixed' : p[key] ?? '';
    input = el('input'); input.type='number'; input.min=0; input.max=4000; input.step='any'; input.placeholder='Число · dp'; input.value=typeof p[key] === 'number' ? p[key] : ''; input.hidden=sizeMode.value !== 'fixed';
    sizeMode.addEventListener('change', () => updateProperty(key, sizeMode.value === 'fixed' ? 100 : sizeMode.value || undefined));
    wrapper.classList.add('full'); wrapper.append(sizeMode);
  } else if (kind === 'text') {
    input = el('textarea'); input.value = p[key] ?? ''; input.placeholder = options.placeholder || '';
  } else {
    input = el('input'); input.type = kind; input.value = p[key] ?? ''; if (kind === 'number') { input.min = options.min ?? 0; input.max = options.max ?? 300; input.step = key === 'maxLines' ? 1 : 'any'; }
    if (kind === 'color') input.value = p[key] || (key === 'color' ? '#30384D' : '#FFFFFF');
    if (kind === 'checkbox') input.checked = Boolean(p[key]);
  }
  if(freeMode() && ['align','justify','gap','weight'].includes(key)) {input.disabled=true;input.title='Доступно в автоматической компоновке';}
  input.dataset.property = key; input.setAttribute('aria-label', label);
  const refreshCapability=()=>{wrapper.querySelector('.transfer-help')?.remove();if(composeCapability(node.type).mode==='agent')return;const binding=doc().compose?.bindings?.[selected];const textBinding=binding?.label?doc().compose.bindings[binding.label]:binding;const capability=composeCapability(node.type,key,indexTree(doc().root).get(selected)?.node.props[key],textBinding);if(capability.mode==='agent'){const button=capabilityHelp('Перенос: '+label,capability.reason);button.classList.add('transfer-help');wrapper.firstElementChild.append(button);}};
  refreshCapability();
  const fieldError = el('span', 'field-error'); fieldError.hidden = true;
  fieldError.id = `property-error-${selected}-${key}`; fieldError.setAttribute('role', 'status');
  input.setAttribute('aria-describedby', fieldError.id);
  const showFieldError = message => {
    input.setCustomValidity(message); input.setAttribute('aria-invalid', String(Boolean(message)));
    fieldError.textContent = message; fieldError.hidden = !message;
  };
  const readValue = () => {
    let value = kind === 'size' && sizeMode.value !== 'fixed' ? sizeMode.value : input.value;
    if (kind === 'checkbox') value = input.checked;
    else if (value === '') value = undefined;
    else if (key === 'fontWeight' || kind === 'number' || (kind === 'size' && !['auto', 'fill'].includes(value))) value = Number(value);
    return value;
  };
  const validateField = value => {
    if (input.type === 'number' && input.validity.badInput) throw Error('Введите корректное число');
    const next = clone(doc()), props = indexTree(next.root).get(selected)?.node.props;
    if (!props) return;
    if (value === undefined) delete props[key]; else props[key] = value;
    validate(next); return next;
  };
  input.addEventListener('change', () => {
    try {
      const next = validateField(readValue()); showFieldError(''); changed(next, true); refreshCapability();
      if (kind === 'size' && input.value === '' && sizeMode.value === 'fixed') {sizeMode.value = ''; input.hidden = true;}
    } catch (error) { showFieldError(error.message); }
  });
  if (['size', 'number', 'text'].includes(kind)) input.addEventListener('input', () => {
    try { const next = validateField(readValue()); showFieldError(''); changed(next, true); refreshCapability(); }
    catch (error) { showFieldError(error.message); }
  });
  wrapper.append(input, fieldError); return wrapper;
}
setupHelp({isFree:freeMode, onAuto:() => setLayoutMode('auto')});
function section(title, fields = []) {
  const group = el('details', 'prop-section'), summary = el('summary', '', title);
  group.open = sectionState.get(title) ?? title === 'Содержимое';
  group.addEventListener('toggle', () => { if (group.isConnected) sectionState.set(title, group.open); });
  const grid = el('div', 'prop-grid'); grid.append(...fields); group.append(summary, grid); return group;
}
function renderInspector() {
  const map = indexTree(doc().root); if (!map.has(selected)) selected = doc().root.id;
  const entry = map.get(selected), node = entry.node, container = CONTAINERS.includes(node.type), panel = $('inspector');
  const focusKey = panel.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
  // toggle может ещё не прийти, когда правка уже требует нового inspector.
  for (const group of panel.querySelectorAll('details.prop-section')) sectionState.set(group.querySelector('summary').textContent, group.open);
  panel.replaceChildren();
  const intro = el('div'); intro.append(el('div', 'selected-title', nodeName(node)), el('span', 'type-tag', typeNames[node.type] || node.type));
  const remove = el('button', 'danger delete-element', 'Удалить элемент');
  remove.type = 'button'; remove.disabled = !entry.parent;
  remove.title = entry.parent ? 'Удалить выбранный элемент · Delete' : 'Корневой контейнер экрана нельзя удалить';
  const capability=composeCapability(node.type);if(capability.mode==='agent')intro.querySelector('.type-tag').append(capabilityHelp('Подключение элемента',capability.reason));
  remove.addEventListener('click', removeSelected); intro.append(remove); panel.append(intro);
  if (['Text', 'Button', 'Icon', 'TextField', 'Image'].includes(node.type)) panel.append(section('Содержимое', [field('Текст', 'text', 'text', { full: true }), ...(node.type === 'Image' ? [field('URL изображения (https)', 'src', 'text', { full: true })] : []), ...(node.type === 'TextField' ? [field('Подпись', 'label', 'text', { full: true }), field('Подсказка в пустом поле', 'placeholder', 'text', { full: true }), field('Текст под полем', 'supportingText', 'text', { full: true })] : [])]));
  if (node.type === 'Switch') panel.append(section('Состояние', [field('Включено', 'checked', 'checkbox')]));
  if (['Text', 'Button', 'Icon', 'TextField'].includes(node.type)) {
    const typography = section('Форматирование текста', [
      field('Выравнивание текста', 'textAlign', ['start', 'center', 'end', 'justify'], {full:true, labels:{start:'По левому краю',center:'По центру',end:'По правому краю',justify:'По ширине'}}),
      field('Семейство шрифта','fontFamily',FONT_FAMILIES,{full:true,labels:{system:'Системный',Roboto:'Roboto','Roboto Flex':'Roboto Flex','Sans Serif':'Без засечек',Serif:'С засечками',Monospace:'Моноширинный',Cursive:'Рукописный'}}),
      field('Шрифт · sp', 'fontSize', 'number', {min:6,max:100,step:.5}),
      field('Высота строки', 'lineHeight', 'number', {min:6,max:150,step:.5}),
      field('Толщина шрифта', 'fontWeight', [100,200,300,400,500,600,700,800,900].map(String), {labels:{400:'Обычный · 400',500:'Средний · 500',600:'Полужирный · 600',700:'Жирный · 700'}}),
      field('Начертание', 'fontStyle', ['normal','italic'], {labels:{normal:'Обычное',italic:'Курсив'}}),
      field('Подчёркивание', 'textDecoration', ['none','underline'], {labels:{none:'Нет',underline:'Да'}}),
      field('Межбуквенный интервал · sp','letterSpacing','number',{min:-5,max:20,step:.1}),
      field('Максимум строк','maxLines','number',{min:1,max:100,step:1}),
      field('Обрезка текста','textOverflow',['clip','ellipsis'],{labels:{clip:'По границе',ellipsis:'Многоточие'}}),
      field('Цвет текста', 'color', 'color')
    ]);
    sectionHelp(typography, 'Форматирование текста'); panel.append(typography);
  }
  const sizes = section('Размер', [field('Ширина', 'width', 'size'), field('Высота', 'height', 'size')]);
  sectionHelp(sizes, 'Размер');
  if (entry.parent && ['Column','Row','Card'].includes(map.get(entry.parent).node.type)) {
    sizes.append(field('Доля свободного места', 'weight', 'number', {max:100,step:.1,full:true}));
  }
  panel.append(sizes);
  const position = section('Расположение', [field('Смещение по горизонтали · dp','offsetX','number',{min:-4000,max:4000,step:.1}),field('Смещение по вертикали · dp','offsetY','number',{min:-4000,max:4000,step:.1}),field(container ? 'Выравнивание детей' : 'Положение элемента', 'align', ['start', 'center', 'end', 'stretch'], { full: true, labels:{start:'В начале',center:'По центру',end:'В конце',stretch:'Растянуть'} }), ...(container ? [field('Распределение', 'justify', ['start', 'center', 'end', 'space-between'], { full: true, labels:{start:'В начале',center:'По центру',end:'В конце','space-between':'Равные промежутки'} })] : []), field('Отступ внутри · dp', 'padding'), ...(container ? [field('Между детьми · dp', 'gap')] : []), field('Отступ по горизонтали · dp', 'paddingHorizontal'), field('Отступ по вертикали · dp', 'paddingVertical'), ...(container ? [field('Прокрутка содержимого', 'scrollable', 'checkbox', {full:true})] : [])]);
  sectionHelp(position, 'Расположение');
  panel.append(position);
  panel.append(section('Оформление', [field('Радиус · dp', 'radius', 'number', { max: 200 }), field('Фон', 'background', 'color'), field('Обводка · dp', 'borderWidth', 'number', {max:10,step:.5}), field('Цвет обводки', 'borderColor', 'color')]));
  if (entry.parent) {
    const controls = section('Перемещение'); sectionHelp(controls, 'Перемещение');
    const wrapper = el('label', 'prop'); wrapper.append(el('span', '', 'Родитель'));
    const input = el('select'); input.id = 'parentSelect'; input.dataset.focusKey = 'parent';
    const descendants = indexTree(node);
    for (const [id, item] of map) if (CONTAINERS.includes(item.node.type) && !descendants.has(id)) { const option = el('option', '', nodeName(item.node)); option.value = id; input.append(option); }
    input.value = entry.parent; input.addEventListener('change', () => { try { changed(move(doc(), selected, input.value, map.get(input.value).node.children?.length || 0)); } catch (error) { notice(error.message, true); } }); wrapper.append(input); controls.append(wrapper);
    const buttons = el('div', 'move-actions');
    for (const [label, offset] of [['↑ Раньше', -1], ['↓ Позже', 1]]) { const button = el('button', '', label); button.dataset.focusKey = offset < 0 ? 'move-earlier' : 'move-later'; button.disabled = entry.index + offset < 0 || entry.index + offset >= map.get(entry.parent).node.children.length; button.addEventListener('click', () => changed(move(doc(), selected, entry.parent, entry.index + offset))); buttons.append(button); }
    controls.append(buttons);
    panel.append(controls);
  }
  const source = section('Связь с кодом'); source.classList.add('source-box');
  if (node.source) { source.append(el('code', '', node.source.file || 'Файл не указан'), el('code', '', node.source.symbol || ''), el('span', '', node.source.instance || '')); if (node.source.note) source.append(el('p', '', node.source.note)); }
  else source.append(el('span', '', 'Нет прямой ссылки'));
  sectionHelp(source, 'Связь с кодом');
  source.append(el('div', '', `Ревизия: ${baseline.sourceRevision || 'не указана'}`)); $('technicalDetails').replaceChildren(source);
  if (selected === doc().root.id) {
    const settings = section('Размер экрана · dp');
    const grid = el('div', 'prop-grid');
    for (const [key, label] of [['width', 'Ширина'], ['height', 'Высота']]) { const wrapper = el('label', 'prop'); wrapper.append(el('span', '', label)); const input = el('input'); input.type = 'number'; input.value = doc().viewport[key]; input.step = 'any'; input.min = 200; input.max = key === 'width' ? 1500 : 2000; input.addEventListener('change', () => { const next = clone(doc()); next.viewport[key] = Number(input.value); changed(next); }); wrapper.append(input); grid.append(wrapper); }
    settings.append(grid); panel.append(settings);
  }
  if (focusKey) {
    const target = [...panel.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey);
    const fallback = panel.querySelector('.move-actions button:not(:disabled)') || panel.querySelector('#parentSelect');
    (target && !target.disabled ? target : fallback)?.focus({ preventScroll: true });
  }
}
const propertyNames={text:'Текст',label:'Подпись поля',placeholder:'Подсказка в пустом поле',supportingText:'Текст под полем',leadingIcon:'Иконка слева',trailingIcon:'Иконка справа',offsetX:'Смещение по горизонтали',offsetY:'Смещение по вертикали',width:'Ширина',height:'Высота',fontSize:'Размер шрифта',lineHeight:'Высота строки',letterSpacing:'Межбуквенный интервал',textAlign:'Выравнивание текста',color:'Цвет текста',background:'Фон',radius:'Скругление',padding:'Отступ внутри',paddingHorizontal:'Отступ по горизонтали',paddingVertical:'Отступ по вертикали',gap:'Между элементами',layout:'Компоновка',align:'Выравнивание',justify:'Распределение',add:'Добавление',remove:'Удаление',move:'Перемещение',borderWidth:'Обводка',borderColor:'Цвет обводки',fontWeight:'Толщина шрифта',fontFamily:'Шрифт',fontStyle:'Начертание',textDecoration:'Подчёркивание',maxLines:'Максимум строк',textOverflow:'Обрезка текста',weight:'Доля свободного места',opacity:'Непрозрачность',enabled:'Доступность',clipContent:'Обрезка содержимого',scrollable:'Прокрутка'};
function renderDiff() {
  renderHandoff();
  const result=diff(baseline,doc()), changes=result.intent.changes; $('changeCount').textContent = `Правок: ${changes.length}`; $('diffBadge').textContent = changes.length;
  $('diffList').replaceChildren();
  if (!changes.length) $('diffList').append(el('div', 'empty', 'Правок пока нет.'));
  for (const change of changes) {
    const row = el('div', 'diff-row'); const format = v => change.property==='layout' && v ? `${v.mode==='auto'?'Автоматическая':'Свободная'} · ${Object.keys(v.frames||{}).length} позиций` : v === null ? '—' : typeof v === 'object' ? (v.type ? nodeName(v) : typeof v.width==='number' && typeof v.height==='number' ? `${v.width} × ${v.height}` : 'Изменено') : ({center:'По центру',start:'В начале',end:'В конце',stretch:'Растянуть',auto:'Автоматически',fill:'Заполнить',true:'Да',false:'Нет'}[String(v)] || String(v));
    row.append(el('code', '', `${change.id ? nodeName(indexTree(doc().root).get(change.id)?.node || indexTree(baseline.root).get(change.id)?.node) : 'Экран'} · ${propertyNames[change.property] || propertyNames[change.operation] || 'Изменение'}`), el('span', 'old', format(change.before)), el('span', '', '→ ' + format(change.after))); $('diffList').append(row);
  }

}
function render() { const nativeLink=document.querySelector('.native-link');if(nativeLink){nativeLink.textContent=doc().compose?'Эталон Android':'Нативный кадр';nativeLink.onclick=doc().compose?event=>{event.preventDefault();$('baselineStatus').click();}:null;} $('layoutMode').value=freeMode()?'free':'auto'; renderTree(); renderPreview(); renderInspector(); renderDiff(); $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; }
function download(value, filename) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function historyAction(action) {
  history[action](); localSave(); render(); clearTimeout(draftTimer);
  setSaveStatus('Есть несохранённые правки');
  draftTimer = setTimeout(() => queueSave().catch(error => { notice(error.message, true); setSaveStatus('Не сохранено'); }), 500);
}
$('undo').onclick = () => historyAction('undo'); $('redo').onclick = () => historyAction('redo');
$('reset').onclick = () => { changed(clone(baseline),false,true); notice('Правки сброшены. Undo вернёт предыдущий вариант.'); };
function setLayoutMode(mode) {const next=clone(doc()); next.layout=mode==='free'?{mode:'free',frames:captureFrames()}:{mode:'auto'}; changed(next); notice(freeMode()?'Включена свободная компоновка.':'Включена автоматическая компоновка.');}
$('layoutMode').onchange=()=>setLayoutMode($('layoutMode').value);
setupZoom(() => { if (getZoom() !== 'fit') scale = Number(getZoom()); renderPreview(); });
$('compare').onclick = () => { $('beforeStage').hidden = false; $('compare').classList.add('active'); $('single').classList.remove('active'); renderPreview(); };
$('single').onclick = () => { $('beforeStage').hidden = true; $('single').classList.add('active'); $('compare').classList.remove('active'); renderPreview(); };
$('export').onclick = () => download(doc(), 'proposed.json');
$('exportDiff').onclick = () => download(diff(baseline, doc()), 'changes.json');
setupBaseline({write:async(url,payload)=>{
  clearTimeout(draftTimer); await queueSave();
  const value=await api(url,'POST',{...payload,revision});
  revision=value.revision; localSave(); return value;
}});
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw Error('Файл больше 2 MB');
    const value = validate(JSON.parse(await file.text())); document.body.inert = true;
    clearTimeout(draftTimer); await queueSave();
    const result = await api('/api/session', 'PUT', { revision, document: value }); revision = result.revision; baseline = clone(result.baseline); history = History.restore(result.current,result.history); await loadApplied(result); selected = value.root.id; conflict = false; localSave(); render(); notice(`Загружен макет «${value.name}»`); setSaveStatus('Макет загружен ✓');
  } catch (error) { notice(error.message, true); setSaveStatus('Импорт не выполнен'); }
  finally { document.body.inert = false; $('file').value = ''; }
};
$('apply').onclick = async () => {
  const invalid = $('inspector').querySelector(':invalid');
  if (invalid) { invalid.reportValidity(); notice('Исправьте некорректное значение перед передачей агенту.', true); return; }
  const repeated = applied && appliedDocument && JSON.stringify(appliedDocument) === JSON.stringify(doc());
  clearTimeout(draftTimer); $('apply').disabled = true;
  try { const result = await queueSave('/api/apply'); await loadApplied(result); renderHandoff(); notice(repeated ? 'Снимок сохранён повторно: черновик не менялся с прошлой передачи.' : 'Снимок сохранён.'); }
  catch (error) { notice(error.message, true); } finally { $('apply').disabled = false; }
};
$('restoreSession').onclick = async () => {
  clearTimeout(draftTimer);
  try {
    await queueSave(); const state=await api('/api/session/restore','POST',{revision});
    revision=state.revision; baseline=clone(state.baseline); history=History.restore(state.current,state.history);
    await loadApplied(state); selected=doc().root.id; localSave(); render();
    notice('Предыдущая сессия восстановлена. Заменённая сессия также сохранена.'); setSaveStatus('Черновик сохранён ✓');
  } catch(error) { notice(error.message,true); }
};
$('readReport').onclick = () => { $('reportText').textContent = appliedReport; $('reportDialog').showModal(); };
$('closeReport').onclick = () => $('reportDialog').close();
$('downloadReport').onclick = () => { const url = URL.createObjectURL(new Blob([appliedReport], {type:'text/markdown'})); const a = el('a'); a.href=url; a.download='report.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
$('toggleChanges').onclick = () => { const hidden = !$('changesBody').hidden; $('changesBody').hidden = hidden; $('toggleChanges').setAttribute('aria-expanded', !hidden); renderPreview(); };
$('reload').onclick = async () => {
  clearTimeout(draftTimer);
  try { await saveQueue.catch(() => {}); const state = await api('/api/session'); revision = state.revision; baseline = clone(state.baseline); history = History.restore(state.current,state.history); await loadApplied(state); selected = state.current.root.id; conflict = false; localSave(); render(); notice('Загружена серверная версия.'); setSaveStatus('Синхронизировано ✓'); } catch (error) { notice(error.message, true); }
};
for (const type of TYPES) { const option = el('option', '', typeNames[type] || type); option.value = type; $('newType').append(option); }
$('add').onclick = () => {
  const next = clone(doc()), parent = indexTree(next.root).get(selected).node, type = $('newType').value;
  if (!CONTAINERS.includes(parent.type)) return;
  const id = `${type.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`, props = CONTAINERS.includes(type) ? { padding: 8, gap: 8, width: 'fill' } : type === 'Spacer' ? { height: 16 } : type === 'Switch' ? { checked: false } : { text: type === 'Text' ? 'Новый текст' : typeNames[type] || type, fontSize: 15, ...(type === 'Text' ? {width:'auto',height:'auto'} : {}) };
  if (type === 'Button') Object.assign(props, { height: 48, padding: 16, radius: 12, background: '#6754C8', color: '#FFFFFF', width: 'auto' });
  parent.children ||= []; parent.children.push({ id, type, props, ...(CONTAINERS.includes(type) ? { children: [] } : {}) }); selected = id; changed(next);
};
window.addEventListener('keydown', event => {
  if (document.body.inert) return;
  if (event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') || !history || document.querySelector('dialog[open]') || document.body.matches('.dragging, .resizing')) return;
  if (event.key === 'Delete' && !event.target.closest('select') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); removeSelected(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyAction(event.shiftKey ? 'redo' : 'undo'); }
});
document.addEventListener('click', event => { if (suppressClick && event.target.closest('[data-node-id]')) { event.preventDefault(); event.stopPropagation(); } }, true);
window.addEventListener('beforeunload', () => { if (history) localSave(); });
window.addEventListener('resize', () => { if (history) renderPreview(); });
try {
  const state = await api('/api/session'); revision = state.revision; baseline = clone(state.baseline); history = History.restore(state.current,state.history); await loadApplied(state); selected = doc().root.id;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE));
    if (cache && cache.revision === revision && JSON.stringify(cache.baseline) === JSON.stringify(baseline) && JSON.stringify(cache.document) !== JSON.stringify(doc())) {
      history = History.restore(validate(cache.document),cache.history); notice('Восстановлены последние локальные правки.'); draftTimer = setTimeout(() => queueSave().catch(error => notice(error.message, true)), 500);
    }
  } catch { /* Invalid or unavailable cache must not block loading. */ }
  if (innerWidth < 1050 && innerWidth > 640) { $('beforeStage').hidden = true; $('single').classList.add('active'); $('compare').classList.remove('active'); }
  render(); setSaveStatus('Черновик сохранён ✓');
  await loadProject().catch(error=>notice('Не удалось загрузить каталог экранов: '+error.message,true));
  if (baseline.sourceRevision === 'demo-only') notice('Демонстрационный макет. Связи с Kotlin демонстрационные.');
  else if (Array.isArray(baseline.state?.notes) && baseline.state.notes[0]) notice(baseline.state.notes[0]);
} catch (error) {
  notice(`Не удалось загрузить макет: ${error.message}. Запусти локальный сервер и перезагрузи страницу.`, true);
  for (const id of ['apply', 'export', 'import', 'undo', 'redo', 'reset', 'add']) $(id).disabled = true;
}
