import { writeTextAtomic } from './storage.mjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validate, indexTree, clone, diff } from './public/model.mjs';
import { COMPOSE_TYPES, composeCapability } from './public/compose-capabilities.mjs';
import { MODIFIER_MODEL, outerModifierProps, kotlinModifierProps, modifierMetrics } from './public/modifier-layout.mjs';
import { sourceRevision } from './scripts/native-project.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const supported = new Set(COMPOSE_TYPES);
const containers = new Set(['Column', 'Row', 'Box', 'Card', 'Surface']);
const positionals = {
  Text: ['text', 'modifier', 'color', 'fontSize'],
  Column: ['modifier', 'verticalArrangement', 'horizontalAlignment'],
  Row: ['modifier', 'horizontalArrangement', 'verticalAlignment'],
  Box: ['modifier', 'contentAlignment'],
  Card: ['modifier'],
  Button: ['onClick', 'modifier'],
  Spacer: ['modifier'],
  Surface: ['modifier', 'color'],
};
const error = (message, file, line) => {
  throw Error(`${file || 'Compose'}${line ? ':' + line : ''}: ${message}`);
};
export function kotlinTokens(code) {
  const out = [];
  let i = 0,
    line = 1;
  while (i < code.length) {
    let start = i,
      l = line,
      c = code[i];
    if (/\s/.test(c)) {
      if (c === '\n') line++;
      i++;
      continue;
    }
    if (code.startsWith('//', i)) {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (code.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < code.length && depth) {
        if (code.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (code.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          if (code[i] === '\n') line++;
          i++;
        }
      }
      if (depth) error('Незакрытый комментарий');
      continue;
    }
    if (c === '"' || c === "'") {
      const raw = code.startsWith('"""', i),
        quote = raw ? '"""' : c;
      i += quote.length;
      let closed = false;
      while (i < code.length) {
        if (code.startsWith(quote, i)) {
          i += quote.length;
          closed = true;
          break;
        }
        if (!raw && code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === '\n') line++;
        i++;
      }
      if (!closed) error('Незакрытая строка');
      out.push({ v: code.slice(start, i), start, end: i, line: l, string: true });
      continue;
    }
    const ident = code.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u),
      number = code.slice(i).match(/^\d+(?:\.\d+)?/);
    if (ident || number) i += (ident || number)[0].length;
    else i++;
    out.push({ v: code.slice(start, i), start, end: i, line: l });
  }
  return out;
}
function pairs(tokens) {
  const map = new Map(),
    stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].v;
    if (['(', '{', '['].includes(v)) stack.push(i);
    else if ([')', '}', ']'].includes(v)) {
      const start = stack.pop();
      if (start === undefined || '({['.indexOf(tokens[start].v) !== ')}]'.indexOf(v)) error('Несогласованные скобки');
      map.set(start, i);
    }
  }
  if (stack.length) error('Незакрытые скобки');
  return map;
}
function argsOf(code, tokens, start, end, pair, type) {
  const result = [];
  let from = start;
  for (let i = start; i <= end; i++) {
    if (i === end || tokens[i].v === ',') {
      if (i > from) {
        let named = tokens[from + 1]?.v === '=',
          name = named
            ? tokens[from].v
            : positionals[type]?.[result.filter(a => !a.named).length] ||
              (type === '$modifier' ? '#' + result.length : undefined);
        if (!name) error('Неизвестный позиционный аргумент ' + type);
        result.push({
          name,
          named,
          start: tokens[from].start,
          end: tokens[i - 1].end,
          valueStart: tokens[named ? from + 2 : from].start,
          valueEnd: tokens[i - 1].end,
          value: code.slice(tokens[named ? from + 2 : from].start, tokens[i - 1].end),
        });
      }
      from = i + 1;
    } else if (pair.has(i)) i = pair.get(i);
  }
  if (new Set(result.map(a => a.name)).size !== result.length) error('Повторный аргумент');
  return result;
}
function literal(value, parameters, resources) {
  value = value?.trim();
  if (value === undefined) return undefined;
  if (value in parameters) return parameters[value];
  if (value?.startsWith('"') && !value.includes('$')) {
    if (value.startsWith('"""')) return value.slice(3, -3);
    try {
      return JSON.parse(value);
    } catch {
      error('Строка с неподдерживаемым escape');
    }
  }
  const number = value?.match(/^(-?\d+(?:\.\d+)?)(?:\.(dp|sp))?$/);
  if (number) return Number(number[1]);
  if (value === 'true' || value === 'false') return value === 'true';
  const resource = value?.match(/^stringResource\(\s*(?:id\s*=\s*)?R\.string\.([\w]+)\s*\)$/);
  if (resource && resource[1] in resources) return resources[resource[1]];
  error('Нужно значение для выражения ' + value);
}
function color(value) {
  const m = value?.match(/^(?:androidx\.compose\.ui\.graphics\.)?Color\(0x(?:FF)?([a-fA-F0-9]{6})\)$/);
  if (m) return '#' + m[1].toUpperCase();
  if (value === 'Color.Black') return '#000000';
  if (value === 'Color.White') return '#FFFFFF';
  error('Неподдерживаемое выражение цвета ' + value);
}
function alignment(value) {
  if (!value) return undefined;
  const last = value.split('.').at(-1);
  if (last === 'SpaceBetween') return 'space-between';
  if (/Center/.test(last)) return 'center';
  if (/End|Right|Bottom/.test(last)) return 'end';
  if (/Start|Left|Top/.test(last)) return 'start';
  error('Неизвестное выравнивание ' + value);
}
function modifierProps(expression, parameters, resources) {
  const props = {};
  if (!expression) return props;
  const resolved = expression.replace(/^[A-Za-z_]\w*/, name => (parameters[name] === 'Modifier' ? 'Modifier' : name));
  const code = resolved,
    t = kotlinTokens(code),
    p = pairs(t);
  if (!/^Modifier\b/.test(code.trim())) error('Modifier должен быть явным: ' + expression);
  let cursor = 1;
  while (cursor < t.length) {
    if (t[cursor].v !== '.' || !p.has(cursor + 2)) error('Неподдерживаемая цепочка Modifier');
    const name = t[cursor + 1].v,
      end = p.get(cursor + 2),
      a = argsOf(code, t, cursor + 3, end, p, '$modifier');
    const values = a.map(x => x.value),
      arg = key => a.find(x => x.name === key)?.value;
    switch (name) {
      case 'fillMaxSize':
      case 'fillMaxWidth':
      case 'fillMaxHeight':
        if (values.length && values[0] !== '1f' && values[0] !== '1.0f') error('Не поддерживается дробный fill');
        if (name !== 'fillMaxHeight') props.width = 'fill';
        if (name !== 'fillMaxWidth') props.height = 'fill';
        break;
      case 'width':
      case 'height':
      case 'requiredWidth':
      case 'requiredHeight':
        props[name.toLowerCase().includes('width') ? 'width' : 'height'] = literal(values[0], parameters, resources);
        break;
      case 'size':
      case 'requiredSize':
        props.width = literal(arg('width') || values[0], parameters, resources);
        props.height = literal(arg('height') || values[1] || values[0], parameters, resources);
        break;
      case 'padding':
        if (a.length === 1 && !a[0].named) props.padding = literal(values[0], parameters, resources);
        else if (a.every(x => ['horizontal', 'vertical'].includes(x.name))) {
          if (arg('horizontal')) props.paddingHorizontal = literal(arg('horizontal'), parameters, resources);
          if (arg('vertical')) props.paddingVertical = literal(arg('vertical'), parameters, resources);
        } else error('Нужен адаптер для несимметричных padding');
        break;
      case 'offset':
        props.offsetX = literal(arg('x') || values[0] || '0', parameters, resources);
        props.offsetY = literal(arg('y') || values[1] || '0', parameters, resources);
        break;
      case 'background':
        props.background = color(arg('color') || values[0]);
        if (values.length > 1) error('background с shape требует отдельного адаптера');
        break;
      case 'alpha':
        props.opacity = literal(values[0]?.replace(/f$/, ''), parameters, resources);
        break;
      case 'clipToBounds':
        props.clipContent = true;
        break;
      case 'weight':
        props.weight = literal(values[0]?.replace(/f$/, ''), parameters, resources);
        break;
      case 'clip': {
        const radius = values[0]?.match(/^RoundedCornerShape\((.+)\)$/);
        if (!radius) error('Не поддерживается shape ' + values[0]);
        props.radius = literal(radius[1], parameters, resources);
        break;
      }
      case 'border':
        props.borderWidth = literal(values[0], parameters, resources);
        props.borderColor = color(values[1]);
        if (values.length > 2) error('border с shape требует адаптера');
        break;
      case 'verticalScroll':
        if (
          !/^(?:androidx\.compose\.foundation\.)?rememberScrollState\(\)$/.test(values[0] || '') ||
          values.length !== 1
        )
          error('Нужен адаптер состояния прокрутки');
        props.scrollable = true;
        break;
      case 'testTag':
        break;
      default:
        error('Нужен адаптер Modifier.' + name);
    }
    cursor = end + 1;
  }
  return props;
}
function modifierLayout(expression) {
  const tokens = kotlinTokens(expression || 'Modifier'),
    pair = pairs(tokens),
    order = [];
  const groups = {
    width: ['width'],
    requiredWidth: ['width'],
    fillMaxWidth: ['width'],
    height: ['height'],
    requiredHeight: ['height'],
    fillMaxHeight: ['height'],
    size: ['width', 'height'],
    requiredSize: ['width', 'height'],
    fillMaxSize: ['width', 'height'],
    padding: ['padding'],
    offset: ['offset'],
    background: ['background'],
    alpha: ['opacity'],
    clip: ['radius'],
    border: ['border'],
    weight: ['weight'],
    clipToBounds: ['clipContent'],
    verticalScroll: ['scrollable'],
  };
  for (let i = 1; i < tokens.length; i++)
    if (tokens[i].v === '.' && pair.has(i + 2)) {
      order.push(...(groups[tokens[i + 1].v] || []));
      i = pair.get(i + 2);
    }
  if (order.filter(group => group === 'padding').length > 1) error('Нужен адаптер для повторяющихся Modifier.padding');
  return { order };
}
export function parseCompose(code, { file = 'Screen.kt', symbol, parameters = {}, resources = {} } = {}) {
  const t = kotlinTokens(code),
    pair = pairs(t);
  for (let i = 0; i < t.length; i++)
    if (['fun', 'class', 'object'].includes(t[i].v) && supported.has(t[i + 1]?.v))
      error('Имя стандартного компонента переопределено: ' + t[i + 1].v, file, t[i].line);
  for (const match of code.matchAll(/^import\s+([^\s;]+)(?:\s+as\s+(\w+))?/gm)) {
    const name = match[2] || match[1].split('.').at(-1);
    if (supported.has(name) && !match[1].startsWith('androidx.compose.'))
      error('Неизвестный импорт компонента ' + name, file);
  }
  let header = -1;
  for (let i = 0; i < t.length; i++)
    if (t[i].v === 'fun' && t[i + 1]?.v === symbol && t[i + 2]?.v === '(') {
      if (header !== -1) error('Перегрузка функции требует разрешения', file);
      header = i;
    }
  if (header < 0) error('Не найдена функция ' + symbol, file);
  const close = pair.get(header + 2),
    bodyStart = close + 1;
  if (t[bodyStart]?.v !== '{') error('Нужна функция с блочным телом', file);
  const bodyEnd = pair.get(bodyStart),
    bindings = {};
  function block(start, end, parentPath) {
    const nodes = [];
    for (let i = start; i < end; ) {
      const token = t[i],
        type = token.v;
      if (!supported.has(type)) error('Нужен адаптер конструкции ' + type, file, token.line);
      if (t[i - 1]?.v === '.') error('Квалифицированные вызовы требуют адаптера', file, token.line);
      let args = [],
        next = i + 1,
        content = null;
      if (t[next]?.v === '(') {
        const finish = pair.get(next);
        args = argsOf(code, t, next + 1, finish, pair, type);
        next = finish + 1;
      }
      if (t[next]?.v === '{') {
        const finish = pair.get(next);
        content = { start: t[next].start, end: t[finish].end };
        const child = block(next + 1, finish, parentPath + '.' + nodes.length);
        next = finish + 1;
        content.nodes = child;
      }
      const endPosition = t[next - 1].end,
        id = 'k' + hash(file + '\0' + symbol + '\0' + parentPath + '.' + nodes.length).slice(0, 16),
        values = Object.fromEntries(args.map(a => [a.name, a.value]));
      let props = modifierProps(values.modifier, parameters, resources);
      const known = {
        Text: [
          'text',
          'modifier',
          'style',
          'color',
          'fontSize',
          'fontWeight',
          'fontFamily',
          'fontStyle',
          'textDecoration',
          'overflow',
          'lineHeight',
          'letterSpacing',
          'textAlign',
          'maxLines',
        ],
        Column: ['modifier', 'verticalArrangement', 'horizontalAlignment'],
        Row: ['modifier', 'horizontalArrangement', 'verticalAlignment'],
        Box: ['modifier', 'contentAlignment'],
        Card: ['modifier'],
        Button: ['onClick', 'modifier', 'enabled'],
        Spacer: ['modifier'],
        Surface: ['modifier', 'color'],
      };
      for (const key of Object.keys(values))
        if (!known[type].includes(key)) error('Нужен адаптер ' + type + '.' + key, file, token.line);
      let runtimeText = false;
      if (type === 'Text') {
        try {
          props.text = literal(values.text, parameters, resources);
        } catch (e) {
          if (!values.text || values.text.startsWith('"')) throw e;
          props.text = '';
          runtimeText = true;
        }
        for (const key of ['fontSize', 'lineHeight', 'letterSpacing', 'maxLines'])
          if (values[key]) props[key] = literal(values[key], parameters, resources);
        if (values.style && !/^MaterialTheme\.typography\.[A-Za-z]+$/.test(values.style))
          error('Нужен адаптер стиля ' + values.style, file, token.line);
        if (values.color && !/^MaterialTheme\.colorScheme\.[A-Za-z]+$/.test(values.color))
          props.color = color(values.color);
        if (values.fontWeight) {
          const weights = { Normal: 400, Medium: 500, SemiBold: 600, Bold: 700 };
          props.fontWeight =
            weights[values.fontWeight.split('.').at(-1)] ||
            literal(
              values.fontWeight.replace(/^(?:androidx\.compose\.ui\.text\.font\.)?FontWeight\((.+)\)$/, '$1'),
              parameters,
              resources,
            );
        }
        if (values.fontFamily) {
          const family = {
            Default: 'system',
            SansSerif: 'Roboto',
            Serif: 'Serif',
            Monospace: 'Monospace',
            Cursive: 'Cursive',
          }[values.fontFamily.split('.').at(-1)];
          if (!family) error('Нужен адаптер шрифта ' + values.fontFamily);
          props.fontFamily = family;
        }
        if (values.fontStyle) props.fontStyle = values.fontStyle.endsWith('.Italic') ? 'italic' : 'normal';
        if (values.textDecoration) {
          if (!/\.(Underline|None)$/.test(values.textDecoration)) error('Нужен адаптер оформления текста');
          props.textDecoration = values.textDecoration.endsWith('.Underline') ? 'underline' : 'none';
        }
        if (values.overflow) props.textOverflow = values.overflow.endsWith('.Ellipsis') ? 'ellipsis' : 'clip';
        if (values.textAlign) props.textAlign = alignment(values.textAlign);
      }
      if (type === 'Column' || type === 'Row') {
        const arrange = values[type === 'Column' ? 'verticalArrangement' : 'horizontalArrangement'];
        if (arrange) {
          const gap = arrange.match(/^(?:androidx\.compose\.foundation\.layout\.)?Arrangement\.spacedBy\((.+)\)$/);
          if (gap) props.gap = literal(gap[1], parameters, resources);
          else props.justify = alignment(arrange);
        }
        const align = values[type === 'Column' ? 'horizontalAlignment' : 'verticalAlignment'];
        props.align = align ? alignment(align) : 'start';
      }
      if (type === 'Surface' && values.color) props.background = color(values.color);
      if (type === 'Box' && values.contentAlignment) error('Box contentAlignment требует адаптера', file, token.line);
      let children = content?.nodes || [];
      let label = null;
      if (type === 'Button') {
        if (children.length !== 1 || children[0].type !== 'Text')
          error('Button должен иметь один текстовый label', file, token.line);
        label = children[0].id;
        props = { ...children[0].props, ...props };
        children = [];
        if (values.enabled) props.enabled = literal(values.enabled, parameters, resources);
      }
      if (!containers.has(type) && type !== 'Button' && children.length) error('У листа есть дети', file, token.line);
      const layout = modifierLayout(values.modifier);
      props = outerModifierProps(props, { modifierLayout: layout });
      const node = {
        id,
        type: type === 'Surface' ? 'Box' : type,
        props,
        source: { file, symbol, line: token.line, instance: parentPath + '.' + nodes.length },
        ...(containers.has(type) ? { children } : {}),
      };
      bindings[id] = {
        runtimeText,
        start: token.start,
        end: endPosition,
        type: node.type,
        callType: type,
        args,
        modifierLayout: layout,
        content: content ? { start: content.start, end: content.end } : null,
        label,
        raw: code.slice(token.start, endPosition),
      };
      nodes.push(node);
      i = next;
    }
    return nodes;
  }
  const roots = block(bodyStart + 1, bodyEnd, 'root');
  if (roots.length !== 1) error('Нужен один корневой контейнер', file);
  return {
    root: roots[0],
    bindings,
    body: { start: t[bodyStart].end, end: t[bodyEnd].start },
    fileHash: hash(code),
    modifierModel: MODIFIER_MODEL,
  };
}
function checkedFile(workspace, file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !file.endsWith('.kt'))
    error('Нужен относительный Kotlin-путь');
  return path.join(workspace, file);
}
export async function importCompose({
  workspace,
  file,
  symbol,
  parameters = {},
  resources = {},
  viewport = { width: 360, height: 640 },
}) {
  const root = await realpath(workspace),
    target = await realpath(checkedFile(root, file));
  if (!target.startsWith(root + path.sep)) error('Исходник выходит из рабочей копии');
  const code = await readFile(target, 'utf8'),
    parsed = parseCompose(code, { file, symbol, parameters, resources });
  const document = {
    schemaVersion: 1,
    name: symbol,
    sourceRevision: parsed.fileHash,
    viewport,
    layout: { mode: 'auto' },
    state: parameters,
    root: parsed.root,
    compose: {
      format: 'compose-visual-bridge-compose-v1',
      modifierModel: MODIFIER_MODEL,
      workspace: root,
      file,
      symbol,
      fileHash: parsed.fileHash,
      workspaceRevision: await sourceRevision(root),
      parameters,
      resources,
      bindings: parsed.bindings,
      body: parsed.body,
    },
  };
  validate(document);
  document.compose.initial = clone(document.root);
  return document;
}
const dp = n => `${Number(n)}.dp`,
  str = s => JSON.stringify(s).replaceAll('$', '\\$');
