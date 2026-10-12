import {transferNeeds} from './compose-capabilities.mjs';
import {MODIFIER_MODEL,MODIFIER_GROUPS} from './modifier-layout.mjs';
export const FONT_FAMILIES = ['system','Roboto','Roboto Flex','Sans Serif','Serif','Monospace','Cursive'];
export const TYPES = ['Column', 'Row', 'Box', 'Card', 'Text', 'Button', 'TextField', 'Switch', 'Icon', 'Image', 'Spacer'];
export const CONTAINERS = ['Column', 'Row', 'Box', 'Card'];
export const clone = value => JSON.parse(JSON.stringify(value));
const numeric = { offsetX: [-4000, 4000], offsetY: [-4000, 4000], width: [0, 4000], height: [0, 4000], padding: [0, 300], paddingHorizontal: [0, 300], paddingVertical: [0, 300], gap: [0, 300], fontSize: [6, 100], letterSpacing: [-5, 20], maxLines: [1, 100], lineHeight: [6, 150], fontWeight: [100, 900], borderWidth: [0, 10], radius: [0, 200], weight: [0, 100], opacity: [0, 1] };
export function validate(doc) {
  if (!doc || doc.schemaVersion !== 1) throw Error('Нужен schemaVersion: 1');
  if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 200) throw Error('Нужно название макета (до 200 символов)');
  if (!doc.viewport || !Number.isFinite(doc.viewport.width) || doc.viewport.width < 200 || doc.viewport.width > 1500 || !Number.isFinite(doc.viewport.height) || doc.viewport.height < 200 || doc.viewport.height > 2000) throw Error('Viewport: ширина 200–1500, высота 200–2000 dp');
  if (doc.sourceRevision != null && typeof doc.sourceRevision !== 'string') throw Error('sourceRevision должен быть строкой');
  if (doc.viewport.presentation != null && !['content','device'].includes(doc.viewport.presentation)) throw Error('viewport.presentation: content или device');
  if (doc.viewport.fontScale != null && (!Number.isFinite(doc.viewport.fontScale) || doc.viewport.fontScale < .5 || doc.viewport.fontScale > 3)) throw Error('viewport.fontScale: 0.5–3');
  if(doc.state?.creationRequest!=null&&(typeof doc.state.creationRequest!=='string'||doc.state.creationRequest.length>5000))throw Error('Запрос нового экрана: текст до 5000 символов');
  if(doc.state?.paletteInsertions!=null){if(!Array.isArray(doc.state.paletteInsertions)||doc.state.paletteInsertions.length>500||doc.state.paletteInsertions.some(item=>!item||! /^[\w.-]{1,100}$/.test(item.id||'')||! /^[\w.-]{1,100}$/.test(item.component||'')||typeof item.sourceRevision!=='string'||!item.sourceRevision||item.sourceRevision.length>500))throw Error('Некорректные связи палитры проекта');}
  const ids = new Set();
  function visit(n, depth) {
    if (depth > 30 || ids.size >= 500) throw Error('Макет слишком большой (500 элементов / 30 уровней)');
    if (!n || typeof n.id !== 'string' || !/^[\w.-]{1,100}$/.test(n.id) || ids.has(n.id)) throw Error('ID должны быть уникальными: буквы, цифры, . _ -');
    ids.add(n.id);
    if (!TYPES.includes(n.type)) throw Error(`Неизвестный компонент: ${n.type}`);
    if (!n.props || typeof n.props !== 'object' || Array.isArray(n.props)) throw Error(`Нужен props у ${n.id}`);
    for (const [key, value] of Object.entries(n.props)) {
      if (key in numeric) {
        if ((key === 'width' || key === 'height') && ['auto', 'fill'].includes(value)) continue;
        const [lo, hi] = numeric[key];
        if (!Number.isFinite(value) || value < lo || value > hi || (key === 'maxLines' && !Number.isInteger(value))) throw Error(`${n.id}.${key}: допустимо ${lo}–${hi}`);
      } else if (key === 'align') {
        if (!['start', 'center', 'end', 'stretch'].includes(value)) throw Error('align: start, center, end, stretch');
      } else if (key === 'fontFamily') {
        if (!FONT_FAMILIES.includes(value)) throw Error('fontFamily: неизвестное семейство шрифта');
      } else if (key === 'textOverflow') {
        if (!['clip','ellipsis'].includes(value)) throw Error('textOverflow: clip или ellipsis');
      } else if (key === 'textAlign') {
        if (!['start', 'center', 'end', 'justify'].includes(value)) throw Error('textAlign: start, center, end, justify');
      } else if (key === 'fontStyle') {
        if (!['normal', 'italic'].includes(value)) throw Error('fontStyle: normal, italic');
      } else if (key === 'textDecoration') {
        if (!['none', 'underline'].includes(value)) throw Error('textDecoration: none, underline');
      } else if (key === 'justify') {
        if (!['start', 'center', 'end', 'space-between'].includes(value)) throw Error('justify: start, center, end, space-between');
      } else if (['color', 'background', 'borderColor'].includes(key)) {
        if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw Error(`${key}: нужен цвет #RRGGBB`);
      } else if (['text', 'placeholder', 'src'].includes(key)) {
        if (typeof value !== 'string' || value.length > (key==='src'?2000000:5000)) throw Error(`${key}: строка превышает допустимый размер`);
        if (key === 'src' && value && !/^https:\/\//.test(value) && !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('Image.src: только https URL или встроенный PNG');
      } else if (['checked', 'scrollable', 'enabled', 'clipContent'].includes(key)) {
        if (typeof value !== 'boolean') throw Error(`${key}: boolean`);
      } else throw Error(`Неизвестное свойство ${n.id}.${key}`);
    }
    if (n.source != null) {
      if (typeof n.source !== 'object' || Array.isArray(n.source)) throw Error('source: объект');
      for (const [key, value] of Object.entries(n.source)) {
        if (['file', 'symbol', 'instance', 'note'].includes(key) && typeof value === 'string' && value.length <= 2000) continue;
        if (key === 'line' && Number.isInteger(value) && value > 0) continue;
        throw Error(`Некорректный source.${key}`);
      }
    }
    if (n.children != null && !Array.isArray(n.children)) throw Error('children: массив');
    if (!CONTAINERS.includes(n.type) && n.children?.length) throw Error(`${n.type} не может содержать элементы`);
    for (const child of n.children || []) visit(child, depth + 1);
  }
  visit(doc.root, 0);
  if(doc.compose?.modifierModel!=null) {
    if(doc.compose.modifierModel!==MODIFIER_MODEL||!doc.compose.bindings||typeof doc.compose.bindings!=='object'||Array.isArray(doc.compose.bindings))throw Error('compose.modifierModel: неизвестная модель модификаторов');
    for(const binding of Object.values(doc.compose.bindings))if(binding?.modifierLayout!=null) {
      const layout=binding.modifierLayout;
      if(!layout||Object.keys(layout).some(key=>key!=='order')||!Array.isArray(layout.order)||layout.order.length>100||layout.order.some(group=>!MODIFIER_GROUPS.includes(group)))throw Error('compose.bindings.modifierLayout: некорректный порядок модификаторов');
    }
  }
  if(doc.compose?.capture?.fontScale!=null&&(!Number.isFinite(doc.compose.capture.fontScale)||doc.compose.capture.fontScale<.5||doc.compose.capture.fontScale>3))throw Error('compose.capture.fontScale: 0.5–3');
  const fonts=doc.compose?.capture?.fontHashes;
  if(fonts!=null&&(!fonts||typeof fonts!=='object'||Array.isArray(fonts)||Object.keys(fonts).some(key=>key!=='Roboto')||Object.values(fonts).some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))))throw Error('compose.capture.fontHashes: SHA-256 системного Roboto');
  const curve=doc.compose?.capture?.fontScaleCurve;
  if(curve!=null&&(!Array.isArray(curve)||curve.length!==301||curve[0]!==0||curve.some((n,i)=>!Number.isInteger(n)||n<0||n>45000||(i&&n<curve[i-1]))))throw Error('compose.capture.fontScaleCurve: 301 возрастающих значений в сотых dp');
  for(const metric of Object.values(doc.compose?.capture?.textGeometry||{}))if(metric?.paintInsets!=null){
    const insets=metric.paintInsets;
    if(!insets||typeof insets!=='object'||Array.isArray(insets)||Object.keys(insets).sort().join(',')!=='bottom,left,right,top'||Object.values(insets).some(n=>!Number.isFinite(n)||n<0||n>16000))throw Error('compose.capture.textGeometry.paintInsets: неотрицательные отступы видимой области в dp');
  }
  for(const metric of Object.values(doc.compose?.capture?.textGeometry||{})){if(metric?.textBoxWidth!=null&&(!Number.isFinite(metric.textBoxWidth)||metric.textBoxWidth<0||metric.textBoxWidth>16000))throw Error('compose.capture.textGeometry.textBoxWidth: ширина нативной подписи в dp');if(metric?.fontDp!=null&&(!Number.isFinite(metric.fontDp)||metric.fontDp<=0||metric.fontDp>1000))throw Error('compose.capture.textGeometry.fontDp: нативный размер шрифта в dp');if(metric?.paintVisible!=null&&typeof metric.paintVisible!=='boolean')throw Error('compose.capture.textGeometry.paintVisible: boolean');}
  for(const metric of Object.values(doc.compose?.capture?.textGeometry||{}))if(metric?.lineRanges!=null){
    if(metric.lineAdvance!=null&&(!Number.isFinite(metric.lineAdvance)||metric.lineAdvance<=0||metric.lineAdvance>1000))throw Error('compose.capture.textGeometry.lineAdvance: расстояние между строками в dp');
    const lines=metric.lineRanges;
    if(metric.lineWidths!=null&&(!Array.isArray(metric.lineWidths)||metric.lineWidths.length!==lines.length||metric.lineWidths.some(width=>!Number.isFinite(width)||width<0||width>16000)))throw Error('compose.capture.textGeometry.lineWidths: ширины нативных строк в dp');
    if(!Array.isArray(lines)||!lines.length||lines.length>50||typeof metric.text!=='string'||lines.some((line,i)=>!line||Object.keys(line).sort().join(',')!=='ellipsis,end,start'||!Number.isInteger(line.start)||!Number.isInteger(line.end)||line.start<0||line.end<line.start||line.end>metric.text.length||typeof line.ellipsis!=='boolean'||(i&&line.start<lines[i-1].end)))throw Error('compose.capture.textGeometry.lineRanges: границы нативных строк');
  }
  if(doc.layout!=null) {
    if(!doc.layout || typeof doc.layout!=='object' || Array.isArray(doc.layout) || !['free','auto'].includes(doc.layout.mode) || Object.keys(doc.layout).some(k=>!['mode','frames'].includes(k)))throw Error('layout: mode free или auto, необязательные frames');
    if(doc.layout.frames!=null) {
      if(typeof doc.layout.frames!=='object'||Array.isArray(doc.layout.frames))throw Error('layout.frames: объект');
      const map=indexTree(doc.root);
      for(const [id,frame] of Object.entries(doc.layout.frames)) {
        if(!map.has(id)||!frame||frame.parent!==map.get(id).parent || Object.keys(frame).sort().join(',')!=='height,parent,width,x,y')throw Error('layout.frames: ID, родитель и геометрия должны соответствовать дереву');
        for(const key of ['x','y','width','height'])if(!Number.isFinite(frame[key]) || (['width','height'].includes(key)?frame[key]<0||frame[key]>16000:Math.abs(frame[key])>16000))throw Error('layout.frames: геометрия 0–16000, координаты ±16000 dp');
      }
    }
  }
  return doc;
}
export function indexTree(root) {
  const map = new Map();
  function visit(node, parent = null, index = 0) {
    map.set(node.id, { node, parent, index });
    (node.children || []).forEach((child, i) => visit(child, node.id, i));
  }
  visit(root);
  return map;
}
export function diff(base, current) {
  const before = indexTree(base.root), after = indexTree(current.root), changes = [];
  for (const [id, entry] of before) {
    if (!after.has(id)) changes.push({ id, source: entry.node.source || null, operation: 'remove', before: entry.node, after: null });
  }
  for (const [id, entry] of after) {
    const old = before.get(id), source = entry.node.source || old?.node.source || null;
    if (!old) { changes.push({ id, source, operation: 'add', parent: entry.parent, index: entry.index, before: null, after: entry.node }); continue; }
    if (old.parent !== entry.parent) changes.push({ id, source, operation: 'reparent', before: old.parent, after: entry.parent });
    // Order is represented once per container below, so insertions do not imply moves of every sibling.
    if (old.node.type !== entry.node.type) changes.push({ id, source, operation: 'type', before: old.node.type, after: entry.node.type });
    for (const key of new Set([...Object.keys(old.node.props), ...Object.keys(entry.node.props)])) {
      if (JSON.stringify(old.node.props[key]) !== JSON.stringify(entry.node.props[key])) changes.push({ id, source, operation: 'property', property: key, before: old.node.props[key] ?? null, after: entry.node.props[key] ?? null });
    }
    const prevOrder = (old.node.children || []).map(n => n.id), nextOrder = (entry.node.children || []).map(n => n.id);
    if (JSON.stringify(prevOrder) !== JSON.stringify(nextOrder)) changes.push({ id, source, operation: 'children', before: prevOrder, after: nextOrder });
  }
  for (const key of ['name', 'viewport', 'state', 'layout']) {
    if (JSON.stringify(base[key]) !== JSON.stringify(current[key])) changes.push({ operation: 'document', property: key, before: base[key] ?? null, after: current[key] ?? null });
  }
  const technical = changes.filter(change => change.operation === 'document' && change.property === 'layout');
  const intentChanges = changes.filter(change => !technical.includes(change));
  if ((base.layout?.mode || 'free') !== (current.layout?.mode || 'free')) intentChanges.push({operation:'document',property:'layoutMode',before:base.layout?.mode || 'free',after:current.layout?.mode || 'free'});
  return { schemaVersion: 1, intent: {changes:intentChanges, technical}, ...(base.compose?{transfer:{target:'android-compose',requiresAgent:transferNeeds(base,current)}}:{}), name: current.name, sourceRevision: base.sourceRevision || null, viewport: current.viewport, state: current.state || null, layoutMode: current.layout?.mode || 'free', changes };
}
export function move(doc, id, parentId, position) {
  const next = clone(doc), map = indexTree(next.root), entry = map.get(id), target = map.get(parentId);
  if (!entry || !entry.parent || !target || !CONTAINERS.includes(target.node.type)) throw Error('Нельзя переместить этот элемент сюда');
  if (indexTree(entry.node).has(parentId)) throw Error('Нельзя вложить элемент в самого себя или потомка');
  const previous = map.get(entry.parent).node.children;
  previous.splice(previous.findIndex(n => n.id === id), 1);
  target.node.children ||= [];
  target.node.children.splice(Math.max(0, Math.min(position, target.node.children.length)), 0, entry.node);
  if(next.layout?.frames && (entry.parent!==parentId || target.node.children.findIndex(n=>n.id===id)!==entry.index))delete next.layout.frames;
  return validate(next);
}
export class History {
  constructor(doc) { this.past = []; this.future = []; this.current = clone(doc); }
  static restore(doc, state) {
    const history=new History(doc);
    if(state==null)return history;
    if(!state||!Array.isArray(state.past)||!Array.isArray(state.future)||state.past.length>100||state.future.length>100||state.past.length+state.future.length>100||JSON.stringify(state.current)!==JSON.stringify(doc))throw Error('История не соответствует текущему черновику');
    for(const value of [...state.past,...state.future]){validate(value);if(value.sourceRevision!==doc.sourceRevision||value.root.id!==doc.root.id)throw Error('История относится к другому исходнику');}
    history.past=clone(state.past);history.future=clone(state.future);return history;
  }
  snapshot(maxBytes=8_000_000){
    const value={past:this.past,current:this.current,future:this.future},bytes=()=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
    while(bytes()>maxBytes&&(this.past.length||this.future.length)){if(this.past.length>=this.future.length)this.past.shift();else this.future.shift();}
    return clone(value);
  }
  commit(doc) {
    validate(doc);
    if (JSON.stringify(doc) === JSON.stringify(this.current)) return false;
    this.past.push(clone(this.current)); this.past = this.past.slice(-100); this.current = clone(doc); this.future = []; return true;
  }
  undo() { if (this.past.length) { this.future.push(this.current); this.current = this.past.pop(); } return this.current; }
  redo() { if (this.future.length) { this.past.push(this.current); this.current = this.future.pop(); } return this.current; }
}
