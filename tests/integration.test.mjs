import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
const exec = promisify(execFile);
const cli = path.resolve('scripts/bridge.mjs');
const run = (...args) => exec(process.execPath, [cli, ...args]);

test('CLI: изолированная сессия, запрет перезаписи, снимок вместо позднего черновика', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'bridge-cli-'));
  const data = path.join(temp, 'session');
  let child;
  try {
    const created = JSON.parse((await run('create', '--input', 'examples/browser-scenarios.json', '--data', data)).stdout);
    assert.equal(created.applied, null);
    const original = await readFile(path.join(data, 'session.json'), 'utf8');
    await assert.rejects(run('create', '--input', 'examples/browser-scenarios.json', '--data', data), /Каталог уже существует/);
    assert.equal(await readFile(path.join(data, 'session.json'), 'utf8'), original);
    child = spawn(process.execPath, [cli, 'open', '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Сервер не запустился')), 10000);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(Error('Сервер остановился')); });
    });
    assert.equal((await fetch(url)).status, 200);
    await assert.rejects(run('open', '--data', data), /Эта сессия уже запущена/);
    await assert.rejects(run('read', '--url', url), /Переданного снимка нет/);
    const state = await (await fetch(url + '/api/session')).json();
    const appliedResponse = await fetch(url + '/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, document: state.current, mode: 'test' }) });
    assert.equal(appliedResponse.status, 200);
    const appliedState = await appliedResponse.json();
    const handoff = JSON.parse((await run('read', '--url', url)).stdout);
    assert.deepEqual(handoff.document, state.current);
    assert.equal(handoff.applied.mode, 'test');
    const late = structuredClone(state.current); late.name = 'Поздний черновик';
    const draft = await fetch(url + '/api/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: appliedState.revision, document: late }) });
    assert.equal(draft.status, 200);
    assert.deepEqual(JSON.parse((await run('read', '--url', url)).stdout), handoff);
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; child = null;
    assert.equal(JSON.parse(await readFile(path.join(data, 'session.json'), 'utf8')).current.name, late.name);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await rm(temp, { recursive: true, force: true });
  }
});

test('CLI: понятные ошибки аргументов и ограничения localhost', async () => {
  await assert.rejects(run('read'), /Нужен аргумент --url/);
  await assert.rejects(run('read', '--url', 'https://example.com'), /локального редактора/);
  await assert.rejects(run('create', '--input', 'examples/browser-scenarios.json', '--data', '/tmp/a', '--extra', 'x'), /Некорректный аргумент/);
  await assert.rejects(run('open', '--data', '/nonexistent-compose-bridge/session'), /Ошибка:/);
});