function modifierChanges(original, before, after) {
  const expression = original || 'Modifier';
  const changed = key => JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  const mapping = {
    width: ['width'],
    requiredWidth: ['width'],
    height: ['height'],
    requiredHeight: ['height'],
    size: ['width', 'height'],
    requiredSize: ['width', 'height'],
    fillMaxSize: ['width', 'height'],
    fillMaxWidth: ['width'],
    fillMaxHeight: ['height'],
    padding: ['padding', 'paddingHorizontal', 'paddingVertical'],
    offset: ['offsetX', 'offsetY'],
    background: ['background'],
    alpha: ['opacity'],
    clip: ['radius'],
    border: ['borderWidth', 'borderColor'],
    weight: ['weight'],
    clipToBounds: ['clipContent'],
    verticalScroll: ['scrollable'],
  };
  const groups = [
    ['width'],
    ['height'],
    ['padding', 'paddingHorizontal', 'paddingVertical'],
    ['offsetX', 'offsetY'],
    ['background'],
    ['opacity'],
    ['radius'],
    ['borderWidth', 'borderColor'],
    ['weight'],
    ['clipContent'],
    ['scrollable'],
  ];
  if (!groups.some(keys => keys.some(changed))) return expression;
  const tokens = kotlinTokens(expression),
    pair = pairs(tokens),
    calls = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].v !== '.' || !pair.has(i + 2)) continue;
    const name = tokens[i + 1].v,
      end = pair.get(i + 2);
    if (mapping[name]) calls.push({ name, keys: mapping[name], start: tokens[i].start, end: tokens[end].end });
    i = end;
  }
  const handled = new Set(),
    edits = [];
  const render = (keys, name) => {
    let value = '';
    const append = (call, args) => {
      value += `.${call}(${args})`;
    };
    if (keys.includes('width') || keys.includes('height')) {
      for (const key of keys) {
        if (after[key] === 'fill') append(key === 'width' ? 'fillMaxWidth' : 'fillMaxHeight', '');
        else if (typeof after[key] === 'number')
          append(
            name === 'requiredWidth' || name === 'requiredHeight' || name === 'requiredSize'
              ? key === 'width'
                ? 'requiredWidth'
                : 'requiredHeight'
              : key,
            dp(after[key]),
          );
      }
    } else if (keys.includes('padding')) {
      const horizontal = after.paddingHorizontal ?? after.padding ?? 0;
      const vertical = after.paddingVertical ?? after.padding ?? 0;
      if (keys.some(key => after[key] !== undefined)) {
        if (horizontal === vertical) append('padding', dp(horizontal));
        else append('padding', `horizontal = ${dp(horizontal)}, vertical = ${dp(vertical)}`);
      }
    } else if (keys.includes('offsetX')) {
      if (after.offsetX !== undefined || after.offsetY !== undefined)
        append('offset', `x = ${dp(after.offsetX || 0)}, y = ${dp(after.offsetY || 0)}`);
    } else if (keys.includes('background')) {
      if (after.background)
        append('background', `androidx.compose.ui.graphics.Color(0xFF${after.background.slice(1)})`);
    } else if (keys.includes('opacity')) {
      if (after.opacity !== undefined) append('alpha', `${after.opacity}f`);
    } else if (keys.includes('radius')) {
      if (after.radius !== undefined)
        append('clip', `androidx.compose.foundation.shape.RoundedCornerShape(${dp(after.radius)})`);
    } else if (keys.includes('borderWidth')) {
      if (after.borderWidth)
        append(
          'border',
          `${dp(after.borderWidth)}, androidx.compose.ui.graphics.Color(0xFF${(after.borderColor || '#D6D9D3').slice(1)})`,
        );
    } else if (keys.includes('weight')) {
      if (after.weight) append('weight', `${after.weight}f`);
    } else if (keys.includes('clipContent')) {
      if (after.clipContent) append('clipToBounds', '');
    } else if (keys.includes('scrollable')) {
      if (after.scrollable) append('verticalScroll', 'androidx.compose.foundation.rememberScrollState()');
    }
    return value;
  };
  for (const call of calls) {
    if (!call.keys.some(changed)) continue;
    // Repeated overlapping modifiers cannot be represented by a single props value.
    if (calls.some(other => other !== call && other.keys.some(key => call.keys.includes(key)))) {
      error('Неоднозначная цепочка Modifier.' + call.name + ': перенос должен выполнить агент');
    }
    call.keys.forEach(key => handled.add(key));
    edits.push({ ...call, text: render(call.keys, call.name) });
  }
  let result = expression;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  for (const keys of groups) if (keys.some(changed) && !keys.some(key => handled.has(key))) result += render(keys);
  return result;
}

