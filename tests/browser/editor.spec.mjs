import { test as base, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { indexTree } from '../../public/model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const original = JSON.parse(await readFile(new URL('../../examples/browser-scenarios.json', import.meta.url), 'utf8'));
const test = base.extend({
  bridge: async ({ page }, use) => {
    const data = await mkdtemp(path.join(tmpdir(), 'compose-bridge-test-'));
    let child, exited;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await writeFile(path.join(data, 'session.json'), JSON.stringify({ revision: 0, baseline: original, current: original, applied: null }));
      child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '0', BRIDGE_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
      exited = once(child, 'exit');
      let output = '';
      const url = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error(`Сервер не запустился: ${output}`)), 10_000);
        const finish = callback => value => { clearTimeout(timeout); callback(value); };
        child.once('error', finish(reject));
        child.once('exit', finish(() => reject(Error(`Сервер завершился: ${output}`))));
        child.stderr.on('data', chunk => { output += chunk; });
        child.stdout.on('data', chunk => {
          output += chunk;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) finish(resolve)(match[0]);
        });
      });
      const state = async () => {
        const response = await fetch(`${url}/api/session`);
        if (!response.ok) throw Error(`Чтение сессии: HTTP ${response.status}`);
        return response.json();
      };
      const saved = () => expect(page.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
      await page.goto(url);
      await saved();
      await page.getByRole('button', { name: 'Только макет', exact: true }).click();
      await page.getByRole('combobox', { name: 'Масштаб', exact: true }).selectOption('0.65');
      await use({ state, saved, url });
      expect(errors, 'Ошибки JavaScript в браузере').toEqual([]);
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
      if (exited) await exited;
      await rm(data, { recursive: true, force: true });
    }
  },
});

async function openAdvanced(page){if(await page.locator('#advancedTools').getAttribute('open')===null)await page.locator('#advancedTools > summary').click();}
const preview = (page, id) => page.locator(`#after [data-node-id="${id}"]`);
const tree = (page, id) => page.locator(`#tree [data-node-id="${id}"]`);
const node = (document, id) => indexTree(document.root).get(id);
test('Явное растягивание детей заполняет ширину текста auto и сохраняет точный размер',async({page,bridge})=>{
  await page.locator('#layoutMode').selectOption('auto');await tree(page,'screen').click();
  await page.locator('#newType').selectOption('Text');await page.locator('#add').click();await bridge.saved();
  const doc=(await bridge.state()).current,id=doc.root.children.at(-1).id;
  const compact=(await preview(page,id).boundingBox()).width;
  await tree(page,'screen').click();await page.locator('#inspector summary').filter({hasText:/^Расположение$/}).click();
  await page.getByLabel('Выравнивание детей',{exact:true}).selectOption('stretch');await bridge.saved();
  expect((await preview(page,id).boundingBox()).width).toBeGreaterThan(compact+50);
  await tree(page,id).click();await page.locator('#inspector summary').filter({hasText:/^Размер$/}).click();
  await page.getByLabel('Ширина: режим',{exact:true}).selectOption('fixed');await page.getByLabel('Ширина',{exact:true}).fill('80');await bridge.saved();
  expect((await preview(page,id).boundingBox()).width).toBeCloseTo(80*.65,0);
});
test('Удаление доступно без раскрытия свойств, сохраняется и отменяется', async ({ page, bridge }) => {
  const remove = page.getByRole('button', { name: 'Удалить элемент', exact: true });
  await expect(remove).toBeDisabled();
  await tree(page, 'source').click();
  await expect(page.locator('#inspector details[open]')).toHaveCount(0);
  await expect(remove).toBeInViewport();
  await remove.click();
  await expect(tree(page, 'source')).toHaveCount(0);
  await expect(preview(page, 'first')).toHaveCount(0);
  await bridge.saved();
  expect(node((await bridge.state()).current, 'source')).toBeUndefined();
  await page.locator('#undo').click();
  await expect(preview(page, 'first')).toBeVisible();
  await page.locator('#redo').click();
  await expect(tree(page, 'source')).toHaveCount(0);
  await bridge.saved();
  await page.reload();
  await expect(tree(page, 'source')).toHaveCount(0);
  await page.locator('#apply').click();
  const handoff = await (await fetch(bridge.url + '/api/handoff')).json();
  expect(node(handoff.document, 'source')).toBeUndefined();
  expect(node(handoff.document, 'first')).toBeUndefined();
  expect(node(handoff.baseline, 'first')).toBeDefined();
  await tree(page, 'title').click();
  const text = page.getByLabel('Текст', { exact: true });
  await text.focus();
  await text.press('Delete');
  await expect(tree(page, 'title')).toHaveCount(1);
  await tree(page, 'title').click();
  await tree(page, 'title').press('Delete');
  await expect(tree(page, 'title')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(tree(page, 'title')).toHaveCount(1);
  await tree(page, 'screen').click();
  await tree(page, 'screen').press('Delete');
  await expect(tree(page, 'screen')).toHaveCount(1);
  await expect(remove).toBeDisabled();
});
async function point(locator, fraction = .5) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width * .75, y: box.y + box.height * fraction };
}
async function startDrag(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const from = await point(locator);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 8, { steps: 3 });
  await expect(page.locator('body')).toHaveClass(/dragging/);
  return from;
}
async function drop(page, from, to, fraction = .5) {
  await to.scrollIntoViewIfNeeded();
  await startDrag(page, from);
  const end = await point(to, fraction);
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/dragging/);
}
async function undo(page, bridge) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/draft') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  expect((await response).ok()).toBe(true);
  await bridge.saved();
  expect((await bridge.state()).current).toEqual(original);
}
async function widthField(page, id = 'second') {
  await tree(page, id).click();
  const section = page.locator('#inspector details').filter({ has: page.locator('summary', { hasText: /^Размер$/ }) });
  if (!(await section.evaluate(element => element.open))) await section.locator('summary').click();
  return page.getByRole('spinbutton', { name: 'Ширина', exact: true });
}
async function relativeRects(page, ids) {
  return page.evaluate(ids => {
    const origin = document.querySelector('#after [data-node-id="screen"]').getBoundingClientRect();
    return ids.map(id => {
      const r = document.querySelector(`#after [data-node-id="${id}"]`).getBoundingClientRect();
      return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
    });
  }, ids);
}

