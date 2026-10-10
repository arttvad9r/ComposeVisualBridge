import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
  let response = await request('/api/session', 'GET'); const state = await response.json(); assert.equal(state.revision, 0);
  const edited = clone(demo); indexTree(edited.root).get('connectButton').node.props.width = 'fill';
  response = await request('/api/apply', 'POST', { revision: 0, document: edited }); assert.equal(response.status, 200); const saved = await response.json();
  const patch = JSON.parse(await readFile(path.join(data, saved.applied.directory, 'changes.json'), 'utf8')); assert.equal(patch.changes[0].after, 'fill');
  assert.deepEqual(JSON.parse(await readFile(path.join(data, saved.applied.directory, 'proposed.json'), 'utf8')), edited);
  response = await request('/api/draft', 'PUT', { revision: 0, document: demo }); assert.equal(response.status, 409);
  response = await request('/api/draft', 'PUT', { revision: 1, document: demo }, { Origin: 'https://other.example' }); assert.equal(response.status, 403);
  const invalid = clone(demo); invalid.root.type = 'Unknown'; response = await request('/api/session', 'PUT', { revision: 1, document: invalid }); assert.equal(response.status, 400);
  response = await request('/api/session', 'GET'); assert.equal((await response.json()).revision, 1);
  const applied = await (await request('/api/applied', 'GET')).json(); assert.deepEqual(applied, patch);
  const exit = once(child, 'exit'); child.kill(); await exit;
  ({ child, url } = await start());
  response = await request('/api/session', 'GET'); assert.deepEqual((await response.json()).current, edited);
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