export function composePatch(code, baseline, current) {
  if (baseline.compose?.format === 'compose-visual-bridge-runtime-scene-v1')
    error('Runtime-сцену переносит агент, автоматический Kotlin-патч запрещён');
  validate(baseline);
  validate(current);
  const meta = baseline.compose;
  if (meta?.format !== 'compose-visual-bridge-compose-v1' || meta.fileHash !== hash(code))
    error('Исходник изменился; импортируйте актуальную ревизию');
  if (JSON.stringify(meta) !== JSON.stringify(current.compose)) error('Связь с Kotlin изменена');
  if (
    meta.modifierModel !== MODIFIER_MODEL &&
    (JSON.stringify(baseline.root) !== JSON.stringify(current.root) ||
      JSON.stringify(baseline.layout) !== JSON.stringify(current.layout))
  )
    error(
      'Старый Compose-импорт не содержит модель внешних размеров. Повторно импортируйте сцену в отдельную сессию, сохранив прежний черновик.',
    );
  const before = indexTree(baseline.root),
    after = indexTree(current.root),
    operations = [];
  if ((current.state?.paletteInsertions || []).some(item => !before.has(item.id)))
    error('Собственный компонент палитры подключает агент по исходникам проекта');
  const free = current.layout?.mode === 'free';
  if (free && !current.layout.frames) error('Для свободного переноса нужна геометрия всех элементов');

  function render(node, level = 1, parent = null) {
    const binding = meta.bindings[node.id],
      previous = before.get(node.id)?.node;
    let type = node.type,
      argumentsMap = new Map(binding?.args.map(a => [a.name, a.value]) || []),
      oldProps = previous?.props || {};
    if (!supported.has(type)) error('Нет Kotlin-адаптера для ' + type);
    if (binding && binding.type !== type) error('Изменение типа существующего компонента требует адаптера');
    const stretchAxis =
      !free && parent?.props.align === 'stretch'
        ? parent.type === 'Column'
          ? 'width'
          : parent.type === 'Row'
            ? 'height'
            : null
        : null;
    const stretched = stretchAxis && (node.props[stretchAxis] === undefined || node.props[stretchAxis] === 'auto');
    if (!free && !stretched && previous && JSON.stringify(previous) === JSON.stringify(node))
      return '    '.repeat(level) + binding.raw;
    for (const key of new Set([...Object.keys(oldProps), ...Object.keys(node.props)]))
      if (JSON.stringify(oldProps[key]) !== JSON.stringify(node.props[key])) {
        const capability = composeCapability(type, key, node.props[key]);
        if (capability.mode === 'agent') error(capability.reason);
        operations.push({ nodeId: node.id, property: key, before: oldProps[key], after: node.props[key] });
      }
    let props = stretched ? { ...node.props, [stretchAxis]: 'fill' } : node.props,
      labelBinding = binding?.label ? meta.bindings[binding.label] : null,
      labelArgs = new Map(labelBinding?.args.map(a => [a.name, a.value]) || []),
      targetArgs = type === 'Button' ? labelArgs : argumentsMap;
    if (type === 'Text' || type === 'Button') {
      for (const key of [
        'text',
        'fontSize',
        'lineHeight',
        'letterSpacing',
        'fontWeight',
        'fontFamily',
        'fontStyle',
        'textDecoration',
        'textOverflow',
        'color',
        'textAlign',
        'maxLines',
      ])
        if (!previous || JSON.stringify(oldProps[key]) !== JSON.stringify(props[key])) {
          const value = props[key];
          if (key === 'text' && previous && targetArgs.has('text') && !targetArgs.get('text').trim().startsWith('"'))
            error(
              'Текст связан с ресурсом/состоянием; агент должен разрешить изменение выражения ' +
                targetArgs.get('text'),
            );
          if (value === undefined) {
            targetArgs.delete(key === 'textOverflow' ? 'overflow' : key);
            continue;
          }
          if (key === 'fontFamily' && value === 'Roboto Flex') error('Для Roboto Flex нужен ресурсный адаптер');
          targetArgs.set(
            key === 'textOverflow' ? 'overflow' : key,
            key === 'text'
              ? str(value)
              : ['fontSize', 'lineHeight', 'letterSpacing'].includes(key)
                ? `${value}.sp`
                : key === 'fontWeight'
                  ? `androidx.compose.ui.text.font.FontWeight(${value})`
                  : key === 'fontFamily'
                    ? `androidx.compose.ui.text.font.FontFamily.${{ system: 'Default', Roboto: 'SansSerif', 'Sans Serif': 'SansSerif', Serif: 'Serif', Monospace: 'Monospace', Cursive: 'Cursive' }[value]}`
                    : key === 'fontStyle'
                      ? `androidx.compose.ui.text.font.FontStyle.${value === 'italic' ? 'Italic' : 'Normal'}`
                      : key === 'textDecoration'
                        ? `androidx.compose.ui.text.style.TextDecoration.${value === 'underline' ? 'Underline' : 'None'}`
                        : key === 'textOverflow'
                          ? `androidx.compose.ui.text.style.TextOverflow.${value === 'ellipsis' ? 'Ellipsis' : 'Clip'}`
                          : key === 'color'
                            ? `androidx.compose.ui.graphics.Color(0xFF${value.slice(1)})`
                            : key === 'textAlign'
                              ? `androidx.compose.ui.text.style.TextAlign.${{ start: 'Start', center: 'Center', end: 'End', justify: 'Justify' }[value]}`
                              : String(value),
          );
        }
    }
    if (binding?.callType === 'Surface' && oldProps.background !== props.background) {
      if (props.background)
        argumentsMap.set('color', `androidx.compose.ui.graphics.Color(0xFF${props.background.slice(1)})`);
      else argumentsMap.delete('color');
    }
    const nativeOld = meta.modifierModel === MODIFIER_MODEL ? kotlinModifierProps(oldProps, binding) : oldProps;
    const nativeNext = meta.modifierModel === MODIFIER_MODEL ? kotlinModifierProps(props, binding) : props;
    const mod = modifierChanges(
      argumentsMap.get('modifier'),
      nativeOld,
      binding?.callType === 'Surface' ? { ...nativeNext, background: nativeOld.background } : nativeNext,
    );
    if (mod !== 'Modifier' || argumentsMap.has('modifier')) argumentsMap.set('modifier', mod);
    if (type === 'Column' || type === 'Row') {
      const arrangement = type === 'Column' ? 'verticalArrangement' : 'horizontalArrangement',
        alignmentKey = type === 'Column' ? 'horizontalAlignment' : 'verticalAlignment';
      if (!previous || oldProps.gap !== props.gap || oldProps.justify !== props.justify) {
        if (props.gap)
          argumentsMap.set(arrangement, `androidx.compose.foundation.layout.Arrangement.spacedBy(${dp(props.gap)})`);
        else if (props.justify)
          argumentsMap.set(
            arrangement,
            `androidx.compose.foundation.layout.Arrangement.${{ start: type === 'Column' ? 'Top' : 'Start', center: 'Center', end: type === 'Column' ? 'Bottom' : 'End', 'space-between': 'SpaceBetween' }[props.justify]}`,
          );
        else argumentsMap.delete(arrangement);
      }
      if (!previous || oldProps.align !== props.align) {
        const align = props.align;
        if (align)
          argumentsMap.set(
            alignmentKey,
            `androidx.compose.ui.Alignment.${type === 'Column' ? { start: 'Start', center: 'CenterHorizontally', end: 'End', stretch: 'Start' }[align] : { start: 'Top', center: 'CenterVertically', end: 'Bottom', stretch: 'Top' }[align]}`,
          );
        else argumentsMap.delete(alignmentKey);
      }
    }
    if (type === 'Button') {
      if (!binding) argumentsMap.set('onClick', '{}');
      if (!previous || oldProps.enabled !== props.enabled) {
        if (props.enabled !== undefined) argumentsMap.set('enabled', String(props.enabled));
        else argumentsMap.delete('enabled');
      }
    }
    if (free) {
      if (meta.modifierModel === MODIFIER_MODEL && containers.has(type) && props.background) {
        const inset = modifierMetrics(props, binding).backgroundInset;
        if (inset.horizontal || inset.vertical)
          error('Свободный перенос контейнера с background после padding требует адаптера агента');
      }
      if (type === 'Text' || type === 'Button') {
        if (props.maxLines) targetArgs.set('maxLines', String(props.maxLines));
        if (props.textOverflow)
          targetArgs.set(
            'overflow',
            `androidx.compose.ui.text.style.TextOverflow.${props.textOverflow === 'ellipsis' ? 'Ellipsis' : 'Clip'}`,
          );
      }
      const frame = current.layout.frames[node.id];
      if (!frame) error('Нет геометрии ' + node.id);
      const frozen = {
        ...props,
        width: typeof props.width === 'number' || props.width === 'auto' ? props.width : frame.width,
        height: typeof props.height === 'number' || props.height === 'auto' ? props.height : frame.height,
      };
      let base = modifierChanges(argumentsMap.get('modifier'), props, { ...props, weight: undefined });
      if (containers.has(type)) {
        const tokens = kotlinTokens(base),
          pairsMap = pairs(tokens),
          removals = [];
        for (let i = 1; i < tokens.length; i++) {
          if (tokens[i].v === '.' && tokens[i + 1]?.v === 'padding' && pairsMap.has(i + 2)) {
            const end = pairsMap.get(i + 2);
            removals.push({ start: tokens[i].start, end: tokens[end].end });
            i = end;
          }
        }
        for (const r of removals.reverse()) base = base.slice(0, r.start) + base.slice(r.end);
      }
      const x = frame.parent === null ? 0 : frame.x + (props.offsetX || 0),
        y = frame.parent === null ? 0 : frame.y + (props.offsetY || 0);
      const nativeFrozen =
        meta.modifierModel === MODIFIER_MODEL && !containers.has(type) ? kotlinModifierProps(frozen, binding) : frozen;
      const sized = modifierChanges(
        base,
        { ...props, width: undefined, height: undefined, offsetX: undefined, offsetY: undefined },
        { ...nativeFrozen, offsetX: x, offsetY: y },
      );
      argumentsMap.set('modifier', sized);
      if (type === 'Column' || type === 'Row') {
        type = 'Box';
        argumentsMap.delete('verticalArrangement');
        argumentsMap.delete('horizontalArrangement');
        argumentsMap.delete('horizontalAlignment');
        argumentsMap.delete('verticalAlignment');
      }
    }
    const argsString = map => [...map].map(([key, value]) => `${key} = ${value}`).join(', ');
    const indent = '    '.repeat(level);
    if (type === 'Button') return `${indent}Button(${argsString(argumentsMap)}) { Text(${argsString(labelArgs)}) }`;
    if (containers.has(type)) {
      const content = (node.children || [])
        .map(child => render(child, level + (free && type === 'Card' ? 2 : 1), node))
        .join('\n');
      return `${indent}${binding?.callType === 'Surface' ? 'Surface' : type}(${argsString(argumentsMap)}) {\n${free && type === 'Card' ? indent + '    Box(Modifier.fillMaxSize()) {\n' + content + '\n' + indent + '    }' : content}\n${indent}}`;
    }
    return `${indent}${type}(${argsString(argumentsMap)})`;
  }
  const changedTree =
    JSON.stringify(baseline.root) !== JSON.stringify(current.root) ||
    (JSON.stringify(baseline.layout) !== JSON.stringify(current.layout) &&
      (free || baseline.layout?.mode !== current.layout?.mode));
  if (!changedTree) return { file: meta.file, beforeHash: hash(code), afterHash: hash(code), code, operations: [] };
  const body = '\n' + render(current.root) + '\n';
  let result = code.slice(0, meta.body.start) + body + code.slice(meta.body.end);
  const packageMatch = result.match(/^package[^\n]*\n/m);
  const required = [
    'androidx.compose.foundation.background',
    'androidx.compose.foundation.verticalScroll',
    'androidx.compose.foundation.border',
    'androidx.compose.ui.draw.alpha',
    'androidx.compose.ui.draw.clip',
    'androidx.compose.ui.draw.clipToBounds',
    'androidx.compose.ui.Modifier',
    'androidx.compose.foundation.layout.*',
    'androidx.compose.ui.unit.dp',
    'androidx.compose.ui.unit.sp',
  ];
  for (const imp of required)
    if (!result.includes('import ' + imp + '\n')) {
      if (!packageMatch) error('Нужен package в Kotlin-файле');
      result = result.replace(packageMatch[0], packageMatch[0] + 'import ' + imp + '\n');
    }
  return {
    file: meta.file,
    beforeHash: hash(code),
    afterHash: hash(result),
    code: result,
    operations: [
      ...diff(baseline, current).intent.changes,
      ...(free
        ? Object.entries(current.layout.frames)
            .filter(([id, frame]) => JSON.stringify(frame) !== JSON.stringify(baseline.layout?.frames?.[id]))
            .map(([nodeId, frame]) => ({
              nodeId,
              property: 'frame',
              before: baseline.layout?.frames?.[nodeId],
              after: frame,
            }))
        : []),
    ],
  };
}
export async function planCompose({ baseline, current, workspace }) {
  const root = await realpath(workspace),
    file = baseline.compose?.file,
    target = await realpath(checkedFile(root, file));
  if (!target.startsWith(root + path.sep)) error('Путь выходит из рабочей копии');
  const code = await readFile(target, 'utf8');
  if (baseline.compose.workspaceRevision && (await sourceRevision(root)) !== baseline.compose.workspaceRevision)
    error('Рабочая копия изменилась; импортируйте актуальную ревизию');
  return {
    ...composePatch(code, baseline, current),
    beforeRevision: await sourceRevision(root),
    workspace: root,
    target,
  };
}
export async function writeComposePlan(plan) {
  if ((await realpath(plan.target)) !== plan.target || (await realpath(plan.workspace)) !== plan.workspace)
    error('Путь переноса изменился');
  const marker = JSON.parse(
    await readFile(path.join(plan.workspace, '.bridge-native-workspace.json'), 'utf8').catch(() =>
      error('Запись разрешена только в подготовленную отдельную копию'),
    ),
  );
  if (
    marker.format !== 'compose-visual-bridge-workspace-v1' ||
    path.resolve(marker.sourceProject) === path.resolve(plan.workspace)
  )
    error('Нужна отдельная рабочая копия');
  if (plan.target !== checkedFile(plan.workspace, plan.file)) error('Недопустимый путь переноса');
  const current = await readFile(plan.target, 'utf8');
  if (hash(current) !== plan.beforeHash) error('Исходник изменился после подготовки переноса');
  if (plan.beforeRevision && (await sourceRevision(plan.workspace)) !== plan.beforeRevision)
    error('Рабочая копия изменилась после подготовки переноса');
  if (plan.afterHash !== hash(plan.code)) error('Повреждён план переноса');
  if (plan.beforeHash === plan.afterHash) return { changed: false };
  const temp = plan.target + '.bridge-tmp';
  await writeFile(temp, plan.code, { flag: 'wx' });
  try {
    if (hash(await readFile(plan.target, 'utf8')) !== plan.beforeHash) error('Исходник изменился во время записи');
    await rename(temp, plan.target);
  } catch (e) {
    await (await import('node:fs/promises')).rm(temp, { force: true });
    throw e;
  }
  return { changed: true, file: plan.file, sourceRevision: plan.afterHash };
}

