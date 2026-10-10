import test from 'node:test';
import { shiftedOffsets, resizeRect } from './public/geometry.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, mkdir, rename, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReport } from './public/report.mjs';
import { clone, validate, diff, move, History, indexTree } from './public/model.mjs';

const demo = JSON.parse(await readFile(new URL('./examples/server-screen.json', import.meta.url)));
test('validation rejects duplicate IDs, unsupported properties and non-finite sizes', () => {
  assert.equal(validate(clone(demo)).root.id, 'screen');
  const duplicate = clone(demo); duplicate.root.children[0].id = 'screen'; assert.throws(() => validate(duplicate), /ID/);
  const unknown = clone(demo); unknown.root.props.position = 'absolute'; assert.throws(() => validate(unknown), /Неизвестное/);
  const badSize = clone(demo); badSize.root.props.width = NaN; assert.throws(() => validate(badSize), /допустимо/);
  const script = clone(demo); script.root.children.push({ id: 'img', type: 'Image', props: { src: 'javascript:alert(1)' } }); assert.throws(() => validate(script), /https/);
});
test('property diff carries source and baseline revision', () => {
  const edited = clone(demo); indexTree(edited.root).get('connectButton').node.props.width = 'fill';
  const result = diff(demo, edited); assert.equal(result.sourceRevision, 'demo-only'); assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0], { id: 'connectButton', source: indexTree(demo.root).get('connectButton').node.source, operation: 'property', property: 'width', before: 'auto', after: 'fill' });
});
test('real-screen spacing, fractional typography and scrolling validate without coercion', () => {
  const doc = clone(demo);
  Object.assign(doc.root.props, {paddingHorizontal:16, paddingVertical:12, scrollable:true, borderWidth:1, borderColor:'#D6D9D3', fontSize:13.5, fontWeight:500, lineHeight:18});
  assert.equal(validate(doc).root.props.fontSize, 13.5);
  doc.root.props.scrollable = 'true'; assert.throws(() => validate(doc), /boolean/);
  doc.root.props.scrollable = true; doc.root.props.paddingHorizontal = 301; assert.throws(() => validate(doc), /допустимо/);
});
test('reorder produces a single semantic child order and reparent prevents cycles', () => {
  const edited = move(demo, 'connectButton', 'serverCard', 0);
  assert.equal(indexTree(edited.root).get('connectButton').index, 0);
  assert.equal(diff(demo, edited).changes.length, 1);
  assert.equal(diff(demo, edited).changes[0].operation, 'children');
  const reparented = move(demo, 'connectButton', 'preferences', 0);
  assert.equal(indexTree(reparented.root).get('connectButton').parent, 'preferences');
  assert.ok(diff(demo, reparented).changes.some(c => c.operation === 'reparent'));
  assert.throws(() => move(demo, 'serverCard', 'cardHeading', 0), /потомка/);
  assert.throws(() => move(demo, 'screen', 'preferences', 0), /переместить/);
  assert.equal(indexTree(demo.root).get('connectButton').parent, 'serverCard');
});
test('history: reset is undoable; new branch invalidates redo', () => {
  const history = new History(demo), edited = move(demo, 'connectButton', 'serverCard', 0);
  history.commit(edited); history.commit(demo); assert.deepEqual(history.undo(), edited); assert.deepEqual(history.undo(), demo);
  assert.deepEqual(history.redo(), edited); history.commit(move(edited, 'connectButton', 'preferences', 0)); assert.equal(history.future.length, 0);
});
test('server persists Apply, rejects stale/foreign writes, reloads saved session', async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'compose-bridge-test-'));
  const start = async () => {
    const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: '0', BRIDGE_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let output = '';
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
      child.on('error', reject); child.on('exit', code => { if (!output) reject(Error(`server exited ${code}`)); });
    });
    return { child, url };
  };
  let { child, url } = await start();
  const request = (endpoint, method, body, headers = {}) => fetch(url + endpoint, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const appResponse = await fetch(url + '/app.mjs'); assert.equal(appResponse.status,200); assert.match(appResponse.headers.get('content-type'), /javascript/);
  let response = await request('/api/session', 'GET'); const state = await response.json(); assert.equal(state.revision, 0);
  const edited = clone(demo); indexTree(edited.root).get('connectButton').node.props.width = 'fill';
  edited.layout={mode:'free',frames:{connectButton:{parent:'serverCard',x:20.5,y:100,width:144,height:48}}};
  response = await request('/api/apply', 'POST', { revision: 0, document: edited }); assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.applied.mode, 'test');
  const report = await readFile(path.join(data, saved.applied.directory, 'report.md'), 'utf8');
  assert.match(report, /Тестовый снимок/); assert.match(report, /connectButton/);
  const handoff = await (await request('/api/handoff', 'GET')).json(); assert.deepEqual(handoff.document, edited); assert.equal(handoff.report, report);
  const patch = JSON.parse(await readFile(path.join(data, saved.applied.directory, 'changes.json'), 'utf8')); assert.equal(patch.changes[0].after, 'fill');
  assert.deepEqual(JSON.parse(await readFile(path.join(data, saved.applied.directory, 'proposed.json'), 'utf8')), edited);
  response = await request('/api/draft', 'PUT', { revision: 0, document: demo }); assert.equal(response.status, 409);
  response = await request('/api/draft', 'PUT', { revision: 1, document: demo }, { Origin: 'https://other.example' }); assert.equal(response.status, 403);
  const invalid = clone(demo); invalid.root.type = 'Unknown'; response = await request('/api/session', 'PUT', { revision: 1, document: invalid }); assert.equal(response.status, 400);
  response = await request('/api/session', 'GET'); assert.equal((await response.json()).revision, 1);
  const applied = await (await request('/api/applied', 'GET')).json(); assert.deepEqual(applied, patch);
  response = await request('/api/apply', 'POST', {revision:1, document:demo, mode:'execute'}); assert.equal(response.status,400);
  response = await request('/api/draft', 'PUT', {revision:1, document:demo}); assert.equal(response.status,200);
  assert.deepEqual(await (await request('/api/applied','GET')).json(),patch);
  assert.deepEqual((await (await request('/api/handoff','GET')).json()).document,edited);
  const statePath = path.join(data,'session.json'), backupPath = path.join(data,'session.backup.json');
  await rename(statePath,backupPath); await mkdir(statePath);
  try {
    response = await request('/api/apply','POST',{revision:2,document:edited,mode:'review'}); assert.equal(response.ok,false);
    const failed = await (await request('/api/session','GET')).json(); assert.equal(failed.revision,2); assert.equal(failed.applied.directory,saved.applied.directory);
    assert.deepEqual(await (await request('/api/applied','GET')).json(),patch);
  } finally { await rmdir(statePath); await rename(backupPath,statePath); }
  const exit = once(child, 'exit'); child.kill(); await exit;
  ({ child, url } = await start());
  response = await request('/api/session', 'GET'); assert.deepEqual((await response.json()).current, demo);
  assert.ok((await readdir(data)).includes('session.json'));
});

