import test from 'node:test';
import { shiftedOffsets, resizeRect, anchoredChildFrames } from './public/geometry.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, mkdir, rename, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReport } from './public/report.mjs';
import { clone, validate, diff, move, History, indexTree } from './public/model.mjs';

const demo = JSON.parse(await readFile(new URL('./examples/server-screen.json', import.meta.url)));
async function serverFixture(t, { holdHandoffReads = false } = {}) {
  const data = await mkdtemp(path.join(tmpdir(), 'compose-bridge-test-'));
  let child, url;
  const stop = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill(); await exit;
  };
  t.after(async () => { await stop(); await rm(data, { recursive: true, force: true }); });
  const restart = async () => {
    await stop();
    // Pause the real file read over IPC to reproduce concurrent writes without timing guesses.
    const preload = `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const readFile = fs.readFile;
      let hold = false, resume;
      process.on('message', message => {
        if (message === 'hold') { hold = true; process.send('armed'); }
        if (message === 'resume') { resume?.(); resume = undefined; }
      });
      fs.readFile = async (...args) => {
        if (hold && path.basename(String(args[0])) === 'changes.json') {
          hold = false;
          await new Promise(resolve => { resume = resolve; process.send('paused'); });
        }
        return readFile(...args);
      };
      syncBuiltinESMExports();
    `;
    const args = holdHandoffReads ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'server.mjs'] : ['server.mjs'];
    child = spawn(process.execPath, args, { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: '0', BRIDGE_DATA: data }, stdio: holdHandoffReads ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Сервер не запустился за 10 секунд')), 10_000);
      child.stdout.on('data', chunk => {
        output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${errors}`)); });
    });
  };
  await restart();
  const request = (endpoint, method = 'GET', body, headers = {}) => fetch(url + endpoint, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const holdHandoffRead = async () => {
    const armed = once(child, 'message'); child.send('hold');
    assert.deepEqual(await armed, ['armed', undefined]);
    return { paused: once(child, 'message'), resume: () => child.send('resume') };
  };
  return { data, request, restart, holdHandoffRead };
}

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
  const { data, request, restart } = await serverFixture(t);
  const appResponse = await request('/app.mjs'); assert.equal(appResponse.status,200); assert.match(appResponse.headers.get('content-type'), /javascript/);
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
  await restart();
  response = await request('/api/session', 'GET'); assert.deepEqual((await response.json()).current, demo);
  assert.ok((await readdir(data)).includes('session.json'));
});

test('failed draft, Apply and import leave no temporary files and preserve the last successful snapshot', async t => {
  const { data, request, restart } = await serverFixture(t);
  const saved = await (await request('/api/apply', 'POST', { revision: 0, document: demo })).json();
  const snapshotFiles = await readdir(path.join(data, saved.applied.directory));
  const snapshot = await Promise.all(snapshotFiles.map(file => readFile(path.join(data, saved.applied.directory, file), 'utf8')));
  const edited = clone(demo); edited.name = 'Несохранённый вариант';
  const statePath = path.join(data, 'session.json'), backupPath = path.join(data, 'session.backup.json');
  // A directory at the destination forces the final rename to fail on any OS/user.
  await rename(statePath, backupPath); await mkdir(statePath);
  const entries = (await readdir(data)).sort();
  try {
    for (const [endpoint, method] of [['/api/draft', 'PUT'], ['/api/apply', 'POST'], ['/api/session', 'PUT']]) {
      const response = await request(endpoint, method, { revision: 1, document: edited });
      assert.equal(response.status, 500, endpoint);
      assert.match((await response.json()).error, /хранилища/);
      assert.deepEqual(await (await request('/api/session')).json(), saved);
      assert.deepEqual((await readdir(data)).sort(), entries, endpoint);
      assert.deepEqual(await Promise.all(snapshotFiles.map(file => readFile(path.join(data, saved.applied.directory, file), 'utf8'))), snapshot);
      assert.deepEqual((await (await request('/api/handoff')).json()).document, demo);
    }
  } finally { await rmdir(statePath); await rename(backupPath, statePath); }
  await restart();
  assert.deepEqual(await (await request('/api/session')).json(), saved);
  const draft = await request('/api/draft', 'PUT', { revision: 1, document: edited });
  assert.equal(draft.status, 200); assert.equal((await draft.json()).revision, 2);
  const applied = await request('/api/apply', 'POST', { revision: 2, document: edited, mode: 'test' });
  assert.equal(applied.status, 200); assert.equal((await applied.json()).applied.mode, 'test');
  await restart();
  assert.deepEqual((await (await request('/api/handoff')).json()).document, edited);
});

test('competing writes have one winner; import clears the pointer and keeps archived snapshots after restart', async t => {
  const { data, request, restart } = await serverFixture(t);
  const variants = [clone(demo), clone(demo)]; variants[0].name = 'Окно 1'; variants[1].name = 'Окно 2';
  const responses = await Promise.all(variants.map(document => request('/api/apply', 'POST', { revision: 0, document, mode: 'test' })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = responses.findIndex(response => response.status === 200);
  const saved = await responses[winner].json();
  assert.equal(saved.revision, 1); assert.deepEqual(saved.current, variants[winner]);
  assert.deepEqual((await readdir(data)).filter(name => name.startsWith('applied-')), [saved.applied.directory]);
  const handoff = await (await request('/api/handoff')).json();
  assert.deepEqual(handoff.document, variants[winner]); assert.deepEqual(handoff.applied, saved.applied);
  const archive = path.join(data, saved.applied.directory);
  const files = await readdir(archive), contents = await Promise.all(files.map(file => readFile(path.join(archive, file), 'utf8')));
  const drafts = await Promise.all(variants.map(document => request('/api/draft', 'PUT', { revision: 1, document })));
  assert.deepEqual(drafts.map(response => response.status).sort(), [200, 409]);
  const current = await (await request('/api/session')).json();
  assert.equal(current.revision, 2); assert.deepEqual(current.current, variants[drafts.findIndex(response => response.status === 200)]);
  assert.deepEqual(current.applied, saved.applied);
  assert.equal((await request('/api/session', 'PUT', { revision: 1, document: demo })).status, 409);
  const response = await request('/api/session', 'PUT', { revision: 2, document: demo });
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.revision, 3); assert.equal(imported.applied, null);
  assert.deepEqual(imported.baseline, demo); assert.deepEqual(imported.current, demo);
  await restart();
  assert.deepEqual(await (await request('/api/session')).json(), imported);
  for (const endpoint of ['/api/applied', '/api/handoff']) assert.equal((await request(endpoint)).status, 404);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(archive, file), 'utf8'))), contents);
  assert.deepEqual((await readdir(data)).filter(name=>!name.startsWith('session-') && name!=='.bridge-server.lock').sort(), [saved.applied.directory, 'session.json'].sort());
});

test('handoff reads stay internally consistent while another request applies or imports', { timeout: 10_000 }, async t => {
  const { request, holdHandoffRead } = await serverFixture(t, { holdHandoffReads: true });
  let revision = 0;
  for (const [endpoint, method] of [['/api/apply', 'POST'], ['/api/session', 'PUT']]) {
    const savedResponse = await request('/api/apply', 'POST', { revision, document: demo, mode: 'test' });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json(); revision = saved.revision;
    const expected = await (await request('/api/handoff')).json();
    assert.deepEqual(expected.applied, saved.applied); assert.deepEqual(expected.document, demo);
    const held = await holdHandoffRead(), reading = request('/api/handoff');
    assert.deepEqual(await held.paused, ['paused', undefined]);
    try {
      const document = clone(demo); document.name = 'Новый вариант';
      const response = await request(endpoint, method, { revision, document, mode: 'test' });
      assert.equal(response.status, 200); revision = (await response.json()).revision;
    } finally { held.resume(); }
    const read = await reading; assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), expected);
    if (endpoint === '/api/session') assert.equal((await request('/api/handoff')).status, 404);
  }
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


test('container resize anchors direct children and nested descendants without cumulative movement', () => {
  const frames={card:{parent:'screen',x:10,y:20,width:200,height:180},row:{parent:'card',x:24,y:24,width:150,height:40},text:{parent:'row',x:12,y:8,width:80,height:20},other:{parent:'screen',x:10,y:220,width:200,height:50}};
  const initial=clone(frames), shifted=anchoredChildFrames(frames,'card',15,20);
  assert.deepEqual(frames,initial);
  assert.equal(shifted.row.x,9);assert.equal(shifted.row.y,4);
  assert.deepEqual(shifted.text,frames.text);assert.deepEqual(shifted.other,frames.other);
  // The parent's new origin + child + grandchild remains the same in screen coordinates.
  assert.equal(frames.card.x+15+shifted.row.x+shifted.text.x,frames.card.x+frames.row.x+frames.text.x);
  assert.equal(frames.card.y+20+shifted.row.y+shifted.text.y,frames.card.y+frames.row.y+frames.text.y);
  assert.deepEqual(anchoredChildFrames(frames,'card',0,0),frames);
  assert.equal(anchoredChildFrames(frames,'card',-10,-30).row.y,54);
  assert.deepEqual(anchoredChildFrames(frames,'card',15,20),shifted);
});


test('native viewport presentation validates and preserves legacy documents', () => {
  const native=clone(demo); native.viewport.presentation='content'; validate(native);
  native.viewport.presentation='device'; validate(native);
  native.viewport.presentation='unknown'; assert.throws(()=>validate(native),/viewport.presentation/);
  assert.equal(demo.viewport.presentation,undefined); validate(demo);
});


test('native typography validates integer line limits, font scale and semantic changes', () => {
 const typed=clone(demo); const node=indexTree(typed.root).get('connectButton').node;
 Object.assign(node.props,{fontFamily:'Roboto',letterSpacing:.25,maxLines:1,textOverflow:'ellipsis'}); typed.viewport.fontScale=1.25; validate(typed);
 const patch=diff(demo,typed); assert.ok(patch.intent.changes.some(c=>c.property==='fontFamily')); assert.ok(patch.intent.changes.some(c=>c.property==='maxLines'));
 for(const [key,value] of [['maxLines',1.5],['maxLines',0],['fontFamily','unknown'],['textOverflow','unknown'],['letterSpacing',21]]) {const wrong=clone(typed);indexTree(wrong.root).get('connectButton').node.props[key]=value;assert.throws(()=>validate(wrong));}
 typed.viewport.fontScale=4; assert.throws(()=>validate(typed),/fontScale/);
});

test('HTTP draft preserves Cyrillic and emoji split across request chunks', async t => {
  const {request} = await serverFixture(t);
  const response = await request('/api/session');
  const state = await response.json();
  const document = clone(state.current);document.name = 'Тест 🥣';
  const bytes = Buffer.from(JSON.stringify({revision:state.revision,document}));
  const splits = [bytes.indexOf(Buffer.from('Тест')) + 1, bytes.indexOf(Buffer.from('🥣')) + 2];
  const {request:send} = await import('node:http');
  const saved = await new Promise((resolve,reject) => {
    const req = send(new URL('/api/draft',response.url), {method:'PUT',headers:{'Content-Type':'application/json','Content-Length':bytes.length}}, res => {
      let text = '';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });
    req.on('error',reject);req.write(bytes.subarray(0,splits[0]));
    setTimeout(()=>{req.write(bytes.subarray(splits[0],splits[1]));setTimeout(()=>req.end(bytes.subarray(splits[1])),40);},40);
  });
  assert.equal(saved.status,200);assert.equal(saved.body.current.name,document.name);
  const persisted = await (await request('/api/session')).json();assert.equal(persisted.current.name,document.name);
});

test('HTTP body limit counts UTF-8 bytes and rejects oversized drafts without changing session', async t => {
  const {request} = await serverFixture(t);
  const before = await (await request('/api/session')).json();
  const document = clone(before.current);document.name = 'я'.repeat(1_000_000);
  const payload = JSON.stringify({revision:before.revision,document});
  assert.ok(payload.length < 2_000_000);assert.ok(Buffer.byteLength(payload) > 2_000_000);
  const response = await request('/api/draft', 'PUT', {revision:before.revision,document});
  assert.equal(response.status,413);
  assert.deepEqual(await (await request('/api/session')).json(),before);
});