export function instrumentCompose(code, document) {
  const meta = document.compose;
  if (meta?.fileHash !== hash(code)) error('Исходник изменился перед привязкой');
  const edits = [];
  for (const [id, binding] of Object.entries(meta.bindings)) {
    const modifier = binding.args.find(a => a.name === 'modifier'),
      value = `dev.composevisualbridge.capture.bridgeSourceModifier(${str(id)}, ${modifier?.value || 'Modifier'}, kind = ${str(binding.callType || binding.type)}${binding.args.find(a => a.name === 'color') ? ', explicitColor = ' + binding.args.find(a => a.name === 'color').value : ''})`;
    if (modifier) edits.push({ start: modifier.valueStart, end: modifier.valueEnd, text: value });
    else {
      const tokens = kotlinTokens(code.slice(binding.start, binding.end)),
        open = tokens[1]?.v === '(' ? binding.start + tokens[1].end : null;
      if (open !== null) {
        const closing = binding.start + tokens[pairs(tokens).get(1)].start;
        edits.push({
          start: closing,
          end: closing,
          text: `${binding.args.length && tokens[pairs(tokens).get(1) - 1]?.v !== ',' ? ', ' : ''}modifier = ${value}`,
        });
      } else
        edits.push({
          start: binding.start + (binding.callType || binding.type).length,
          end: binding.start + (binding.callType || binding.type).length,
          text: `(modifier = ${value})`,
        });
    }
  }
  let result = code;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { code: result, original: code, originalHash: hash(code), instrumentedHash: hash(result) };
}
export const sourceAdapter = `package dev.composevisualbridge.capture
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.material3.*
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics
private val BridgeSourceKey = SemanticsPropertyKey<String>("BridgeSourceKey")
private var SemanticsPropertyReceiver.bridgeSourceKey by BridgeSourceKey
private val BridgeForeground = SemanticsPropertyKey<String>("BridgeForeground")
private var SemanticsPropertyReceiver.bridgeForeground by BridgeForeground
private val BridgeBackground = SemanticsPropertyKey<String>("BridgeBackground")
private var SemanticsPropertyReceiver.bridgeBackground by BridgeBackground
private fun hex(color: Color): String = String.format("#%06X", color.toArgb() and 0xFFFFFF)
@Composable fun bridgeSourceModifier(key: String, modifier: Modifier, kind: String, explicitColor: Color = Color.Unspecified): Modifier {
 val foreground = explicitColor.takeOrElse { LocalTextStyle.current.color.takeOrElse { LocalContentColor.current } }
 val background = when (kind) { "Card" -> CardDefaults.cardColors().containerColor; "Button" -> ButtonDefaults.buttonColors().containerColor; "Surface" -> explicitColor.takeOrElse { MaterialTheme.colorScheme.surface }; else -> Color.Unspecified }
 return Modifier.semantics {
  bridgeSourceKey = key
  if (kind == "Text") bridgeForeground = hex(foreground)
  if (background != Color.Unspecified) bridgeBackground = hex(background)
 }.then(modifier)
}
`;
function adapterFile(root, marker) {
  if (!/^:[A-Za-z_]\w*(?::[A-Za-z_]\w*)*$/.test(marker.module || '')) error('Недопустимый модуль рабочей копии');
  return path.join(
    root,
    marker.module.slice(1).replaceAll(':', '/'),
    'src/debug/java/dev/composevisualbridge/capture/BridgeSource.kt',
  );
}
export async function instrumentWorkspace(document) {
  const root = await realpath(document.compose.workspace),
    marker = JSON.parse(await readFile(path.join(root, '.bridge-native-workspace.json'), 'utf8'));
  if (marker.format !== 'compose-visual-bridge-workspace-v1' || path.resolve(marker.sourceProject) === root)
    error('Привязка разрешена только в отдельной копии');
  const scene = await readFile(path.join(root, '.bridge-scene-import.json'), 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (scene && JSON.parse(scene).status !== 'restored') error('Сначала восстановите предыдущую runtime-сцену');
  const target = await realpath(checkedFile(root, document.compose.file));
  if (!target.startsWith(root + path.sep)) error('Путь выходит из рабочей копии');
  const code = await readFile(target, 'utf8'),
    result = instrumentCompose(code, document),
    manifest = path.join(root, '.bridge-compose-import.json'),
    adapter = adapterFile(root, marker);
  const previous = await readFile(manifest, 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (previous) {
    const old = JSON.parse(previous),
      oldTarget = await realpath(checkedFile(root, old.document.compose.file));
    if (
      !oldTarget.startsWith(root + path.sep) ||
      (old.status !== 'restored' && hash(await readFile(oldTarget, 'utf8')) !== old.originalHash)
    )
      error('Сначала восстановите предыдущий импорт');
  }
  if (document.compose.workspaceRevision && (await sourceRevision(root)) !== document.compose.workspaceRevision)
    error('Рабочая копия изменилась; импортируйте актуальную ревизию');
  await mkdir(path.dirname(adapter), { recursive: true });
  await writeTextAtomic(adapter, sourceAdapter, { exclusive: true });
  try {
    await writeTextAtomic(
      manifest,
      JSON.stringify({ format: 'compose-visual-bridge-instrumentation-v1', document, ...result }, null, 2),
    );
    if (hash(await readFile(target, 'utf8')) !== result.originalHash) error('Исходник изменился во время привязки');
    await writeTextAtomic(target, result.code);
  } catch (e) {
    await rm(adapter, { force: true });
    if (previous) await writeTextAtomic(manifest, previous);
    else await rm(manifest, { force: true });
    throw e;
  }
  return { manifest, sourceRevision: result.instrumentedHash, nodes: Object.keys(document.compose.bindings).length };
}
export async function restoreWorkspace(workspace) {
  const root = await realpath(workspace),
    manifest = path.join(root, '.bridge-compose-import.json'),
    value = JSON.parse(await readFile(manifest, 'utf8'));
  if (value.format !== 'compose-visual-bridge-instrumentation-v1') error('Неизвестная привязка');
  const target = await realpath(checkedFile(root, value.document.compose.file));
  if (!target.startsWith(root + path.sep)) error('Путь выходит из рабочей копии');
  const code = await readFile(target, 'utf8'),
    currentHash = hash(code);
  if (![value.originalHash, value.instrumentedHash].includes(currentHash))
    error('Инструментированный исходник изменился; автоматическое восстановление запрещено');
  if (hash(value.original) !== value.originalHash) error('Повреждён исходник в привязке');
  const marker = JSON.parse(await readFile(path.join(root, '.bridge-native-workspace.json'), 'utf8')),
    adapter = adapterFile(root, marker),
    helper = await readFile(adapter, 'utf8').catch(e => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
  if (helper !== null && helper !== sourceAdapter) error('Адаптер изменился; автоматическое восстановление запрещено');
  if (currentHash === value.instrumentedHash) await writeTextAtomic(target, value.original);
  if (helper !== null) await rm(adapter);
  await writeTextAtomic(manifest, JSON.stringify({ ...value, status: 'restored' }, null, 2));
  return { restored: true, file: value.document.compose.file };
}

export function bindCapture(document, frame) {
  if (!frame?.image || !Array.isArray(frame.nodes) || !Number.isFinite(frame.densityDpi))
    error('Нужен настоящий нормализованный native-кадр');
  const result = clone(document),
    nodes = indexTree(result.root),
    density = frame.densityDpi / 160,
    linked = new Map(),
    frames = {},
    textGeometry = {};
  for (const [id] of nodes) {
    const matches = frame.nodes.filter(n => n.properties.bridgeSourceKey === id);
    if (matches.length !== 1)
      error(matches.length ? 'Повторный runtime-экземпляр требует отдельной связи: ' + id : 'Нет runtime-связи: ' + id);
    linked.set(id, matches[0]);
  }
  const number = value => (typeof value === 'string' ? Number(value.match(/-?\d+(?:\.\d+)?/)?.[0]) : NaN);
  for (const [id, entry] of nodes) {
    const actual = linked.get(id),
      parent = linked.get(entry.parent),
      b = actual.bounds,
      p = entry.node.props;
    frames[id] = {
      parent: entry.parent,
      x: parent ? (b.left - parent.bounds.left) / density - (nodes.get(entry.parent).node.props.borderWidth || 0) : 0,
      y: parent ? (b.top - parent.bounds.top) / density - (nodes.get(entry.parent).node.props.borderWidth || 0) : 0,
      width: (b.right - b.left) / density,
      height: (b.bottom - b.top) / density,
    };
    if (entry.node.type === 'Card') p.clipContent = true;
    const textNode =
      entry.node.type === 'Button'
        ? frame.nodes.find(n => n.properties.bridgeSourceKey === result.compose.bindings[id].label)
        : actual;
    if (['Text', 'Button'].includes(entry.node.type)) {
      const textBinding = result.compose.bindings[result.compose.bindings[id].label || id];
      if (textBinding.runtimeText) {
        if (typeof textNode?.text !== 'string') error('Нет runtime-текста ' + id);
        p.text = textNode.text;
      } else if (textNode?.text !== p.text) error('Текст состояния не совпадает: ' + id);
      for (const key of ['fontSize', 'lineHeight', 'letterSpacing']) {
        const n = number(textNode.properties[key]);
        if (Number.isFinite(n)) p[key] = n;
      }
      const weight = number(textNode.properties.fontWeight?.match(/\((\d+)\)/)?.[1] || textNode.properties.fontWeight);
      if (Number.isFinite(weight)) p.fontWeight = weight;
      p.fontFamily ??= 'Roboto';
      if (textNode.properties.textLineCount === '1') {
        const measuredMaxLines = p.maxLines === undefined;
        p.maxLines ??= 1;
        p.textOverflow ??= 'clip';
        if (entry.node.type === 'Text' && p.height === undefined) {
          textGeometry[id] = {
            ...(measuredMaxLines ? { measuredMaxLines: true } : {}),
            maxLines: p.maxLines,
            textOverflow: p.textOverflow,
            lineCount: 1,
            layoutWidth: frames[id].width,
            text: p.text,
            fontFamily: p.fontFamily,
            fontWeight: p.fontWeight,
            fontStyle: p.fontStyle,
            fontSize: p.fontSize,
            lineHeight: p.lineHeight,
            textHeight: frames[id].height - 2 * (p.paddingVertical ?? p.padding ?? 0),
          };
        }
      }
    }
    const fg = textNode?.properties.bridgeForeground;
    if (/^#[a-fA-F0-9]{6}$/.test(fg || '')) p.color = fg;
    const bg =
      actual.properties.bridgeBackground ||
      (entry.parent === null ? actual.properties.backgroundColor?.replace(/^#FF/i, '#') : null);
    if (/^#[a-fA-F0-9]{6}$/.test(bg || '')) p.background = bg;
    const shape = actual.properties.shape;
    if (shape?.includes('RoundedCornerShape')) {
      const sizes = [...shape.matchAll(/size = ([\d.]+)(\.dp|%)/g)];
      if (sizes.length === 4 && sizes.every(m => m[1] === sizes[0][1] && m[2] === sizes[0][2]))
        p.radius =
          Number(sizes[0][1]) * (sizes[0][2] === '%' ? Math.min(frames[id].width, frames[id].height) / 100 : 1);
    }
  }
  result.viewport = {
    ...result.viewport,
    presentation: 'content',
    width: Math.max(200, frames[result.root.id].width),
    height: Math.max(200, frames[result.root.id].height),
  };
  result.layout = { mode: 'free', frames };
  result.compose.capture = {
    preview: frame.preview,
    screenState: frame.screenState,
    sourceRevision: frame.sourceRevision,
    digest: frame.digest,
    densityDpi: frame.densityDpi,
    textGeometry,
    bounds: Object.fromEntries([...linked].map(([id, node]) => [id, node.bounds])),
    status: 'needs-browser-verification',
  };
  result.compose.initial = clone(result.root);
  validate(result);
  return result;
}

export function generateCompose(document, { packageName, symbol } = {}) {
  validate(document);
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(packageName || '') || !/^[A-Za-z_]\w*$/.test(symbol || ''))
    error('Нужны корректные package и имя нового экрана');
  const code = `package ${packageName}\nimport androidx.compose.runtime.Composable\nimport androidx.compose.material3.*\nimport androidx.compose.ui.Modifier\nimport androidx.compose.foundation.layout.*\nimport androidx.compose.ui.unit.dp\nimport androidx.compose.ui.unit.sp\n@Composable fun ${symbol}() {\n}\n`,
    body = { start: code.indexOf('{') + 1, end: code.lastIndexOf('}') },
    baseline = {
      schemaVersion: 1,
      name: symbol,
      viewport: document.viewport,
      root: { id: 'new-screen-root', type: 'Box', props: {}, children: [] },
      layout: { mode: 'auto' },
      compose: {
        format: 'compose-visual-bridge-compose-v1',
        modifierModel: MODIFIER_MODEL,
        file: symbol + '.kt',
        fileHash: hash(code),
        symbol,
        bindings: {},
        body,
      },
    },
    current = { ...clone(document), compose: baseline.compose };
  return composePatch(code, baseline, current).code;
}

export async function bindWorkspaceCapture(document, frame) {
  const root = await realpath(document.compose.workspace),
    manifest = JSON.parse(await readFile(path.join(root, '.bridge-compose-import.json'), 'utf8')),
    build = JSON.parse(await readFile(path.join(root, 'bridge-native-build.json'), 'utf8'));
  if (
    manifest.document.compose.fileHash !== document.compose.fileHash ||
    manifest.document.compose.symbol !== document.compose.symbol ||
    manifest.document.compose.file !== document.compose.file
  )
    error('Захват относится к другому импорту');
  if (build.sourceRevision !== frame.sourceRevision || !build.previews.includes(frame.preview))
    error('Захват не относится к проверенной сборке');
  const file = await readFile(checkedFile(root, document.compose.file), 'utf8'),
    current = hash(file);
  if (![manifest.originalHash, manifest.instrumentedHash].includes(current)) error('Исходник изменился после захвата');
  if (hash(manifest.original) !== document.compose.fileHash || hash(manifest.code) !== manifest.instrumentedHash)
    error('Повреждена привязка исходников');
  return bindCapture(document, frame);
}