test('text formatting is independent of element position and survives diff/history', () => {
  const edited = clone(demo), props = indexTree(edited.root).get('connectButton').node.props;
  props.align = 'end'; props.textAlign = 'center'; props.fontStyle = 'italic'; props.textDecoration = 'underline';
  validate(edited);
  const patch = diff(demo, edited);
  assert.ok(patch.changes.some(c => c.property === 'align' && c.after === 'end'));
  assert.ok(patch.changes.some(c => c.property === 'textAlign' && c.after === 'center'));
  const history = new History(demo); history.commit(edited); assert.deepEqual(history.undo(), demo); assert.deepEqual(history.redo(), edited);
  for (const key of ['textAlign','fontStyle','textDecoration']) {
    const invalid = clone(edited); indexTree(invalid.root).get('connectButton').node.props[key] = 'invalid';
    assert.throws(() => validate(invalid), new RegExp(key));
  }
});

test('human report includes source, missing links and conservative legacy mode', () => {
  const edited = move(demo, 'connectButton', 'preferences', 0);
  indexTree(edited.root).get('connectButton').node.props.text = 'Текст\n# Заголовок';
  const changes = diff(demo, edited), report = createReport(changes, {mode:'review',directory:'applied-42'});
  assert.match(report,/Снимок для согласования/); assert.match(report,/Перенос в контейнер/); assert.match(report,/ServerScreen.kt/);
  assert.ok(report.includes('Текст\\n# Заголовок')); assert.ok(!report.includes('Текст\n# Заголовок'));
  assert.match(createReport(changes),/Тестовый снимок/);
});

