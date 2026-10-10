import { shiftedOffsets, resizeRect } from './geometry.mjs';
import { createDrag } from './drag-dnd.mjs';
import { TYPES, CONTAINERS, clone, validate, indexTree, diff, move, History } from './model.mjs';
const $ = id => document.getElementById(id);
let baseline, history, revision = 0, selected = 'screen', scale = .65, dragging = null, draftTimer, saveQueue = Promise.resolve(), conflict = false;
let suppressClick = false, applied = null, appliedDocument = null, appliedReport = '';
async function loadApplied(state) {
  applied = state.applied; appliedDocument = null; appliedReport = '';
  if (applied) { const value = await api('/api/handoff'); appliedDocument = value.document; appliedReport = value.report; }
}
function renderHandoff() {
  const same = appliedDocument && JSON.stringify(appliedDocument) === JSON.stringify(doc());
  $('handoffStatus').textContent = applied ? `Снимок ${applied.directory} · ${applied.mode === 'test' ? 'тестовый' : applied.mode === 'review' ? 'для согласования' : 'старый, режим не указан'} · ${same ? 'совпадает с черновиком' : 'черновик отличается от снимка'}` : 'Снимок ещё не создан';
  $('readReport').disabled = !applied;
}
const sectionState = new Map();
const CACHE = 'compose-visual-bridge-draft-v1';
const icons = { Column: '▥', Row: '▤', Box: '□', Card: '▣', Text: 'T', Button: '▰', Icon: '◇', Image: '▧', TextField: '▭', Switch: '◉', Spacer: '↕' };
const doc = () => history.current;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(url, method = 'GET', payload) {
  const response = await fetch(url, { method, ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 409) conflict = true; throw Error(value.error || `HTTP ${response.status}`); }
  return value;
}
function localSave() {
  try { localStorage.setItem(CACHE, JSON.stringify({ revision, baseline, document: doc() })); } catch { /* Server remains the durable storage. */ }
}
function queueSave(url = '/api/draft', documentValue = clone(doc())) {
  const handoffMode = $('testMode').checked ? 'test' : 'review';
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (conflict) throw Error('Обнаружен конфликт. Экспортируйте макет и загрузите версию с сервера.');
    $('saveStatus').textContent = 'Сохранение…';
    const value = await api(url, url === '/api/apply' ? 'POST' : 'PUT', { revision, document: documentValue, ...(url === '/api/apply' ? { mode: handoffMode } : {}) });
    revision = value.revision; localSave();
    $('saveStatus').textContent = url === '/api/apply' ? 'Передано агенту ✓' : 'Черновик сохранён ✓';
    return value;
  });
  return saveQueue;
}
function changed(next, keepInspector = false) {
  try {
    if (!history.commit(next)) return;
    localSave();
    if (keepInspector) { renderTree(); renderPreview(); renderDiff(); $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; }
    else render();
    clearTimeout(draftTimer);
    $('saveStatus').textContent = 'Есть несохранённые правки';
    draftTimer = setTimeout(() => queueSave().catch(error => { notice(error.message, true); $('saveStatus').textContent = 'Не сохранено'; }), 500);
  } catch (error) { notice(error.message, true); }
}
function select(id) { selected = id; renderTree(); renderPreview(); renderInspector(); }
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
    label:inside ? `Внутрь ${target.node.id}` : `${fraction >= .5 ? 'После' : 'Перед'} ${target.node.id}`};
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
      visualDrag={id,element,point,props,offsets:{offsetX:props.offsetX||0,offsetY:props.offsetY||0},scale};
      $('after').querySelectorAll('[data-node-id]').forEach(n=>n.classList.toggle('selected',n===element));
      renderTree(); renderInspector(); renderSelectionFrame(); document.body.classList.add('dragging'); return;
    }
    ghost = el('div', 'drag-ghost', id); document.body.append(ghost); document.body.classList.add('dragging'); },
  update(id, event) {
    if (visualDrag) {
      const gesture=visualDrag; gesture.offsets=shiftedOffsets(gesture.props,(event.clientX-gesture.point.clientX)/gesture.scale,(event.clientY-gesture.point.clientY)/gesture.scale);
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
      if (canceled) {renderPreview(); notice('Перемещение отменено.');}
      else {const next=clone(doc()); const props=indexTree(next.root).get(id).node.props;
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
function renderTree() {
  drag.clear($('tree')); $('tree').replaceChildren(); const map = indexTree(doc().root);
  $('count').textContent = map.size; $('projectName').textContent = doc().name;
  function visit(node, depth) {
    const button = el('button', 'tree-node' + (node.id === selected ? ' selected' : ''));
    button.style.paddingLeft = `${8 + depth * 13}px`; button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', depth + 1); button.setAttribute('aria-selected', node.id === selected); button.dataset.nodeId = node.id;
    button.append(el('span', 'tree-grip', '⠿'), el('span', 'node-glyph', icons[node.type]), el('span', '', node.id));
    button.title = `${node.id} · ${node.type}`;
    button.addEventListener('click', () => { if (!suppressClick) select(node.id); }); wireDrag(button, node.id); $('tree').append(button);
    (node.children || []).forEach(child => visit(child, depth + 1));
  }
  visit(doc().root, 0);
  $('add').disabled = !CONTAINERS.includes(map.get(selected)?.node.type);
}
const alignment = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', 'space-between': 'space-between' };
function renderNode(node, editable, parentType) {
  const p = node.props, container = CONTAINERS.includes(node.type), n = el('div', 'layout-node');
  n.dataset.nodeId = node.id; n.dataset.label = node.id;
  if (container) {
    n.style.display = node.type === 'Box' ? 'grid' : 'flex';
    n.style.flexDirection = node.type === 'Row' ? 'row' : 'column';
    n.style.alignItems = alignment[p.align || (node.type === 'Row' ? 'center' : 'stretch')];
    n.style.justifyContent = alignment[p.justify || 'start'];
    n.style.gap = `${p.gap || 0}px`;
  }
  const size = (key, value) => {
    if (typeof value === 'number') n.style[key] = `${value}px`;
    if (value === 'fill') {
      if ((key === 'width' && parentType === 'Row') || (key === 'height' && parentType && parentType !== 'Row' && parentType !== 'Box')) { n.style.flexGrow = '1'; n.style.flexBasis = '0'; n.style.minHeight = '0'; }
      else n.style[key] = '100%';
    }
    if (value === 'auto' && key === 'width') { n.style.width = 'fit-content'; n.style.maxWidth = '100%'; }
  };
  size('width', p.width); size('height', p.height);
  if (p.weight) { n.style.flexGrow = p.weight; n.style.flexBasis = '0'; }
  if (!container && p.align) n.style.alignSelf = alignment[p.align];
  if (parentType === 'Box') n.style.gridArea = '1 / 1';
  if (p.padding !== undefined) n.style.padding = `${p.padding}px`;
  if (p.paddingHorizontal !== undefined) { n.style.paddingLeft = `${p.paddingHorizontal}px`; n.style.paddingRight = `${p.paddingHorizontal}px`; }
  if (p.paddingVertical !== undefined) { n.style.paddingTop = `${p.paddingVertical}px`; n.style.paddingBottom = `${p.paddingVertical}px`; }
  if (p.radius !== undefined) n.style.borderRadius = `${p.radius}px`;
  if (p.fontSize !== undefined) n.style.fontSize = `${p.fontSize}px`;
  if (p.lineHeight !== undefined) n.style.lineHeight = `${p.lineHeight}px`;
  if (p.fontWeight !== undefined) n.style.fontWeight = p.fontWeight;
  if (p.borderWidth !== undefined) n.style.border = `${p.borderWidth}px solid ${p.borderColor || '#D6D9D3'}`;
  if (p.scrollable) { n.style.overflowY = 'auto'; n.style.minHeight = '0'; n.style.scrollbarWidth = 'thin'; }
  if (p.color) n.style.color = p.color;
  if (p.background) n.style.background = p.background;
  if (p.opacity !== undefined) n.style.opacity = p.opacity;
  if (p.offsetX || p.offsetY) n.style.translate = `${p.offsetX || 0}px ${p.offsetY || 0}px`;
  if (node.type === 'Card' && !p.borderWidth) n.style.boxShadow = '0 3px 14px #26304706';
  if (['Text', 'Icon', 'Button'].includes(node.type)) { n.textContent = p.text || node.type; if (node.type === 'Button') { n.classList.add('button-node'); const label = el('span', 'text-content', n.textContent); n.replaceChildren(label); } }
  if (node.type === 'Icon') n.style.textAlign = 'center';
  if (node.type === 'TextField') { n.classList.add('field-node'); n.textContent = p.text || p.placeholder || 'Введите текст'; }
  if (['Text', 'Button', 'Icon', 'TextField'].includes(node.type)) {
    n.style.whiteSpace = 'pre-wrap';
    if (p.textAlign) n.style.textAlign = p.textAlign;
    if (p.fontStyle) n.style.fontStyle = p.fontStyle;
    if (p.textDecoration) n.style.textDecoration = p.textDecoration;
    if (node.type === 'TextField') { const label = el('span', 'text-content', n.textContent); n.replaceChildren(label); }
  }
  if (node.type === 'Switch') { n.classList.add('switch-node'); n.classList.toggle('checked', Boolean(p.checked)); }
  if (node.type === 'Spacer') { if (p.height === undefined) n.style.height = '16px'; }
  if (node.type === 'Image') {
    if (p.src) { const image = el('img', 'image-node'); image.src = p.src; image.alt = p.text || 'Изображение'; image.style.width = '100%'; image.style.height = '100%'; n.append(image); }
    else { n.textContent = '▧ Изображение'; n.style.background ||= '#e9e6f4'; n.style.padding ||= '24px'; }
  }
  (node.children || []).forEach(child => n.append(renderNode(child, editable, node.type)));
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
  if ($('zoom').value === 'fit') {
    const availableHeight = Math.max(300, $('canvas').clientHeight - 90);
    const availableWidth = Math.max(260, ($('canvas').clientWidth - 85) / ($('beforeStage').hidden ? 1 : 2));
    scale = Math.max(.3, Math.min(.85, availableHeight / Math.max(baseline.viewport.height, doc().viewport.height), availableWidth / Math.max(baseline.viewport.width, doc().viewport.width)));
  }
  for (const [target, value, editable] of [['before', baseline, false], ['after', doc(), true]]) {
    const slot = $(target), w = value.viewport.width, h = value.viewport.height;
    const scrollPositions = new Map([...slot.querySelectorAll('[data-node-id]')].filter(n => n.scrollTop).map(n => [n.dataset.nodeId, n.scrollTop]));
    slot.style.width = `${w * scale}px`; slot.style.height = `${h * scale}px`;
    const phone = el('div', 'phone'); phone.style.width = `${w}px`; phone.style.height = `${h}px`; phone.style.transform = `scale(${scale})`;
    phone.style.background = value.root.props.background || '#F6F7FB';
    const status = el('div', 'statusbar'); status.append(el('span', '', '9:41'), el('span', '', '▴  ▰'));
    const body = el('div', 'phone-body'); body.append(renderNode(value.root, editable)); phone.append(status, body, el('div', 'home-indicator')); slot.replaceChildren(phone);
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
  return {id:selected,element,direction,scale,props:clone(entry.node.props),rect:{left:rect.left/scale,top:rect.top/scale,width:rect.width/scale,height:rect.height/scale}, parentType, changed:false};
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
  gesture.size=next;positionSelectionFrame();$('saveStatus').textContent=`${next.width.toFixed(1)} × ${next.height.toFixed(1)} dp`;
}
function commitResize(gesture) {
  if(!gesture.changed){renderPreview();return;}
  const next=clone(doc()), props=indexTree(next.root).get(gesture.id).node.props;
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
  const cancel=()=>{cleanup();resizeCleanup=null;renderPreview();notice('Изменение размера отменено.');};
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
    sizeMode = el('select'); sizeMode.setAttribute('aria-label', `${label}: режим`);
    for (const [value, labelText] of [['','По умолчанию'],['auto','По содержимому'],['fill','Заполнить место'],['fixed','Точный размер']]) { const option = el('option','',labelText); option.value=value; sizeMode.append(option); }
    sizeMode.value = typeof p[key] === 'number' ? 'fixed' : p[key] ?? '';
    input = el('input'); input.type='number'; input.min=0; input.max=4000; input.step='any'; input.placeholder='Число · dp'; input.value=typeof p[key] === 'number' ? p[key] : ''; input.hidden=sizeMode.value !== 'fixed';
    sizeMode.addEventListener('change', () => updateProperty(key, sizeMode.value === 'fixed' ? 100 : sizeMode.value || undefined));
    wrapper.classList.add('full'); wrapper.append(sizeMode);
  } else if (kind === 'text') {
    input = el('textarea'); input.value = p[key] ?? ''; input.placeholder = options.placeholder || '';
  } else {
    input = el('input'); input.type = kind; input.value = p[key] ?? ''; if (kind === 'number') { input.min = options.min ?? 0; input.max = options.max ?? 300; input.step = options.step ?? 1; }
    if (kind === 'color') input.value = p[key] || (key === 'color' ? '#30384D' : '#FFFFFF');
    if (kind === 'checkbox') input.checked = Boolean(p[key]);
  }
  input.dataset.property = key; input.setAttribute('aria-label', label);
  const readValue = () => {
    let value = kind === 'size' && sizeMode.value !== 'fixed' ? sizeMode.value : input.value;
    if (kind === 'checkbox') value = input.checked;
    else if (value === '') value = undefined;
    else if (key === 'fontWeight' || kind === 'number' || (kind === 'size' && !['auto', 'fill'].includes(value))) value = Number(value);
    return value;
  };
  const validateField = value => {
    const next = clone(doc()), props = indexTree(next.root).get(selected)?.node.props;
    if (!props) return;
    if (value === undefined) delete props[key]; else props[key] = value;
    validate(next); return next;
  };
  input.addEventListener('change', () => {
    try { validateField(readValue()); input.setCustomValidity(''); updateProperty(key, readValue()); }
    catch (error) { input.setCustomValidity(error.message); notice(error.message, true); }
  });
  if (['size', 'number', 'text'].includes(kind)) input.addEventListener('input', () => {
    const value = readValue(), next = clone(doc());
    const props = indexTree(next.root).get(selected)?.node.props;
    if (!props) return;
    if (value === undefined) delete props[key]; else props[key] = value;
    try { validate(next); input.setCustomValidity(''); changed(next, true); } catch (error) { input.setCustomValidity(error.message); }
  });
  wrapper.append(input); return wrapper;
}
function section(title, fields = []) {
  const group = el('details', 'prop-section'), summary = el('summary', '', title);
  group.open = sectionState.get(title) ?? title === 'Содержимое';
  group.addEventListener('toggle', () => { if (group.isConnected) sectionState.set(title, group.open); });
  const grid = el('div', 'prop-grid'); grid.append(...fields); group.append(summary, grid); return group;
}
function renderInspector() {
  const map = indexTree(doc().root); if (!map.has(selected)) selected = doc().root.id;
  const entry = map.get(selected), node = entry.node, container = CONTAINERS.includes(node.type), panel = $('inspector'); panel.replaceChildren();
  const intro = el('div'); intro.append(el('div', 'selected-title', node.id), el('span', 'type-tag', node.type)); panel.append(intro);
  if (['Text', 'Button', 'Icon', 'TextField', 'Image'].includes(node.type)) panel.append(section('Содержимое', [field('Текст', 'text', 'text', { full: true }), ...(node.type === 'Image' ? [field('URL изображения (https)', 'src', 'text', { full: true })] : [])]));
  if (node.type === 'Switch') panel.append(section('Состояние', [field('Включено', 'checked', 'checkbox')]));
  if (['Text', 'Button', 'Icon', 'TextField'].includes(node.type)) {
    const typography = section('Форматирование текста', [
      field('Выравнивание текста', 'textAlign', ['start', 'center', 'end', 'justify'], {full:true, labels:{start:'По левому краю',center:'По центру',end:'По правому краю',justify:'По ширине'}}),
      field('Шрифт · sp', 'fontSize', 'number', {min:6,max:100,step:.5}),
      field('Высота строки', 'lineHeight', 'number', {min:6,max:150,step:.5}),
      field('Толщина шрифта', 'fontWeight', [100,200,300,400,500,600,700,800,900].map(String), {labels:{400:'Обычный · 400',500:'Средний · 500',600:'Полужирный · 600',700:'Жирный · 700'}}),
      field('Начертание', 'fontStyle', ['normal','italic'], {labels:{normal:'Обычное',italic:'Курсив'}}),
      field('Подчёркивание', 'textDecoration', ['none','underline'], {labels:{none:'Нет',underline:'Да'}}),
      field('Цвет текста', 'color', 'color')
    ]);
    typography.append(el('p', 'prop-help', 'Выравнивает строки внутри блока. Для заметного эффекта выберите ширину «Заполнить место» или задайте точный размер.')); panel.append(typography);
  }
  const sizes = section('Размер', [field('Ширина', 'width', 'size'), field('Высота', 'height', 'size')]);
  sizes.append(el('p', 'prop-help', '«По содержимому» — размер текста или детей. «Заполнить место» — всё доступное место. «Точный размер» — число в dp, единицах размера Android.'));
  if (entry.parent && ['Column','Row','Card'].includes(map.get(entry.parent).node.type)) {
    sizes.append(field('Доля свободного места', 'weight', 'number', {max:100,step:.1,full:true}), el('p','prop-help', 'Необязательно. Делит оставшееся место между соседями: 1 и 1 — поровну, 1 и 2 — одна треть и две трети. В Row влияет на ширину, в Column — на высоту. Пусто или 0 — не участвовать.'));
  }
  panel.append(sizes);
  panel.append(section('Расположение', [field('Смещение по горизонтали · dp','offsetX','number',{min:-4000,max:4000,step:.1}),field('Смещение по вертикали · dp','offsetY','number',{min:-4000,max:4000,step:.1}),field(container ? 'Выравнивание детей' : 'Положение элемента', 'align', ['start', 'center', 'end', 'stretch'], { full: true, labels:{start:'В начале',center:'По центру',end:'В конце',stretch:'Растянуть'} }), ...(container ? [field('Распределение', 'justify', ['start', 'center', 'end', 'space-between'], { full: true, labels:{start:'В начале',center:'По центру',end:'В конце','space-between':'Равные промежутки'} })] : []), field('Отступ внутри · dp', 'padding'), ...(container ? [field('Между детьми · dp', 'gap')] : []), field('Отступ по горизонтали · dp', 'paddingHorizontal'), field('Отступ по вертикали · dp', 'paddingVertical'), ...(container ? [field('Прокрутка содержимого', 'scrollable', 'checkbox', {full:true})] : [])]));
  panel.append(section('Оформление', [field('Радиус · dp', 'radius', 'number', { max: 200 }), field('Фон', 'background', 'color'), field('Обводка · dp', 'borderWidth', 'number', {max:10,step:.5}), field('Цвет обводки', 'borderColor', 'color')]));
  if (entry.parent) {
    const controls = section('Перемещение'); controls.append(el('p','prop-help','На макете тяните сам элемент для свободного перемещения. Для изменения порядка или вложенности перетащите строку за ⠿ слева. Линия показывает место вставки. Центр контейнера — перенос внутрь; Shift также переносит внутрь. Здесь можно переместить кнопками. Свободных координат пока нет.'));
    const wrapper = el('label', 'prop'); wrapper.append(el('span', '', 'Родитель'));
    const input = el('select'); input.id = 'parentSelect';
    const descendants = indexTree(node);
    for (const [id, item] of map) if (CONTAINERS.includes(item.node.type) && !descendants.has(id)) { const option = el('option', '', id); option.value = id; input.append(option); }
    input.value = entry.parent; input.addEventListener('change', () => { try { changed(move(doc(), selected, input.value, map.get(input.value).node.children?.length || 0)); } catch (error) { notice(error.message, true); } }); wrapper.append(input); controls.append(wrapper);
    const buttons = el('div', 'move-actions');
    for (const [label, offset] of [['↑ Раньше', -1], ['↓ Позже', 1]]) { const button = el('button', '', label); button.disabled = entry.index + offset < 0 || entry.index + offset >= map.get(entry.parent).node.children.length; button.addEventListener('click', () => changed(move(doc(), selected, entry.parent, entry.index + offset))); buttons.append(button); }
    controls.append(buttons);
    const remove = el('button', 'danger', 'Удалить элемент'); remove.style.marginTop = '10px'; remove.addEventListener('click', () => { const next = clone(doc()), items = indexTree(next.root), parent = items.get(entry.parent).node; parent.children = parent.children.filter(n => n.id !== selected); selected = entry.parent; changed(next); }); controls.append(remove); panel.append(controls);
  }
  const source = section('Связь с кодом'); source.classList.add('source-box');
  if (node.source) { source.append(el('code', '', node.source.file || 'Файл не указан'), el('code', '', node.source.symbol || ''), el('span', '', node.source.instance || '')); if (node.source.note) source.append(el('p', '', node.source.note)); }
  else source.append(el('span', '', 'Нет прямой ссылки. Агент использует дерево и ближайший компонент со source.'));
  source.append(el('div', '', `Ревизия: ${baseline.sourceRevision || 'не указана'}`)); panel.append(source);
  if (selected === doc().root.id) {
    const settings = section('Размер экрана · dp');
    const grid = el('div', 'prop-grid');
    for (const [key, label] of [['width', 'Ширина'], ['height', 'Высота']]) { const wrapper = el('label', 'prop'); wrapper.append(el('span', '', label)); const input = el('input'); input.type = 'number'; input.value = doc().viewport[key]; input.min = 200; input.max = key === 'width' ? 1500 : 2000; input.addEventListener('change', () => { const next = clone(doc()); next.viewport[key] = Number(input.value); changed(next); }); wrapper.append(input); grid.append(wrapper); }
    settings.append(grid, el('p', 'source-box', 'Веб-превью приблизительное. Финальный результат проверяется в Android.')); panel.append(settings);
  }
}
function renderDiff() {
  renderHandoff();
  const changes = diff(baseline, doc()).changes; $('changeCount').textContent = `${changes.length} изменений`; $('diffBadge').textContent = changes.length;
  $('diffList').replaceChildren();
  if (!changes.length) $('diffList').append(el('div', 'empty', 'Правок пока нет. Выбери элемент в правом макете или в дереве.'));
  for (const change of changes) {
    const row = el('div', 'diff-row'); const format = v => v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    row.append(el('code', '', `${change.id || 'Экран'} · ${change.property || change.operation}`), el('span', 'old', format(change.before)), el('span', '', '→ ' + format(change.after))); $('diffList').append(row);
  }
}
function render() { renderTree(); renderPreview(); renderInspector(); renderDiff(); $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; }
function download(value, filename) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function historyAction(action) {
  history[action](); localSave(); render(); clearTimeout(draftTimer); draftTimer = setTimeout(() => queueSave().catch(error => notice(error.message, true)), 500);
}
$('undo').onclick = () => historyAction('undo'); $('redo').onclick = () => historyAction('redo');
$('reset').onclick = () => { changed(clone(baseline)); notice('Правки сброшены. Undo вернёт предыдущий вариант.'); };
$('zoom').onchange = () => { if ($('zoom').value !== 'fit') scale = Number($('zoom').value); renderPreview(); };
$('compare').onclick = () => { $('beforeStage').hidden = false; $('compare').classList.add('active'); $('single').classList.remove('active'); renderPreview(); };
$('single').onclick = () => { $('beforeStage').hidden = true; $('single').classList.add('active'); $('compare').classList.remove('active'); renderPreview(); };
$('export').onclick = () => download(doc(), 'proposed.json');
$('exportDiff').onclick = () => download(diff(baseline, doc()), 'changes.json');
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw Error('Файл больше 2 MB');
    const value = validate(JSON.parse(await file.text())); clearTimeout(draftTimer); await saveQueue.catch(() => {});
    const result = await api('/api/session', 'PUT', { revision, document: value }); revision = result.revision; baseline = clone(result.baseline); history = new History(result.current); await loadApplied(result); selected = value.root.id; conflict = false; localSave(); render(); notice(`Загружен макет «${value.name}»`); $('saveStatus').textContent = 'Макет загружен ✓';
  } catch (error) { notice(error.message, true); } finally { $('file').value = ''; }
};
$('apply').onclick = async () => {
  const invalid = $('inspector').querySelector(':invalid');
  if (invalid) { invalid.reportValidity(); notice('Исправьте некорректное значение перед передачей агенту.', true); return; }
  clearTimeout(draftTimer); $('apply').disabled = true;
  try { const result = await queueSave('/api/apply'); await loadApplied(result); renderHandoff(); notice('Снимок сохранён. Кнопка не запускает агента. Откройте отчёт для следующего шага.'); }
  catch (error) { notice(error.message, true); } finally { $('apply').disabled = false; }
};
$('readReport').onclick = () => { $('reportText').textContent = appliedReport; $('reportDialog').showModal(); };
$('closeReport').onclick = () => $('reportDialog').close();
$('downloadReport').onclick = () => { const url = URL.createObjectURL(new Blob([appliedReport], {type:'text/markdown'})); const a = el('a'); a.href=url; a.download='report.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
$('toggleChanges').onclick = () => { const hidden = !$('changesBody').hidden; $('changesBody').hidden = hidden; $('toggleChanges').setAttribute('aria-expanded', !hidden); renderPreview(); };
$('reload').onclick = async () => {
  clearTimeout(draftTimer);
  try { await saveQueue.catch(() => {}); const state = await api('/api/session'); revision = state.revision; baseline = clone(state.baseline); history = new History(state.current); await loadApplied(state); selected = state.current.root.id; conflict = false; localSave(); render(); notice('Загружена серверная версия.'); $('saveStatus').textContent = 'Синхронизировано ✓'; } catch (error) { notice(error.message, true); }
};
for (const type of TYPES) { const option = el('option', '', type); option.value = type; $('newType').append(option); }
$('add').onclick = () => {
  const next = clone(doc()), parent = indexTree(next.root).get(selected).node, type = $('newType').value;
  if (!CONTAINERS.includes(parent.type)) return;
  const id = `${type.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`, props = CONTAINERS.includes(type) ? { padding: 8, gap: 8, width: 'fill' } : type === 'Spacer' ? { height: 16 } : type === 'Switch' ? { checked: false } : { text: type, fontSize: 15 };
  if (type === 'Button') Object.assign(props, { height: 48, padding: 16, radius: 12, background: '#6754C8', color: '#FFFFFF', width: 'auto' });
  parent.children ||= []; parent.children.push({ id, type, props, ...(CONTAINERS.includes(type) ? { children: [] } : {}) }); selected = id; changed(next);
};
window.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || !history) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyAction(event.shiftKey ? 'redo' : 'undo'); }
});
document.addEventListener('click', event => { if (suppressClick && event.target.closest('[data-node-id]')) { event.preventDefault(); event.stopPropagation(); } }, true);
window.addEventListener('beforeunload', () => { if (history) localSave(); });
window.addEventListener('resize', () => { if (history) renderPreview(); });
try {
  const state = await api('/api/session'); revision = state.revision; baseline = clone(state.baseline); history = new History(state.current); await loadApplied(state); selected = doc().root.id;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE));
    if (cache && cache.revision === revision && JSON.stringify(cache.baseline) === JSON.stringify(baseline) && JSON.stringify(cache.document) !== JSON.stringify(doc())) {
      history = new History(validate(cache.document)); notice('Восстановлены последние локальные правки.'); draftTimer = setTimeout(() => queueSave().catch(error => notice(error.message, true)), 500);
    }
  } catch { /* Invalid or unavailable cache must not block loading. */ }
  if (innerWidth < 1050 && innerWidth > 640) { $('beforeStage').hidden = true; $('single').classList.add('active'); $('compare').classList.remove('active'); }
  render(); $('saveStatus').textContent = 'Черновик сохранён ✓';
  if (baseline.sourceRevision === 'demo-only') notice('Демо-экран · импортируй JSON своего экрана, подготовленный агентом. Ссылки на Kotlin здесь демонстрационные.');
  else if (Array.isArray(baseline.state?.notes) && baseline.state.notes[0]) notice(baseline.state.notes[0]);
} catch (error) {
  notice(`Не удалось загрузить макет: ${error.message}. Запусти локальный сервер и перезагрузи страницу.`, true);
  for (const id of ['apply', 'export', 'import', 'undo', 'redo', 'reset', 'add']) $(id).disabled = true;
}
