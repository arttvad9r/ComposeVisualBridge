export const TYPES = ['Column', 'Row', 'Box', 'Card', 'Text', 'Button', 'TextField', 'Switch', 'Icon', 'Image', 'Spacer'];
export const CONTAINERS = ['Column', 'Row', 'Box', 'Card'];
export const clone = value => JSON.parse(JSON.stringify(value));
const numeric = { offsetX: [-4000, 4000], offsetY: [-4000, 4000], width: [0, 4000], height: [0, 4000], padding: [0, 300], paddingHorizontal: [0, 300], paddingVertical: [0, 300], gap: [0, 300], fontSize: [6, 100], lineHeight: [6, 150], fontWeight: [100, 900], borderWidth: [0, 10], radius: [0, 200], weight: [0, 100], opacity: [0, 1] };
export function validate(doc) {
  if (!doc || doc.schemaVersion !== 1) throw Error('Нужен schemaVersion: 1');
  if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 200) throw Error('Нужно название макета (до 200 символов)');
  if (!doc.viewport || !Number.isFinite(doc.viewport.width) || doc.viewport.width < 200 || doc.viewport.width > 1500 || !Number.isFinite(doc.viewport.height) || doc.viewport.height < 200 || doc.viewport.height > 2000) throw Error('Viewport: ширина 200–1500, высота 200–2000 dp');
  if (doc.sourceRevision != null && typeof doc.sourceRevision !== 'string') throw Error('sourceRevision должен быть строкой');
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
        if (!Number.isFinite(value) || value < lo || value > hi) throw Error(`${n.id}.${key}: допустимо ${lo}–${hi}`);
      } else if (key === 'align') {
        if (!['start', 'center', 'end', 'stretch'].includes(value)) throw Error('align: start, center, end, stretch');
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
        if (typeof value !== 'string' || value.length > 5000) throw Error(`${key}: строка до 5000 символов`);
        if (key === 'src' && value && !/^https:\/\//.test(value)) throw Error('Image.src: только https URL');
      } else if (['checked', 'scrollable'].includes(key)) {
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
  return { schemaVersion: 1, name: current.name, sourceRevision: base.sourceRevision || null, viewport: current.viewport, state: current.state || null, layoutMode: current.layout?.mode || 'free', changes };
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
  commit(doc) {
    validate(doc);
    if (JSON.stringify(doc) === JSON.stringify(this.current)) return false;
    this.past.push(clone(this.current)); this.past = this.past.slice(-100); this.current = clone(doc); this.future = []; return true;
  }
  undo() { if (this.past.length) { this.future.push(this.current); this.current = this.past.pop(); } return this.current; }
  redo() { if (this.future.length) { this.past.push(this.current); this.current = this.future.pop(); } return this.current; }
}