test('free movement accepts signed offsets, keeps structure and produces undoable source-aware diff', () => {
  const edited=clone(demo), entry=indexTree(edited.root).get('connectButton');
  Object.assign(entry.node.props, shiftedOffsets(entry.node.props, -37.5, 22));
  validate(edited); assert.equal(entry.node.props.offsetX,-37.5); assert.equal(entry.node.props.offsetY,22);
  assert.deepEqual([...indexTree(edited.root)].map(([id,e])=>[id,e.parent,e.index]), [...indexTree(demo.root)].map(([id,e])=>[id,e.parent,e.index]));
  assert.ok(diff(demo,edited).changes.every(c=>c.operation==='property'&&c.source));
  const history=new History(demo);history.commit(edited);assert.deepEqual(history.undo(),demo);assert.deepEqual(history.redo(),edited);
  for (const value of [-4001,4001,Infinity,'20']) {entry.node.props.offsetX=value;assert.throws(()=>validate(edited),/допустимо/);}
  assert.deepEqual(shiftedOffsets({offsetX:3999,offsetY:-3999},20,-20),{offsetX:4000,offsetY:-4000});
});
test('resize sides and corners anchor opposite edges at every zoom and clamp dimensions', () => {
  const rect={left:20,top:40,width:100,height:60};
  assert.deepEqual(resizeRect(rect,'n',0,15),{left:20,top:55,width:100,height:45});
  assert.deepEqual(resizeRect(rect,'w',25,0),{left:45,top:40,width:75,height:60});
  assert.deepEqual(resizeRect(rect,'e',25,90),{left:20,top:40,width:125,height:60});
  assert.deepEqual(resizeRect(rect,'s',90,-10),{left:20,top:40,width:100,height:50});
  assert.deepEqual(resizeRect(rect,'nw',25,15),{left:45,top:55,width:75,height:45});
  for(const direction of ['n','ne','e','se','s','sw','w','nw']) {
    const next=resizeRect(rect,direction,10000,10000);assert.ok(next.width>=8&&next.width<=4000);assert.ok(next.height>=8&&next.height<=4000);
    if(direction.includes('w'))assert.equal(next.left+next.width,rect.left+rect.width);
    if(direction.includes('n'))assert.equal(next.top+next.height,rect.top+rect.height);
  }
  for(const scale of [.3,.65,1])assert.deepEqual(resizeRect(rect,'nw',25*scale/scale,15*scale/scale),{left:45,top:55,width:75,height:45});
});


test('free layout validates geometry and parent links, survives diff and history', () => {
  const edited=clone(demo);
  edited.layout={mode:'free',frames:{connectButton:{parent:'serverCard',x:-20.5,y:99.125,width:144.5,height:48}}};
  validate(edited);
  assert.deepEqual(move(edited,'connectButton','serverCard',indexTree(edited.root).get('connectButton').index),edited);
  const moved=move(edited,'connectButton','preferences',0);assert.equal(moved.layout.frames,undefined);validate(moved);
  const patch=diff(demo,edited); assert.equal(patch.layoutMode,'free');
  assert.deepEqual(patch.changes.find(c=>c.property==='layout').after,edited.layout);
  const history=new History(demo); history.commit(edited);
  const automatic=clone(edited);automatic.layout={mode:'auto'};history.commit(automatic);
  assert.deepEqual(history.undo(),edited);assert.deepEqual(history.undo(),demo);assert.deepEqual(history.redo(),edited);
  for(const change of [f=>f.x=Infinity,f=>f.width=-1,f=>f.height=16001,f=>f.parent='preferences',f=>f.extra=1]) {
    const invalid=clone(edited);change(invalid.layout.frames.connectButton);assert.throws(()=>validate(invalid),/layout.frames/);
  }
  const wrong=clone(edited);wrong.layout.mode='unknown';assert.throws(()=>validate(wrong),/layout/);
  wrong.layout={mode:'free',frames:{missing:{parent:null,x:0,y:0,width:1,height:1}}};assert.throws(()=>validate(wrong),/layout.frames/);
  assert.match(createReport(patch),/Свободная компоновка/);
  assert.match(createReport(diff(demo,automatic)),/Автоматическая компоновка/);
});
