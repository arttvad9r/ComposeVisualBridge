import { writeTextAtomic } from './storage.mjs';
import { readFile, writeFile, realpath, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { kotlinTokens } from './compose.mjs';
import { sourceRevision } from './scripts/native-project.mjs';
import { validate, clone } from './public/model.mjs';
import { cropPng } from './scripts/compare-png.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const manifestName = '.bridge-scene-import.json';
function brackets(t) {
  const map = new Map(),
    stack = [];
  for (let i = 0; i < t.length; i++) {
    if (['(', '{', '['].includes(t[i].v)) stack.push(i);
    else if ([')', '}', ']'].includes(t[i].v)) {
      const start = stack.pop();
      if (start === undefined || '({['.indexOf(t[start].v) !== ')}]'.indexOf(t[i].v))
        throw Error('Несогласованные скобки Kotlin');
      map.set(start, i);
    }
  }
  if (stack.length) throw Error('Незакрытые скобки Kotlin');
  return map;
}
export function sceneCalls(code, symbol) {
  const t = kotlinTokens(code),
    p = brackets(t),
    // Extension functions (`fun LazyListScope.symbol(`) are indexed at their name, like plain ones.
    headers = t.flatMap((v, i) => (v.v === 'fun' && t[i + 1]?.v === symbol && t[i + 2]?.v === '(' ? [i] : v.v === 'fun' && t[i + 2]?.v === '.' && t[i + 3]?.v === symbol && t[i + 4]?.v === '(' ? [i + 2] : []));
  if (headers.length !== 1) throw Error('Нужна одна функция ' + symbol);
  const start = p.get(headers[0] + 2) + 1,
    end = p.get(start);
  if (t[start]?.v !== '{' || end === undefined) throw Error('Нужно блочное тело ' + symbol);
  const calls = [];
  for (let i = start + 1; i < end; i++) {
    // `Column { ... }`: a capitalized call with only a trailing lambda gets `(modifier = ...)` inserted after its name.
    if (/^[A-Z]\w*$/.test(t[i].v) && t[i + 1]?.v === '{' && !['.', 'fun', 'class', 'object', 'interface', ':', '@', '<', ','].includes(t[i - 1]?.v) && p.has(i + 1)) {
      calls.push({ call: t[i].v, start: t[i].start, end: t[p.get(i + 1)].end, open: t[i].end, close: t[i].end, bare: true, trailingComma: false, line: t[i].line, args: [] });
      continue;
    }
    if (!/^[A-Za-z_]\w*$/.test(t[i].v) || t[i + 1]?.v !== '(') continue;
    const close = p.get(i + 1);
    if (close === undefined) continue;
    let finish = close;
    if (t[close + 1]?.v === '{') finish = p.get(close + 1);
    const args = [];
    let from = i + 2;
    for (let j = from; j <= close; j++) {
      if (j === close || t[j].v === ',') {
        if (j > from)
          args.push({
            name: t[from + 1]?.v === '=' ? t[from].v : null,
            valueStart: t[t[from + 1]?.v === '=' ? from + 2 : from].start,
            start: t[from].start,
            end: t[j - 1].end,
            value: code.slice(t[t[from + 1]?.v === '=' ? from + 2 : from].start, t[j - 1].end),
          });
        from = j + 1;
      } else if (p.has(j)) j = p.get(j);
    }
    calls.push({
      call: t[i].v,
      start: t[i].start,
      end: t[finish].end,
      open: t[i + 1].end,
      close: t[close].start,
      trailingComma: t[close - 1]?.v === ',',
      line: t[i].line,
      args,
    });
  }
  return calls;
}
async function fileAt(root, file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !file.endsWith('.kt'))
    throw Error('Нужен относительный Kotlin-путь');
  const target = await realpath(path.join(root, file));
  if (!target.startsWith(root + path.sep)) throw Error('Исходник выходит из копии');
  return target;
}
async function workspaceAt(workspace) {
  const root = await realpath(workspace),
    meta = JSON.parse(await readFile(path.join(root, '.bridge-native-workspace.json'), 'utf8'));
  if (
    meta.format !== 'compose-visual-bridge-workspace-v1' ||
    path.resolve(meta.sourceProject) === root ||
    !/^:[A-Za-z_]\w*(?::[A-Za-z_]\w*)*$/.test(meta.module)
  )
    throw Error('Нужна подготовленная отдельная копия');
  return {
    root,
    meta,
    helper: path.join(
      root,
      meta.module.slice(1).replaceAll(':', '/'),
      'src/debug/java/dev/composevisualbridge/capture/BridgeScene.kt',
    ),
  };
}
export async function prepareScene(workspace, adapter) {
  const { root } = await workspaceAt(workspace);
  if (
    !['compose-visual-bridge-scene-adapter-v1', 'compose-visual-bridge-live-adapter-v1'].includes(adapter?.format) ||
    !Array.isArray(adapter.calls) ||
    !adapter.calls.length ||
    adapter.calls.length > 1000 ||
    (adapter.format === 'compose-visual-bridge-live-adapter-v1'
      ? adapter.calls.filter(r => r.root === true && !r.scope).length < 1
      : adapter.calls.filter(r => r.root === true && !r.scope).length !== 1)
  )
    throw Error('Некорректный адаптер сцены');
  const files = {},
    bindings = {},
    edits = {};
  for (const rule of adapter.calls) {
    const target = await fileAt(root, rule.file);
    if (!files[rule.file]) {
      const original = await readFile(target, 'utf8');
      files[rule.file] = { target, original, originalHash: hash(original) };
      edits[rule.file] = [];
    }
    const { original } = files[rule.file];
    if (rule.fileHash !== hash(original)) throw Error('Адаптер устарел: ' + rule.file);
    const matches = sceneCalls(original, rule.symbol).filter(c => c.call === rule.call);
    const call = matches[rule.occurrence];
    if (!Number.isInteger(rule.occurrence) || !call) throw Error('Не найден вызов ' + rule.call);
    const key =
      rule.key || 's' + hash(rule.file + '\0' + rule.symbol + '\0' + rule.call + '\0' + rule.occurrence).slice(0, 16);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key) || bindings[key]) throw Error('Ключи вызовов должны быть уникальны');
    if (rule.instance && !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(rule.instance))
      throw Error('Нужен стабильный идентификатор экземпляра');
    if (rule.scope) {
      edits[rule.file].push(
        {
          start: call.start,
          end: call.start,
          text: `dev.composevisualbridge.capture.bridgeSceneScope("${key}"${rule.instance ? ' + "/" + ' + rule.instance + '.toString()' : ''}) { `,
        },
        { start: call.end, end: call.end, text: ' }' },
      );
      bindings[key] = {
        ...rule,
        key,
        args: call.args,
        source: { file: rule.file, symbol: rule.symbol, line: call.line },
        scope: true,
      };
      continue;
    }
    if (
      !['Text', 'Column', 'Row', 'Box', 'Card', 'Button', 'Spacer', 'TextField', 'Switch', 'Icon', 'Image'].includes(
        rule.type,
      )
    )
      throw Error('Неизвестный тип элемента');
    if (rule.instance && !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(rule.instance))
      throw Error('Нужен стабильный идентификатор экземпляра');
    const modifier =
      call.args.find(a => a.name === 'modifier') ||
      (call.args[0]?.name === null && /^Modifier\b/.test(call.args[0].value) ? call.args[0] : null);
    const color = call.args.find(a => a.name === 'color');
    const value = `dev.composevisualbridge.capture.bridgeSceneModifier("${key}", ${modifier?.value || 'androidx.compose.ui.Modifier'}, instance = ${rule.instance ? rule.instance + '.toString()' : '""'}, kind = "${rule.type}"${rule.foreground ? ', foreground = ' + rule.foreground : color ? ', foreground = ' + color.value : ''}${rule.background ? ', background = ' + rule.background : ''}${rule.border ? ', border = ' + rule.border : ''}${rule.borderWidth ? ', borderWidth = ' + rule.borderWidth : ''}${rule.shape ? ', shape = ' + rule.shape : ''})`;
    edits[rule.file].push(
      modifier
        ? { start: modifier.valueStart, end: modifier.end, text: value }
        : {
            start: call.close,
            end: call.close,
            text: call.bare ? '(modifier = ' + value + ')' : (call.args.length && !call.trailingComma ? ', ' : '') + 'modifier = ' + value,
          },
    );
    const labels =
      rule.type === 'Button'
        ? sceneCalls(original, rule.symbol).filter(c => c.call === 'Text' && c.start > call.start && c.end < call.end)
        : [];
    const measuredText = rule.type === 'Text' ? call : labels.length === 1 ? labels[0] : null;
    if (measuredText) {
      const callback = measuredText.args.find(a => a.name === 'onTextLayout'),
        capture = `dev.composevisualbridge.capture.bridgeSceneTextLayout("${key}", instance = ${rule.instance ? rule.instance + '.toString()' : '""'}${callback ? ', callback = ' + callback.value : ''})`;
      if (callback) edits[rule.file].push({ start: callback.valueStart, end: callback.end, text: capture });
      else if (rule.type === 'Text' && !modifier) edits[rule.file].at(-1).text += ', onTextLayout = ' + capture;
      else
        edits[rule.file].push({
          start: measuredText.close,
          end: measuredText.close,
          text: (measuredText.args.length && !measuredText.trailingComma ? ', ' : '') + 'onTextLayout = ' + capture,
        });
    }
    bindings[key] = {
      ...rule,
      key,
      args: call.args,
      source: { file: rule.file, symbol: rule.symbol, line: call.line },
      args: call.args,
      agentOnly: true,
    };
  }
  // Button и другие листья представляют весь вызов одним узлом. Их внутренние
  // Icon/Text/Spacer не могут становиться независимыми дочерними узлами модели.
  const located = Object.values(bindings).map(rule => ({
    rule,
    call: sceneCalls(files[rule.file].original, rule.symbol).filter(call => call.call === rule.call)[rule.occurrence],
  }));
  for (const child of located.filter(item => !item.rule.scope)) {
    const parent = located
      .filter(
        item =>
          !item.rule.scope &&
          item.rule.file === child.rule.file &&
          item.rule.symbol === child.rule.symbol &&
          item.call.start < child.call.start &&
          item.call.end >= child.call.end,
      )
      .sort((a, b) => a.call.end - a.call.start - (b.call.end - b.call.start))[0];
    if (parent && !['Column', 'Row', 'Box', 'Card'].includes(parent.rule.type))
      throw Error(
        `Вложенная привязка ${child.rule.key} внутри листа ${parent.rule.key} (${parent.rule.type}); оставьте одну связь всего вызова`,
      );
  }
  for (const [file, items] of Object.entries(edits)) {
    const ranges = items.filter(e => e.end > e.start).sort((a, b) => a.start - b.start);
    if (
      ranges.some((e, i) => i && e.start < ranges[i - 1].end) ||
      new Set(items.map(e => e.start + ':' + e.end)).size !== items.length
    )
      throw Error('Перекрывающиеся привязки: ' + file);
    let code = files[file].original;
    for (const edit of items.sort((a, b) => b.start - a.start || b.end - a.end))
      code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    files[file].instrumented = code;
    files[file].instrumentedHash = hash(code);
  }
  return {
    rootKey: Object.keys(bindings).find(key => bindings[key].root),
    format: 'compose-visual-bridge-scene-import-v1',
    workspace: root,
    workspaceRevision: await sourceRevision(root),
    name: adapter.name || 'Экран',
    files,
    bindings,
  };
}
export const sceneHelper = `package dev.composevisualbridge.capture
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.material3.*
import androidx.compose.ui.semantics.*
private val SceneScope = compositionLocalOf { "" }
private val SourceKey = SemanticsPropertyKey<String>("BridgeSourceKey")
private val Foreground = SemanticsPropertyKey<String>("BridgeForeground")
private val Background = SemanticsPropertyKey<String>("BridgeBackground")
private val Border = SemanticsPropertyKey<String>("BridgeBorderColor")
private val BorderWidth = SemanticsPropertyKey<String>("BridgeBorderWidth")
private val Radius = SemanticsPropertyKey<String>("BridgeRadius")
private val Bounds = SemanticsPropertyKey<String>("BridgeBounds")
private val FontScale = SemanticsPropertyKey<String>("BridgeFontScale")
private val FontScaleCurve = SemanticsPropertyKey<String>("BridgeFontScaleCurve")
private val SystemFontHash = SemanticsPropertyKey<String>("BridgeSystemFontSha256")
private val RobotoHash: String? by lazy { runCatching {
 if (android.os.Build.VERSION.SDK_INT < 31) null else {
  val paint = android.graphics.Paint().apply { typeface = android.graphics.Typeface.DEFAULT; textSize = 15f }
  val font = android.graphics.text.TextRunShaper.shapeTextRun("А", 0, 1, 0, 1, 0f, 0f, false, paint).getFont(0)
  font.file?.let { java.security.MessageDigest.getInstance("SHA-256").digest(it.readBytes()).joinToString("") { value -> "%02x".format(value) } }
 }
}.getOrNull() }
private val TextLines = SemanticsPropertyKey<String>("BridgeTextLines")
private val TextWidths = SemanticsPropertyKey<String>("BridgeTextWidths")
private val CapturedTextWidths = mutableStateMapOf<String, String>()
private val TextStyleMetrics = SemanticsPropertyKey<String>("BridgeTextStyleMetrics")
private val CapturedTextStyleMetrics = mutableStateMapOf<String, String>()
private val TextSize = SemanticsPropertyKey<String>("BridgeTextSize")
private val CapturedTextSize = mutableStateMapOf<String, String>()
private val TextAdvance = SemanticsPropertyKey<String>("BridgeTextAdvance")
private val CapturedTextAdvance = mutableStateMapOf<String, String>()
private val CapturedTextLines = mutableStateMapOf<String, String>()
@Composable fun bridgeSceneTextLayout(key: String, instance: String = "", callback: (androidx.compose.ui.text.TextLayoutResult) -> Unit = {}): (androidx.compose.ui.text.TextLayoutResult) -> Unit {
 val identity = SceneScope.current + "/" + key + "/" + instance
 return { result ->
  if (result.lineCount <= 50) CapturedTextLines[identity] = (0 until result.lineCount).joinToString(";") { "\${result.getLineStart(it)},\${result.getLineEnd(it, visibleEnd = true)},\${if (result.isLineEllipsized(it)) 1 else 0}" }
  if (result.lineCount <= 50) CapturedTextWidths[identity] = (0 until result.lineCount).joinToString(",") { (result.getLineRight(it) - result.getLineLeft(it)).toString() }
  if (result.lineCount > 1) CapturedTextAdvance[identity] = (result.getLineBaseline(1) - result.getLineBaseline(0)).toString()
  val style = result.layoutInput.style
  val inputDensity = result.layoutInput.density
  val fontDp = with(inputDensity) { style.fontSize.toPx() } / inputDensity.density
  CapturedTextStyleMetrics[identity] = "\${fontDp},\${if (style.letterSpacing.isSp) style.letterSpacing.value else if (style.letterSpacing.isEm) style.letterSpacing.value * style.fontSize.value else 0f}"
  CapturedTextSize[identity] = "\${result.size.width},\${result.size.height}"
  callback(result)
 }
}
@Composable fun bridgeSceneScope(key: String, content: @Composable () -> Unit) {
 CompositionLocalProvider(SceneScope provides (SceneScope.current + "/" + key), content = content)
}
private var InstanceCounter = 0
// Generated adapters use a remembered slot number: unique per call site, item and loop iteration in one frame.
val bridgeSceneInstance: String @Composable get() = remember { (++InstanceCounter).toString() }
private fun hex(color: Color): String = String.format("#%06X", color.toArgb() and 0xFFFFFF)
// Material 3 disabled colors, composited so the editor gets an opaque value.
@Composable fun bridgeDisabledContainer(): Color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f).compositeOver(MaterialTheme.colorScheme.surface)
@Composable fun bridgeDisabledContent(): Color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f).compositeOver(MaterialTheme.colorScheme.surface)
@Composable fun bridgeSceneModifier(key: String, modifier: Modifier, instance: String = "", kind: String, foreground: Color = Color.Unspecified, background: Color = Color.Unspecified, border: Color = Color.Unspecified, borderWidth: Float = 0f, shape: androidx.compose.ui.graphics.Shape? = null): Modifier {
 val identity = SceneScope.current + "/" + key + "/" + instance
 var bounds by remember(identity) { mutableStateOf("") }
 var radius by remember(identity) { mutableStateOf("") }
 val density = LocalDensity.current
 val fontScale = density.fontScale
 val textLines = CapturedTextLines[identity]
 val textWidths = CapturedTextWidths[identity]
 val textAdvance = CapturedTextAdvance[identity]
 val textSize = CapturedTextSize[identity]
 val textStyleMetrics = CapturedTextStyleMetrics[identity]
 val curve = remember(density) { (0..300).joinToString(",") { with(density) { ((it / 2f).sp.toDp().value * 100).roundToInt().toString() } } }
 val fg = foreground.takeOrElse { LocalTextStyle.current.color.takeOrElse { LocalContentColor.current } }
 return Modifier.semantics { this[SourceKey] = identity; this[Bounds] = bounds; this[FontScale] = fontScale.toString(); this[FontScaleCurve] = curve; RobotoHash?.let { this[SystemFontHash] = it }; if (textLines != null) this[TextLines] = textLines; if (textWidths != null) this[TextWidths] = textWidths; if (textAdvance != null) this[TextAdvance] = textAdvance; if (textSize != null) this[TextSize] = textSize; if (textStyleMetrics != null) this[TextStyleMetrics] = textStyleMetrics; if (kind == "Text" || kind == "Button") this[Foreground] = hex(fg); if (background != Color.Unspecified) this[Background] = hex(background); if (border != Color.Unspecified) this[Border] = hex(border); this[BorderWidth] = borderWidth.toString(); if (radius.isNotEmpty()) this[Radius] = radius }.onGloballyPositioned { coordinates -> val position = coordinates.positionInRoot(); bounds = "\${position.x},\${position.y},\${coordinates.size.width},\${coordinates.size.height}"; (shape as? androidx.compose.foundation.shape.CornerBasedShape)?.let { radius = (it.topStart.toPx(androidx.compose.ui.geometry.Size(coordinates.size.width.toFloat(), coordinates.size.height.toFloat()), density) / density.density).toString() } }.then(modifier)
}
`;
export async function instrumentScene(scene) {
  const { root, helper } = await workspaceAt(scene.workspace);
  if ((await sourceRevision(root)) !== scene.workspaceRevision) throw Error('Копия изменилась после подготовки сцены');
  const filename = path.join(root, manifestName);
  const compose = await readFile(path.join(root, '.bridge-compose-import.json'), 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (compose && JSON.parse(compose).status !== 'restored')
    throw Error('Сначала восстановите предыдущий Compose-импорт');
  const old = await readFile(filename, 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (old && JSON.parse(old).status !== 'restored') throw Error('Сначала восстановите предыдущую сцену');
  for (const file of Object.values(scene.files))
    if (hash(await readFile(file.target, 'utf8')) !== file.originalHash) throw Error('Исходник сцены изменился');
  await mkdir(path.dirname(helper), { recursive: true });
  await writeTextAtomic(helper, sceneHelper, { exclusive: true });
  const written = [];
  try {
    await writeTextAtomic(filename, JSON.stringify({ ...scene, status: 'instrumented' }));
    for (const file of Object.values(scene.files)) {
      if (hash(await readFile(file.target, 'utf8')) !== file.originalHash)
        throw Error('Исходник сцены изменился во время привязки');
      await writeTextAtomic(file.target, file.instrumented);
      written.push(file);
    }
    scene.instrumentedRevision = await sourceRevision(root);
  } catch (error) {
    // If rollback fails, retain the original contents in the recovery manifest.
    try {
      for (const file of written) {
        if (hash(await readFile(file.target, 'utf8')) !== file.instrumentedHash)
          throw Error('Исходник изменился во время восстановления');
        await writeTextAtomic(file.target, file.original);
      }
      if (old) await writeTextAtomic(filename, old);
      else await rm(filename, { force: true });
      await rm(helper, { force: true });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Ошибка привязки: ${error.message}. Автовосстановление не завершено: ${recoveryError.message}. Снимок восстановления: ${filename}`,
      );
    }
    throw error;
  }
  return scene;
}

export async function restoreScene(workspace) {
  const { root, helper } = await workspaceAt(workspace),
    filename = path.join(root, manifestName),
    scene = JSON.parse(await readFile(filename, 'utf8'));
  if (scene.format !== 'compose-visual-bridge-scene-import-v1' || scene.workspace !== root)
    throw Error('Некорректный снимок сцены');
  const helperCode = await readFile(helper, 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (helperCode !== null && helperCode !== sceneHelper) throw Error('Адаптер сцены изменился');
  for (const [name, file] of Object.entries(scene.files)) {
    if (
      (await fileAt(root, name)) !== file.target ||
      hash(file.original) !== file.originalHash ||
      ![file.originalHash, file.instrumentedHash].includes(hash(await readFile(file.target, 'utf8')))
    )
      throw Error('Исходник изменился: восстановление запрещено');
  }
  for (const file of Object.values(scene.files)) await writeTextAtomic(file.target, file.original);
  await rm(helper, { force: true });
  await writeTextAtomic(filename, JSON.stringify({ ...scene, status: 'restored' }));
}
export async function bindScene(scene, frame) {
  if (frame?.sourceRevision !== scene.instrumentedRevision)
    throw Error('Кадр не соответствует инструментированной сборке');
  if ((await sourceRevision(scene.workspace)) !== scene.workspaceRevision)
    throw Error('Восстановленная копия изменилась');
  if (!frame?.image || !Array.isArray(frame.nodes) || !Number.isFinite(frame.densityDpi))
    throw Error('Нужен настоящий кадр сцены');
  const fontHash = frame.nodes.find(n => n.properties.bridgeSystemFontSha256)?.properties.bridgeSystemFontSha256;
  const curveText = frame.nodes.find(n => n.properties.bridgeFontScaleCurve)?.properties.bridgeFontScaleCurve,
    fontScaleCurve = curveText?.split(',').map(Number);
  const density = frame.densityDpi / 160,
    fontScale = Number(frame.nodes.find(n => n.properties.bridgeFontScale)?.properties.bridgeFontScale || 1),
    selected = new Map(),
    keys = new Set(),
    bindings = {},
    frames = {},
    textGeometry = {};
  for (const native of frame.nodes) {
    let actual = native;
    const raw = String(native.properties.bridgeBounds || '')
      .split(',')
      .map(Number);
    if (raw.length === 4) {
      if (!raw.every(Number.isFinite) || raw[2] < 0 || raw[3] < 0 || raw.some(v => Math.abs(v) > 32768))
        throw Error('Некорректная геометрия сцены');
      actual = { ...native, bounds: { left: raw[0], top: raw[1], right: raw[0] + raw[2], bottom: raw[1] + raw[3] } };
    }
    const identity = actual.properties.bridgeSourceKey;
    if (!identity) continue;
    const parts = identity.split('/'),
      key = parts.at(-2),
      rule = scene.bindings[key];
    if (!rule || rule.scope) throw Error('Неизвестная runtime-привязка');
    if (keys.has(identity)) throw Error('Повторный экземпляр без уникального ключа: ' + identity);
    keys.add(identity);
    const id = 'r' + hash(identity).slice(0, 24),
      props = { ...rule.props },
      b = actual.bounds;
    const textNode =
      rule.type === 'Button'
        ? frame.nodes.find(n => {
            let parent = n.parentId;
            const seen = new Set();
            while (parent && !seen.has(parent)) {
              if (parent === actual.id) return typeof n.text === 'string';
              seen.add(parent);
              parent = frame.nodes.find(x => x.id === parent)?.parentId;
            }
            return false;
          }) || actual
        : actual;
    const text = actual.text || textNode.text;
    if (rule.type === 'TextField' && typeof actual.properties.editableText === 'string') {
      props.text = actual.properties.editableText;
      // Material fields: an outlined label sits 8dp above the 56dp box; supporting text is drawn below the box
      // but still inside the field bounds.
      const boxBottom = b.top + ((/^Outlined/.test(rule.call) ? 8 : 0) + 56) * density,
        texts = frame.nodes.filter(n => n.parentId === actual.id && typeof n.text === 'string' && n.text),
        support = texts.find(n => n.bounds.top >= boxBottom - 2 * density),
        hint = texts.find(n => n !== support);
      if (support) props.supportingText = support.text;
      // An empty field shows its label or placeholder in place of the text; a filled one shows the label on top.
      if (hint) props[props.text ? 'label' : 'placeholder'] = hint.text;
      const descendant = n => {
        for (let p = n.parentId, i = 0; p && i < 8; p = frame.nodes.find(x => x.id === p)?.parentId, i++) if (p === actual.id) return true;
        return false;
      };
      for (const icon of frame.nodes.filter(n => n.properties.role === 'Image' && descendant(n))) {
        const ib = icon.bounds, key = (ib.left + ib.right) / 2 > (b.left + b.right) / 2 ? 'trailingIcon' : 'leadingIcon';
        if (ib.right > ib.left && ib.bottom > ib.top) props[key] ??= cropPng(Buffer.from(frame.image, 'base64'), ib);
      }
      const n = Number(String(actual.properties.fontSize || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(n)) props.fontSize = n;
    }
    if (rule.type === 'Switch' && actual.properties.toggleableState) props.checked = actual.properties.toggleableState === 'On';
    if (rule.type === 'Text' || rule.type === 'Button') {
      if (typeof text !== 'string') throw Error('Нет текста ' + rule.call + ' ' + id);
      props.text = text;
      for (const p of ['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight']) {
        const n = Number(String(textNode.properties[p] || '').match(/-?\d+(?:\.\d+)?/)?.[0]);
        if (Number.isFinite(n)) props[p] = n;
      }
      const measuredStyle = actual.properties.bridgeTextStyleMetrics?.split(',').map(Number);
      if (measuredStyle?.length === 2 && measuredStyle.every(Number.isFinite)) props.letterSpacing = measuredStyle[1];
      props.fontWeight ??= 400;
      props.fontFamily = rule.props?.fontFamily || 'Roboto';
      const lineCount = Number(textNode.properties.textLineCount);
      if (lineCount === 1) {
        props.maxLines ??= 1;
        props.textOverflow ??= 'clip';
      }
      const size = actual.properties.bridgeTextSize?.split(',').map(Number);
      const textHeight =
        (size?.length === 2 && size.every(Number.isFinite) && size[1] > 0
          ? size[1]
          : textNode.bounds.bottom - textNode.bounds.top) /
        density /
        fontScale;
      if (Number.isInteger(lineCount) && lineCount > 0 && textHeight > 0) {
        const paint =
          rule.type === 'Button'
            ? {
                left: (native.bounds.left - b.left) / density,
                top: (native.bounds.top - b.top) / density,
                right: (b.right - native.bounds.right) / density,
                bottom: (b.bottom - native.bounds.bottom) / density,
              }
            : null;
        const paintInsets =
          paint &&
          Object.values(paint).every(v => v >= 0) &&
          native.bounds.right > native.bounds.left &&
          native.bounds.bottom > native.bounds.top
            ? paint
            : undefined;
        const lineRanges = actual.properties.bridgeTextLines?.split(';').map(line => {
          const [start, end, ellipsis] = line.split(',').map(Number);
          if (![0, 1].includes(ellipsis)) throw Error('Некорректный признак нативного многоточия');
          return { start, end, ellipsis: Boolean(ellipsis) };
        });
        textGeometry[id] = {
          ...props,
          // maxLines=1 above only records the measured single line; the source does not limit the text.
          ...(lineCount === 1 && rule.props?.maxLines === undefined ? { measuredMaxLines: true } : {}),
          lineCount,
          textHeight,
          ...(size?.length === 2 && size.every(Number.isFinite) ? { textBoxWidth: size[0] / density } : {}),
          ...(measuredStyle?.[0] > 0 ? { fontDp: measuredStyle[0] } : {}),
          ...(rule.type === 'Button' &&
          native.bounds.right === native.bounds.left &&
          b.left < frame.width &&
          b.right > 0 &&
          b.top < frame.height &&
          b.bottom > 0
            ? { paintVisible: false }
            : {}),
          ...(lineRanges ? { lineRanges } : {}),
          ...(actual.properties.bridgeTextWidths
            ? { lineWidths: actual.properties.bridgeTextWidths.split(',').map(value => Number(value) / density) }
            : {}),
          ...(Number(actual.properties.bridgeTextAdvance) > 0
            ? { lineAdvance: Number(actual.properties.bridgeTextAdvance) / density }
            : {}),
          layoutWidth: (b.right - b.left) / density,
          ...(paintInsets ? { paintInsets } : {}),
        };
      }
    }
    const fg = textNode.properties.foregroundColor?.replace(/^#FF/i, '#');
    if (/^#[a-fA-F0-9]{6}$/.test(fg || '')) props.color = fg;
    for (const [property, key] of [
      ['color', 'bridgeForeground'],
      ['background', 'bridgeBackground'],
      ['borderColor', 'bridgeBorderColor'],
    ])
      if (/^#[a-fA-F0-9]{6}$/.test(actual.properties[key] || '')) props[property] = actual.properties[key];
    if (actual.properties.bridgeBorderWidth !== undefined)
      props.borderWidth = Number(actual.properties.bridgeBorderWidth);
    const shape = actual.properties.shape;
    const corners = [...(shape || '').matchAll(/size = ([\d.]+)\.dp/g)];
    if (corners.length === 4 && corners.every(c => c[1] === corners[0][1])) props.radius = Number(corners[0][1]);
    // Runtime corner radius of the call's own shape (dp), e.g. CircleShape or a theme shape.
    if (actual.properties.bridgeRadius !== undefined) props.radius = Math.round(Number(actual.properties.bridgeRadius) * 10) / 10;
    if (rule.type === 'Image') {
      props.src = cropPng(Buffer.from(frame.image, 'base64'), b);
      props.text = actual.text || rule.props?.text || 'Иконка';
    }
    const node = {
      id,
      type: rule.type,
      props,
      source: { ...rule.source, instance: identity, note: rule.call + ' · ' + key },
    };
    if (['Column', 'Row', 'Box', 'Card'].includes(node.type)) node.children = [];
    selected.set(actual.id, { node, actual });
    bindings[id] = {
      ...rule,
      runtimeIdentity: identity,
      runtime: { selected: actual.properties.selected ?? null, disabled: actual.properties.disabled ?? null },
      agentOnly: true,
    };
  }
  if (!selected.size) throw Error('В кадре нет элементов сцены');
  const byId = new Map(frame.nodes.map(n => [n.id, n]));
  const roots = [];
  for (const { node, actual } of selected.values()) {
    let parent = actual.parentId,
      seen = new Set();
    while (parent !== null && !selected.has(parent)) {
      if (seen.has(parent)) throw Error('Цикл дерева кадра');
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    const owner = selected.get(parent);
    if (owner && !owner.node.children) throw Error('Вложенная привязка внутри листа: ' + owner.node.id);
    if (owner) owner.node.children.push(node);
    else roots.push(node);
    frames[node.id] = {
      parent: owner?.node.id || null,
      x: owner ? (actual.bounds.left - owner.actual.bounds.left) / density - (owner.node.props.borderWidth || 0) : 0,
      y: owner ? (actual.bounds.top - owner.actual.bounds.top) / density - (owner.node.props.borderWidth || 0) : 0,
      width: (actual.bounds.right - actual.bounds.left) / density,
      height: (actual.bounds.bottom - actual.bounds.top) / density,
    };
  }
  if (roots.length !== 1 || bindings[roots[0]?.id]?.root !== true) throw Error('Сцена должна иметь один корень');
  const root = roots[0],
    f = frames[root.id];
  const doc = {
    schemaVersion: 1,
    name: scene.name,
    sourceRevision: scene.workspaceRevision,
    state: { screenState: frame.screenState, preview: frame.preview },
    viewport: { width: Math.max(200, f.width), height: Math.max(200, f.height), fontScale, presentation: 'content' },
    layout: { mode: 'free', frames },
    root,
    compose: {
      format: 'compose-visual-bridge-runtime-scene-v1',
      workspace: scene.workspace,
      workspaceRevision: scene.workspaceRevision,
      calls: scene.bindings,
      sourceHashes: Object.fromEntries(Object.entries(scene.files).map(([name, file]) => [name, file.originalHash])),
      bindings,
      capture: {
        preview: frame.preview,
        sourceRevision: frame.sourceRevision,
        screenState: frame.screenState,
        digest: frame.digest,
        densityDpi: frame.densityDpi,
        fontScale,
        ...(fontHash ? { fontHashes: { Roboto: fontHash } } : {}),
        ...(fontScaleCurve ? { fontScaleCurve } : {}),
        textGeometry,
        status: 'needs-browser-verification',
      },
    },
  };
  validate(doc);
  doc.compose.initial = clone(root);
  return doc;
}