test('Обычный интерфейс скрывает технические инструменты и сохраняет данные для агента', async ({page,bridge}) => {
  await expect(page.locator('#advancedTools')).not.toHaveAttribute('open');
  for(const id of ['baselineStatus','import','export','readReport','exportDiff','reload']) await expect(page.locator('#'+id)).not.toBeVisible();
  await tree(page,'second').click();
  await expect(page.locator('#inspector')).not.toContainText('Связь с кодом');
  await expect(page.locator('#inspector .selected-title')).not.toHaveText('second');
  await expect(tree(page,'second').locator('.tree-label')).not.toHaveText('second');
  await openAdvanced(page);await expect(page.locator('#import')).toBeVisible();await expect(page.locator('#technicalDetails')).toContainText('Связь с кодом');
  expect((await bridge.state()).current).toEqual(original);
});

test('Читаемые панели, курсив и текст по содержимому после изменения размера', async({page,bridge})=>{
  await page.setViewportSize({width:1920,height:1080});
  await tree(page,'screen').click();await page.locator('#newType').selectOption('Text');await page.locator('#add').click();await bridge.saved();
  const current=(await bridge.state()).current, added=[...indexTree(current.root).values()].find(e=>e.node.props.text==='Новый текст').node;
  const text=preview(page,added.id);
  expect((await text.boundingBox()).height).toBeLessThan(40);expect((await text.boundingBox()).width).toBeLessThan(180);
  await page.locator('#inspector summary').filter({hasText:/^Размер$/}).click();
  await page.getByLabel('Высота: режим',{exact:true}).selectOption('fixed');await page.getByLabel('Высота',{exact:true}).fill('240');await bridge.saved();
  expect((await text.boundingBox()).height/.65).toBeCloseTo(240,0);
  await page.getByLabel('Высота: режим',{exact:true}).selectOption('auto');await bridge.saved();expect((await text.boundingBox()).height).toBeLessThan(40);
  await page.locator('#inspector summary').filter({hasText:'Форматирование текста'}).click();
  await page.getByLabel('Семейство шрифта',{exact:true}).selectOption('Roboto');await bridge.saved();await page.evaluate(()=>document.fonts.ready);
  const normal=await text.screenshot();
  await page.getByLabel('Начертание',{exact:true}).selectOption('italic');await bridge.saved();
  expect(await text.evaluate(e=>getComputedStyle(e).fontVariationSettings)).toContain('"ital" 1');expect((await text.screenshot()).equals(normal)).toBe(false);
  for(const family of ['Sans Serif','Serif','Monospace','Cursive']){await page.getByLabel('Семейство шрифта',{exact:true}).selectOption(family);await bridge.saved();expect(indexTree((await bridge.state()).current.root).get(added.id).node.props.fontFamily).toBe(family);}
  await page.getByLabel('Семейство шрифта',{exact:true}).selectOption('Roboto');await bridge.saved();
  expect(await tree(page,added.id).evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(14);
  expect(await page.locator('.prop>span').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(13);
  await page.getByLabel('Текст',{exact:true}).fill('Первая строка\nВторая строка\nТретья строка');await bridge.saved();expect((await text.boundingBox()).height).toBeGreaterThan(35);
  await page.screenshot({path:'/tmp/cvb-typography-desktop.png'});
});

test('B01/B07: узкий viewport и независимая прокрутка', async ({ page, bridge }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
  await preview(page, 'bottom').scrollIntoViewIfNeeded();
  await preview(page, 'bottom').click();
  await expect(preview(page, 'bottom')).toHaveClass(/selected/);
  expect(await page.locator('#canvas').evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  await tree(page, 'bottom').click();
  expect(await page.locator('#tree').evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  expect((await bridge.state()).current).toEqual(original);
});

test('B02: вложенность и выбор верхнего элемента в перекрытии', async ({ page, bridge }) => {
  const overlap = await relativeRects(page, ['first', 'second']);
  expect(overlap[1].x).toBeLessThan(overlap[0].x + overlap[0].width);
  const a = await preview(page, 'first').boundingBox(), b = await preview(page, 'second').boundingBox();
  await page.mouse.click((b.x + a.x + a.width) / 2, b.y + b.height / 2);
  await expect(preview(page, 'second')).toHaveClass(/selected/);
  await expect(page.locator('.resize-handle')).toHaveCount(8);
  await tree(page, 'nested').click();
  await expect(preview(page, 'nested')).toHaveClass(/selected/);
  expect((await bridge.state()).current).toEqual(original);
});

for (const [label, fraction, parent] of [['центр', .5, 'target'], ['край', .07, 'screen']]) {
  test(`B03: перенос из дерева на ${label} контейнера`, async ({ page, bridge }) => {
    await drop(page, tree(page, 'first'), preview(page, 'target'), fraction);
    await bridge.saved();
    const current = (await bridge.state()).current;
    expect(node(current, 'first').parent).toBe(parent);
    if (parent === 'screen') expect(node(current, 'first').index + 1).toBe(node(current, 'target').index);
    await undo(page, bridge);
  });
}

test('B04: Esc отменяет активный drag без записи', async ({ page, bridge }) => {
  const before = await bridge.state();
  const p = await startDrag(page, preview(page, 'second'));
  await page.mouse.move(p.x + 50, p.y + 20, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('#notice')).toHaveText('Перемещение отменено.');
  await expect(page.locator('body')).not.toHaveClass(/dragging/);
  expect(await bridge.state()).toEqual(before);
  await expect(page.locator('#undo')).toBeDisabled();
});

test('B05: перенос между строками дерева и индикатор назначения', async ({ page, bridge }) => {
  await tree(page, 'target').scrollIntoViewIfNeeded();
  await startDrag(page, tree(page, 'movable'));
  const target = await point(tree(page, 'target'));
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(tree(page, 'target')).toHaveAttribute('data-drop', 'inside');
  await expect(page.locator('.drag-ghost')).toHaveText('Внутрь '+await tree(page,'target').locator('.tree-label').textContent());
  await page.mouse.up();
  await bridge.saved();
  expect(node((await bridge.state()).current, 'movable').parent).toBe('target');
  await expect(page.locator('[data-drop], .drag-ghost')).toHaveCount(0);
  await undo(page, bridge);
});

test('B06: жест с макета к дереву меняет смещение, сохраняет структуру', async ({ page, bridge }) => {
  await drop(page, preview(page, 'second'), tree(page, 'title'));
  await bridge.saved();
  const current = (await bridge.state()).current;
  expect([...indexTree(current.root)].map(([id, e]) => [id, e.parent, e.index]))
    .toEqual([...indexTree(original.root)].map(([id, e]) => [id, e.parent, e.index]));
  expect(node(current, 'second').node.props.offsetX).not.toBe(-40);
  await undo(page, bridge);
});

test('B08: resize сохраняет соседей; Undo/Redo восстанавливают точный документ', async ({ page, bridge }) => {
  await tree(page, 'second').click();
  const before = await relativeRects(page, ['first', 'source', 'target']);
  const handle = page.locator('.resize-handle[data-direction="e"]');
  const p = await point(handle);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 26, p.y, { steps: 8 });
  await page.mouse.up();
  await bridge.saved();
  const resized = (await bridge.state()).current;
  expect(node(resized, 'second').node.props.width).toBe(170);
  const after = await relativeRects(page, ['first', 'source', 'target']);
  after.forEach((r, i) => Object.keys(r).forEach(key => expect(Math.abs(r[key] - before[i][key])).toBeLessThan(.05)));
  await undo(page, bridge);
  const response = page.waitForResponse(r => r.url().endsWith('/api/draft') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  expect((await response).ok()).toBe(true);
  await bridge.saved();
  expect((await bridge.state()).current).toEqual(resized);
  await undo(page, bridge);
});

test('B09: дробный размер сохраняет раскрытие и фокус поля', async ({ page, bridge }) => {
  const field = await widthField(page);
  await field.fill('140.5');
  await expect(field).toBeFocused();
  await field.press('Tab');
  await bridge.saved();
  expect(node((await bridge.state()).current, 'second').node.props.width).toBe(140.5);
  const sections = await page.locator('#inspector details').evaluateAll(elements => elements.map(e => [e.querySelector('summary').textContent, e.open]));
  expect(sections).toContainEqual(['Размер', true]);
  expect(sections).toContainEqual(['Оформление', false]);
  await undo(page, bridge);
});

test('B10: Esc отменяет resize; клавиатурная ручка создаёт одно действие', async ({ page, bridge }) => {
  await tree(page, 'second').click();
  const p = await point(page.locator('.resize-handle[data-direction="e"]'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 26, p.y, { steps: 5 });
  await expect(page.locator('body')).toHaveClass(/resizing/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('#notice')).toHaveText('Изменение размера отменено.');
  expect((await bridge.state()).current).toEqual(original);
  await page.getByRole('button', { name: 'Изменить размер справа', exact: true }).press('ArrowRight');
  await bridge.saved();
  expect(node((await bridge.state()).current, 'second').node.props.width).toBe(131);
  await undo(page, bridge);
});

test('B11: сохранённая геометрия и Undo/Redo восстанавливаются после перезагрузки', async ({ page, bridge }) => {
  const initial=(await bridge.state()).current;
  const field = await widthField(page);
  await field.fill('140.5');
  await field.press('Tab');
  await bridge.saved();
  const saved = (await bridge.state()).current;
  const before = await relativeRects(page, ['second']);
  await page.reload();
  await bridge.saved();
  await page.getByRole('button', { name: 'Только макет', exact: true }).click();
  await page.getByRole('combobox', { name: 'Масштаб', exact: true }).selectOption('0.65');
  expect((await bridge.state()).current).toEqual(saved);
  const after = await relativeRects(page, ['second']);
  Object.keys(before[0]).forEach(key => expect(Math.abs(after[0][key] - before[0][key])).toBeLessThan(.05));
  await expect(page.locator('#undo')).toBeEnabled();await page.locator('#undo').click();await bridge.saved();expect((await bridge.state()).current).toEqual(initial);
  await page.reload();await bridge.saved();await expect(page.locator('#redo')).toBeEnabled();await page.locator('#redo').click();await bridge.saved();expect((await bridge.state()).current).toEqual(saved);
});

test('Дробные свойства сохраняются и передаются без stepMismatch; число строк остаётся целым', async ({ page, bridge }) => {
  await tree(page, 'second').click();
  const open = async title => {
    const section = page.locator('#inspector details').filter({has: page.locator('summary', {hasText: title})});
    if (!(await section.evaluate(e => e.open))) await section.locator('summary').click();
  };
  await open(/^Оформление$/);
  await page.getByLabel('Радиус · dp', {exact:true}).fill('23.714285714285715');
  await bridge.saved();
  await open(/^Форматирование текста$/);
  await page.getByLabel('Высота строки', {exact:true}).fill('23.714285714285715');
  await bridge.saved();
  const lines = page.getByLabel('Максимум строк', {exact:true});
  await lines.fill('1.5');
  await expect(lines).toHaveAttribute('aria-invalid', 'true');
  await lines.fill('2');
  await bridge.saved();
  const state = await bridge.state();
  state.current.viewport = {width:347.42857142857144,height:754.2857142857143};
  expect((await fetch(bridge.url+'/api/draft', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,document:state.current})})).ok).toBe(true);
  await page.reload(); await bridge.saved();
  expect(await page.locator('#inspector :invalid').count()).toBe(0);
  await tree(page, 'second').click();
  expect(await page.locator('#inspector :invalid').count()).toBe(0);
  await page.locator('#apply').click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const handoff = await (await fetch(bridge.url+'/api/handoff')).json();
  expect(node(handoff.document, 'second').node.props.radius).toBe(23.714285714285715);
  expect(node(handoff.document, 'second').node.props.lineHeight).toBe(23.714285714285715);
});

test('B12: тестовый Apply сохраняет неизменный снимок, поздняя правка остаётся черновиком', async ({ page, bridge }) => {
  let field = await widthField(page);
  await field.fill('140.5');
  await field.press('Tab');
  await bridge.saved();
  await page.getByRole('button', { name: 'Передать агенту ↗', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const response = await fetch(`${bridge.url}/api/handoff`);
  expect(response.ok).toBe(true);
  const handoff = await response.json();
  expect((await bridge.state()).applied.mode).toBe('test');
  field = await widthField(page);
  await field.fill('150.5');
  await field.press('Tab');
  await bridge.saved();
  expect(await (await fetch(`${bridge.url}/api/handoff`)).json()).toEqual(handoff);
  await page.reload();
  await bridge.saved();
  expect(node((await bridge.state()).current, 'second').node.props.width).toBe(150.5);
  await page.locator('#toggleChanges').click();
  await expect(page.locator('#handoffStatus')).toContainText('черновик отличается от снимка');
});

test('B13: Undo/Redo сразу отмечают несохранённую правку', async ({ page, bridge }) => {
  const field = await widthField(page);
  await field.fill('140.5');
  await field.press('Tab');
  await bridge.saved();
  for (const name of ['Отменить', 'Повторить']) {
    const revision = (await bridge.state()).revision;
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('#saveStatus')).toHaveText('Есть несохранённые правки', { timeout: 400 });
    await expect.poll(async () => (await bridge.state()).revision).toBe(revision + 1);
    await bridge.saved();
  }
});

test('B14: незавершённое число не удаляет размер и показывает ошибку', async ({ page, bridge }) => {
  const field = await widthField(page);
  await field.press('ControlOrMeta+A');
  await field.press('-');
  expect(await field.evaluate(e => e.validity.badInput)).toBe(true);
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error').filter({ visible: true })).toHaveText('Введите корректное число');
  await field.press('Tab');
  expect((await bridge.state()).current).toEqual(original);
  await field.fill('140.5');
  await field.press('Tab');
  await bridge.saved();
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  expect(node((await bridge.state()).current, 'second').node.props.width).toBe(140.5);
});

test('B15: пустой размер, ноль, дробь и границы сохраняются корректно', async ({ page, bridge }) => {
  for (const value of ['0', '0.5', '4000', '']) {
    const field = await widthField(page);
    await field.fill(value);
    await field.press('Tab');
    await bridge.saved();
    const props = node((await bridge.state()).current, 'second').node.props;
    if (value === '') expect(props).not.toHaveProperty('width');
    else expect(props.width).toBe(Number(value));
    await undo(page, bridge);
  }
  for (const value of ['-1', '4000.1']) {
    const field = await widthField(page);
    await field.fill(value);
    await field.press('Tab');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#undo')).toBeDisabled();
    expect((await bridge.state()).current).toEqual(original);
  }
});

for (const cancel of ['Escape', 'pointercancel']) {
  test(`B16: ${cancel} восстанавливает статус и очищает активный жест`, async ({ page, bridge }) => {
    for (const kind of ['drag', 'resize']) {
      await tree(page, 'second').click();
      if (kind === 'drag') await startDrag(page, preview(page, 'second'));
      else {
        const p = await point(page.locator('.resize-handle[data-direction="e"]'));
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(p.x + 20, p.y, { steps: 5 });
        await expect(page.locator('body')).toHaveClass(/resizing/);
      }
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.locator('body').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
      await page.mouse.up();
      await expect(page.locator('body')).not.toHaveClass(/dragging|resizing/);
      await bridge.saved();
      expect((await bridge.state()).current).toEqual(original);
      await expect(page.locator('#undo')).toBeDisabled();
      await expect(page.locator('[data-drop], .drag-ghost')).toHaveCount(0);
    }
  });
}

test('B17: режим точного размера согласован с полем и макетом', async ({ page, bridge }) => {
  await page.getByRole('combobox', { name: 'Компоновка', exact: true }).selectOption('auto');
  await bridge.saved();
  await widthField(page, 'title');
  const mode = page.getByRole('combobox', { name: 'Ширина: режим', exact: true });
  await mode.selectOption('fixed');
  await bridge.saved();
  await expect(page.getByRole('spinbutton', { name: 'Ширина', exact: true })).toHaveValue('100');
  expect((await preview(page, 'title').boundingBox()).width).toBeCloseTo(65, 1);
  for (const value of ['auto', 'fill', '']) {
    await mode.selectOption(value);
    await bridge.saved();
    expect(node((await bridge.state()).current, 'title').node.props.width).toBe(value || undefined);
    await expect(page.getByRole('spinbutton', { name: 'Ширина', exact: true })).toHaveCount(0);
  }
});

test('B18: завершение сохранения во время drag учитывается при отмене', async ({ page, bridge }) => {
  const field = await widthField(page);
  const revision = (await bridge.state()).revision;
  await field.fill('140.5');
  await field.press('Tab');
  await startDrag(page, preview(page, 'second'));
  await expect.poll(async () => (await bridge.state()).revision).toBe(revision + 1);
  const before = await bridge.state();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await bridge.saved();
  expect(await bridge.state()).toEqual(before);
});

test('B19: дерево выбирается стрелками и сохраняет клавиатурный фокус', async ({ page, bridge }) => {
  await tree(page, 'screen').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree(page, 'title')).toBeFocused();
  await expect(tree(page, 'title')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tree(page, 'bottom')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(tree(page, 'title')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tree(page, 'screen')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(tree(page, 'title')).toBeFocused();
  await expect(page.locator('#tree [tabindex="0"]')).toHaveCount(1);
  expect((await bridge.state()).current).toEqual(original);
});

test('B20: кнопки перестановки сохраняют фокус и работают повторно без мыши', async ({ page, bridge }) => {
  await tree(page, 'sourceLabel').click();
  await page.locator('#inspector summary').filter({ hasText: /^Перемещение$/ }).click();
  const later = page.getByRole('button', { name: '↓ Позже', exact: true });
  await later.focus();
  await page.keyboard.press('Space');
  await bridge.saved();
  await expect(later).toBeFocused();
  expect(node((await bridge.state()).current, 'sourceLabel').index).toBe(1);
  await page.keyboard.press('Space');
  await bridge.saved();
  expect(node((await bridge.state()).current, 'sourceLabel').index).toBe(2);
  await expect(page.getByRole('button', { name: '↑ Раньше', exact: true })).toBeFocused();
});

test('Длинная подпись в дереве не расширяет узкую страницу', async ({ page, bridge }) => {
  await tree(page, 'second').click();
  await page.getByLabel('Текст', { exact: true }).fill('Подключите домашний сервер, чтобы управлять сервисами с телефона');
  await bridge.saved();
  for (const width of [440, 360]) {
    await page.setViewportSize({ width, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `Ширина страницы при ${width}px`).toBe(width);
  }
});

test('B21: узкая панель не обрезает русские подписи и поля', async ({ page, bridge }) => {
  for (const width of [900, 641, 640, 480, 440, 360]) {
    await page.setViewportSize({ width, height: 720 });
    await tree(page, 'second').click();
    for (const name of ['Размер', 'Расположение', 'Перемещение']) {
      const summary = page.locator('#inspector summary').filter({ hasText: new RegExp(`^${name}$`) });
      if (!(await summary.evaluate(e => e.parentElement.open))) await summary.click();
    }
    const checks = await page.locator('#inspector details[open]').evaluateAll(elements => elements.flatMap(e => [...e.querySelectorAll('label, input, select, button, summary')]).filter(e => e.getBoundingClientRect().width && !e.hidden).map(e => ({ tag: e.tagName, text: e.textContent?.slice(0,60), width: e.clientWidth, scroll: e.scrollWidth })));
    expect(checks.filter(e => e.scroll > e.width + 1), `Переполнение при ${width}px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `Ширина страницы при ${width}px`).toBe(width);
  }
  expect((await bridge.state()).current).toEqual(original);
});

test('B22: родитель меняется с клавиатуры; Ctrl+Z работает в списке родителей', async ({ page, bridge }) => {
  await tree(page, 'movable').click();
  await page.locator('#inspector summary').filter({ hasText: /^Перемещение$/ }).click();
  const parent = page.locator('#parentSelect');
  await parent.focus();
  await page.keyboard.press('End');
  await bridge.saved();
  expect(node((await bridge.state()).current, 'movable').parent).toBe('target');
  await expect(parent).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await bridge.state()).current).toEqual(original);
  await expect(parent).toBeFocused();
});

test('B23: Undo добавления возвращает фокус к существующему узлу дерева', async ({ page, bridge }) => {
  await page.locator('#add').click();
  await bridge.saved();
  await page.locator('#tree [aria-selected="true"]').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await bridge.state()).current).toEqual(original);
  await expect(tree(page, 'screen')).toBeFocused();
  await expect(tree(page, 'screen')).toHaveAttribute('tabindex', '0');
  await expect(tree(page, 'screen')).toHaveAttribute('aria-selected', 'true');
});

test('B24: недоступная компоновка объясняется справкой рядом с переключателем', async ({ page, bridge }) => {
  await tree(page, 'source').click();
  const section = page.locator('#inspector details').filter({ has: page.locator('summary', { hasText: /^Расположение$/ }) });
  await section.locator('summary').click();
  for (const name of ['Выравнивание детей', 'Распределение']) await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: 'Между детьми · dp', exact: true })).toBeDisabled();
  for (const name of ['Смещение по горизонтали · dp', 'Смещение по вертикали · dp']) await expect(page.getByRole('spinbutton', { name, exact: true })).toBeEnabled();
  await expect(page.locator('#inspector .prop-help')).toHaveCount(0);
  await page.getByRole('button', { name: 'Справка: Компоновка', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Компоновка', exact: true });
  await expect(help).toContainText('Выравнивание «по центру», распределение и интервал между детьми в этом режиме отключены.');
  await help.getByRole('button', { name: 'Включить автоматическую компоновку', exact: true }).click();
  await expect(help).not.toBeVisible();
  await bridge.saved();
  await expect(page.getByRole('combobox', { name: 'Компоновка', exact: true })).toHaveValue('auto');
  await expect(section).toHaveAttribute('open', '');
  await page.getByRole('combobox', { name: 'Выравнивание детей', exact: true }).selectOption('center');
  await page.getByRole('combobox', { name: 'Распределение', exact: true }).selectOption('center');
  await page.getByRole('spinbutton', { name: 'Между детьми · dp', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: 'Между детьми · dp', exact: true }).press('Tab');
  await bridge.saved();
  const props = node((await bridge.state()).current, 'source').node.props;
  expect([props.align, props.justify, props.gap]).toEqual(['center', 'center', 24]);
  expect(await preview(page, 'source').evaluate(element => {
    const style = getComputedStyle(element); return [style.alignItems, style.justifyContent, style.gap];
  })).toEqual(['center', 'center', '24px']);
  for (let i = 0; i < 3; i++) {
    const response = page.waitForResponse(r => r.url().endsWith('/api/draft') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    expect((await response).ok()).toBe(true);
    await bridge.saved();
  }
  expect((await bridge.state()).current.layout.mode).toBe('auto');
  await undo(page, bridge);
  expect((await bridge.state()).current).toEqual(original);
  await expect(page.getByRole('combobox', { name: 'Выравнивание детей', exact: true })).toBeDisabled();
});


test('B25: справка скрыта, доступна с клавиатуры и не раскрывает разделы', async ({ page, bridge }) => {
  await tree(page, 'second').click();
  await expect(page.locator('#inspector .prop-help')).toHaveCount(0);
  await expect(page.locator('#helpDialog')).not.toBeVisible();
  const size = page.locator('#inspector details').filter({ has: page.locator('summary', { hasText: /^Размер$/ }) });
  await expect(size).not.toHaveAttribute('open');
  const helpButton = page.getByRole('button', { name: 'Справка: Размер', exact: true });
  await helpButton.focus(); await page.keyboard.press('Enter');
  const help = page.getByRole('dialog', { name: 'Размер', exact: true });
  await expect(help).toBeVisible(); await expect(help).toContainText('Доля свободного места');
  await expect(size).not.toHaveAttribute('open');
  await page.keyboard.press('Escape');
  await expect(help).not.toBeVisible(); await expect(helpButton).toBeFocused();
  await page.keyboard.press('Space'); await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Закрыть справку', exact: true }).click();
  await expect(helpButton).toBeFocused();
  for (const name of ['Расположение', 'Перемещение', 'Форматирование текста', 'Редактирование макета']) {
    await page.getByRole('button', { name: `Справка: ${name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#helpLayoutAction')).not.toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Мои правки' }).click();
  await page.getByRole('button', { name: 'Справка: Передача агенту', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Передача агенту', exact: true })).toContainText('не запускает агента');
  await page.keyboard.press('Escape');
  expect((await bridge.state()).current).toEqual(original);
  expect((await bridge.state()).revision).toBe(0);
  await page.setViewportSize({ width: 900, height: 720 });
  await page.screenshot({ path: '/tmp/compose-bridge-info-compact.png' });
  await page.setViewportSize({ width: 480, height: 600 });
  await helpButton.click();
  expect(await help.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(448);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480);
  expect(await help.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('B26: одна передача сохраняет сведения о проверке исходника автоматически', async ({page,bridge}) => {
  await expect(page.locator('#testMode')).toHaveCount(0);
  await page.locator('#apply').click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  expect((await bridge.state()).applied.mode).toBe('test');
  const image=await page.locator('#after .phone').screenshot();
  await openAdvanced(page);await page.locator('#baselineStatus').click();
  await expect(page.getByRole('dialog',{name:'Проверка исходного макета'})).toBeVisible();
  await expect(page.locator('#baselineConfirm')).toBeDisabled();
  await page.locator('#referenceLabel').fill('Автотест · тестовый экран · 412 × 1100 dp');
  // Synthetic reference tests the workflow; it is not evidence of Android fidelity.
  await page.locator('#referenceFile').setInputFiles({name:'native.png',mimeType:'image/png',buffer:image});
  await expect(page.locator('#baselineConfirm')).toBeEnabled();
  await page.locator('#baselineDialog').screenshot({path:'/tmp/compose-bridge-baseline-verification.png'});
  await page.locator('#baselineConfirm').click();
  await expect(page.locator('#baselineError')).toContainText('Подтвердите совпадение');
  await page.locator('#baselineAcknowledged').check();
  await page.locator('#baselineConfirm').click();
  await expect(page.locator('#baselineDialog')).not.toBeVisible();
  await expect(page.locator('#baselineStatus')).toHaveText('Исходник проверен');
  await tree(page,'first').click();
  await page.getByLabel('Текст', {exact:true}).fill('Согласованная правка');
  await page.locator('#apply').click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const snapshot=await (await fetch(bridge.url+'/api/handoff')).json();
  expect(snapshot.verification.confirmedBy).toBe('user');
  expect(snapshot.intent.changes.some(c=>c.property==='text' && c.after==='Согласованная правка')).toBe(true);
  expect(snapshot.intent.changes.some(c=>c.property==='layout')).toBe(false);
  expect(snapshot.intent.technical).toHaveLength(1);
  await expect(page.locator('#diffBadge')).toHaveText('1');
  await expect(page.locator('#changeCount')).toHaveText('Правок: 1');
  expect((await fetch(bridge.url+snapshot.reference.url)).status).toBe(200);
  await page.reload();
  await expect(page.locator('#baselineStatus')).toHaveText('Исходник проверен');
  expect((await bridge.state()).applied.directory).toBe(snapshot.applied.directory);
});

test('B27: быстрый ввод и Apply передают последнюю правку, поздний черновик не меняет снимок', async ({page,bridge}) => {
  await tree(page,'first').click();
  const text=page.getByLabel('Текст',{exact:true});
  await text.fill('П'); await text.fill('Последняя правка');
  await page.locator('#apply').click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const snapshot=await (await fetch(bridge.url+'/api/handoff')).json();
  expect(node(snapshot.document,'first').node.props.text).toBe('Последняя правка');
  await text.fill('Поздний черновик'); await bridge.saved();
  expect(await (await fetch(bridge.url+'/api/handoff')).json()).toEqual(snapshot);
  await page.locator('#toggleChanges').click();
  await expect(page.locator('#handoffStatus')).toContainText('черновик отличается');
});

test('B28: отказ сохранения не теряет локальную работу и последний снимок', async ({page,bridge}) => {
  await page.locator('#apply').click();
  await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const snapshot=await (await fetch(bridge.url+'/api/handoff')).json();
  await page.route('**/api/draft',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Проверочный отказ записи'})}));
  await tree(page,'first').click();
  await page.getByLabel('Текст',{exact:true}).fill('Несохранённая работа');
  await expect(page.locator('#saveStatus')).toHaveText('Не сохранено');
  await expect(page.locator('#notice')).toContainText('Проверочный отказ записи');
  expect(await (await fetch(bridge.url+'/api/handoff')).json()).toEqual(snapshot);
  const download=page.waitForEvent('download'); await openAdvanced(page);await page.locator('#export').click();
  const stream=await (await download).createReadStream(); let exported=''; for await(const chunk of stream)exported+=chunk;
  expect(node(JSON.parse(exported),'first').node.props.text).toBe('Несохранённая работа');
  await page.unroute('**/api/draft'); await page.reload();
  await expect(page.locator('#notice')).toContainText('Восстановлены последние локальные правки');
  await expect.poll(async()=>node((await bridge.state()).current,'first').node.props.text).toBe('Несохранённая работа');
  expect(await (await fetch(bridge.url+'/api/handoff')).json()).toEqual(snapshot);
});

test('B29: конфликт двух окон сохраняет серверный вариант и позволяет восстановиться', async ({page,bridge,context}) => {
  const second=await context.newPage(); await second.goto(bridge.url);
  await expect(second.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  await tree(page,'first').click(); await page.getByLabel('Текст',{exact:true}).fill('Первое окно'); await bridge.saved();
  await tree(second,'first').click(); await second.getByLabel('Текст',{exact:true}).fill('Второе окно');
  await expect(second.locator('#notice')).toContainText('Сессия изменилась');
  expect(node((await bridge.state()).current,'first').node.props.text).toBe('Первое окно');
  await second.locator('#apply').click();
  await expect(second.locator('#notice')).toContainText('Обнаружен конфликт');
  await second.locator('#toggleChanges').click(); await openAdvanced(second);await second.locator('#reload').click();
  await expect(second.locator('#saveStatus')).toHaveText('Синхронизировано ✓');
  await tree(second,'first').click();
  await expect(second.getByLabel('Текст',{exact:true})).toHaveValue('Первое окно');
  await second.getByLabel('Текст',{exact:true}).fill('После восстановления');
  await expect.poll(async()=>node((await bridge.state()).current,'first').node.props.text).toBe('После восстановления');
  await second.close();
});

test('B30: импорт исправленного исходника сохраняет прежние правки и снимок для восстановления', async ({page,bridge}) => {
  await tree(page,'first').click(); await page.getByLabel('Текст',{exact:true}).fill('Моя сохранённая правка'); await bridge.saved();
  await page.locator('#apply').click(); await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const snapshot=await (await fetch(bridge.url+'/api/handoff')).json();
  const corrected=structuredClone(original); corrected.name='Исправленный исходник';
  await page.locator('#file').setInputFiles({name:'corrected.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(corrected))});
  await expect(page.locator('#notice')).toContainText('Загружен макет');
  expect((await bridge.state()).current.name).toBe('Исправленный исходник');
  await page.locator('#toggleChanges').click(); await openAdvanced(page);await page.locator('#restoreSession').click();
  await expect(page.locator('#notice')).toContainText('Предыдущая сессия восстановлена');
  expect(node((await bridge.state()).current,'first').node.props.text).toBe('Моя сохранённая правка');
  expect(await (await fetch(bridge.url+'/api/handoff')).json()).toEqual(snapshot);
  await openAdvanced(page);await page.locator('#restoreSession').click();
  await expect.poll(async()=>(await bridge.state()).current.name).toBe('Исправленный исходник');
});


test('B31: нативная область не содержит условных системных панелей и рамки', async ({page,bridge}) => {
  const native=structuredClone(original); native.viewport.presentation='content'; native.root.props.height=native.viewport.height;
  await page.locator('#file').setInputFiles({name:'native.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(native))});
  await expect(page.locator('#notice')).toContainText('Загружен макет');
  await expect(page.locator('#after .statusbar')).toHaveCount(0); await expect(page.locator('#after .home-indicator')).toHaveCount(0);
  const phone=await page.locator('#after .phone').boundingBox(), screen=await preview(page,'screen').boundingBox();
  expect(Math.abs(phone.x-screen.x)).toBeLessThan(.1); expect(Math.abs(phone.y-screen.y)).toBeLessThan(.1);
  expect(Math.abs(phone.width-screen.width)).toBeLessThan(.1); expect(Math.abs(phone.height-screen.height)).toBeLessThan(.1);
  await tree(page,'first').click(); await page.getByLabel('Текст',{exact:true}).fill('Нативная область'); await bridge.saved();
  await page.reload(); await expect(page.locator('#after .statusbar')).toHaveCount(0);
  expect((await bridge.state()).current.viewport.presentation).toBe('content');
});


test('B32: встроенный Roboto сохраняет однострочную надпись и доступен в инспекторе', async ({page,bridge}) => {
  const native=structuredClone(original); native.viewport.presentation='content'; native.root.props.fontFamily='Roboto';
  // Реальная ширина надписи из Android API 36; другой Roboto обрезал её.
  Object.assign(node(native,'first').node.props,{text:'Подключение',fontFamily:'Roboto',fontSize:13.5,fontWeight:500,lineHeight:18,width:88.28571,height:18,maxLines:1,letterSpacing:0});
  await page.locator('#file').setInputFiles({name:'native-typography.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(native))});
  await expect(page.locator('#notice')).toContainText('Загружен макет');
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.fonts.check('500 13.5px Roboto'))).toBe(true);
  const typography=await preview(page,'first').evaluate(element=>{const range=document.createRange();range.selectNodeContents(element.querySelector('.text-content') || element);return {font:getComputedStyle(element).fontFamily,textWidth:range.getBoundingClientRect().width,width:element.getBoundingClientRect().width,lines:range.getClientRects().length};});
  expect(typography.font).toContain('Roboto'); expect(typography.lines).toBe(1); expect(typography.textWidth).toBeLessThanOrEqual(typography.width+.3);
  await tree(page,'first').click(); await page.locator('#inspector summary').filter({hasText:'Форматирование текста'}).click();
  await page.getByLabel('Семейство шрифта',{exact:true}).selectOption('Roboto');
  await page.getByLabel('Межбуквенный интервал · sp',{exact:true}).fill('0.3'); await bridge.saved();
  expect(node((await bridge.state()).current,'first').node.props.letterSpacing).toBe(.3);
  await expect(preview(page,'first')).toHaveCSS('letter-spacing','0.3px');
  await page.getByLabel('Обрезка текста',{exact:true}).selectOption('ellipsis'); await bridge.saved();
  await expect(preview(page,'first').locator('.text-content')).toHaveCSS('text-overflow','ellipsis');
  expect((await fetch(bridge.url+'/fonts/Roboto-Italic.ttf')).headers.get('content-type')).toContain('font/ttf');
});

test('B33: fontScale учитывается в sp без изменения передаваемых значений', async ({page,bridge}) => {
  const native=structuredClone(original); native.viewport.fontScale=1.25; native.root.props.fontFamily='Roboto Flex';
  Object.assign(node(native,'first').node.props,{fontSize:12,lineHeight:16,letterSpacing:.2,maxLines:2,textOverflow:'clip'});
  await page.locator('#file').setInputFiles({name:'font-scale.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(native))});
  await expect(page.locator('#notice')).toContainText('Загружен макет'); await page.evaluate(()=>document.fonts.ready);
  await expect(preview(page,'first')).toHaveCSS('font-size','15px'); await expect(preview(page,'first')).toHaveCSS('line-height','20px'); await expect(preview(page,'first')).toHaveCSS('letter-spacing','0.25px');
  expect(await page.evaluate(()=>document.fonts.check('15px "Roboto Flex"'))).toBe(true);
  await tree(page,'first').click(); await page.locator('#inspector summary').filter({hasText:'Форматирование текста'}).click();
  await page.getByLabel('Шрифт · sp',{exact:true}).fill('14'); await bridge.saved();
  await expect(preview(page,'first')).toHaveCSS('font-size','17.5px');
  expect(node((await bridge.state()).current,'first').node.props.fontSize).toBe(14);
  await page.locator('#apply').click(); await expect(page.locator('#saveStatus')).toHaveText('Передано агенту ✓');
  const handoff=await (await fetch(bridge.url+'/api/handoff')).json(); expect(handoff.document.viewport.fontScale).toBe(1.25);
  expect(handoff.intent.changes.find(change=>change.property==='fontSize').after).toBe(14);
});

test('Импорт сразу после ввода архивирует последнюю правку и сохраняет её при отказе записи', async ({page,bridge}) => {
  const initial=await bridge.state(),text=[...indexTree(initial.current.root).values()].find(e=>e.node.type==='Text').node;
  await page.locator(`#after [data-node-id="${text.id}"]`).click();
  const imported={...initial.baseline,name:'Новый макет аудита'};
  const editAndImport=async value=>page.evaluate(({value,document})=>{
    const input=window.document.querySelector('#inspector [data-property="text"]');
    input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(document)],'import.json',{type:'application/json'}));
    const file=window.document.getElementById('file');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
  },{value,document:imported});
  await page.route('**/api/draft',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Запись недоступна'})}));
  await editAndImport('Правка при ошибке');await expect(page.locator('#notice')).toContainText('Запись недоступна');
  expect((await bridge.state()).current.name).toBe(initial.current.name);
  await expect(page.locator('#inspector [data-property="text"]')).toHaveValue('Правка при ошибке');
  await expect(page.locator('body')).not.toHaveAttribute('inert');
  await page.unroute('**/api/draft');
  let release,started;
  const gate=new Promise(resolve=>release=resolve),requestStarted=new Promise(resolve=>started=resolve);
  await page.route('**/api/draft',async route=>{started();await gate;await route.continue();});
  await editAndImport('Последняя правка перед импортом');
  await requestStarted;
  await expect(page.locator('body')).toHaveAttribute('inert','');
  await page.keyboard.press('Control+z');
  release();
  await expect.poll(async()=>(await bridge.state()).current.name).toBe(imported.name);
  await expect(page.locator('body')).not.toHaveAttribute('inert');
  await page.unroute('**/api/draft');
  await openAdvanced(page);await page.locator('#restoreSession').click();
  await expect.poll(async()=>indexTree((await bridge.state()).current.root).get(text.id)?.node.props.text).toBe('Последняя правка перед импортом');
});

test('Конфликт сохранения останавливает импорт и оставляет локальную правку для экспорта', async ({page,bridge}) => {
  const initial=await bridge.state(),text=[...indexTree(initial.current.root).values()].find(e=>e.node.type==='Text').node;
  await page.locator(`#after [data-node-id="${text.id}"]`).click();
  const remote=structuredClone(initial.current);remote.name='Изменённая серверная сессия';
  const response=await fetch(bridge.url+'/api/draft',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:initial.revision,document:remote})});
  expect(response.status).toBe(200);
  let imports=0;page.on('request',request=>{if(request.method()==='PUT'&&new URL(request.url()).pathname==='/api/session')imports++;});
  await page.evaluate(document=>{
    const input=window.document.querySelector('#inspector [data-property="text"]');input.value='Локальная правка при конфликте';input.dispatchEvent(new Event('input',{bubbles:true}));
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(document)],'import.json',{type:'application/json'}));
    const file=window.document.getElementById('file');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
  },{...initial.baseline,name:'Импорт не должен выполняться'});
  await expect(page.locator('#notice')).toContainText('Сессия изменилась');
  await expect(page.locator('body')).not.toHaveAttribute('inert');
  await expect(page.locator('#inspector [data-property="text"]')).toHaveValue('Локальная правка при конфликте');
  expect(imports).toBe(0);expect((await bridge.state()).current).toEqual(remote);
  await openAdvanced(page);const downloaded=page.waitForEvent('download');await page.locator('#export').click();
  const stream=await (await downloaded).createReadStream();let exported='';for await(const chunk of stream)exported+=chunk;
  expect(indexTree(JSON.parse(exported).root).get(text.id).node.props.text).toBe('Локальная правка при конфликте');
});

test('Повторная передача неизменённого черновика объясняется отдельным сообщением', async ({ page, bridge }) => {
  await tree(page, 'title').click();
  const field = page.getByLabel('Текст', { exact: true });
  await field.fill('Повторная передача'); await field.blur(); await bridge.saved();
  await page.locator('#apply').click();
  await expect(page.locator('#notice')).toHaveText('Снимок сохранён.');
  await page.locator('#apply').click();
  await expect(page.locator('#notice')).toHaveText('Снимок сохранён повторно: черновик не менялся с прошлой передачи.');
  await field.fill('Новая правка'); await field.blur(); await bridge.saved();
  await page.locator('#apply').click();
  await expect(page.locator('#notice')).toHaveText('Снимок сохранён.');
});
