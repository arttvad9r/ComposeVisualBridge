import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { validate } from '../public/model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const document = JSON.parse(await readFile(new URL('../examples/browser-scenarios.json', import.meta.url), 'utf8'));
validate(document);
const data = await mkdtemp(path.join(tmpdir(), 'compose-bridge-browser-'));
try {
  await writeFile(path.join(data, 'session.json'), JSON.stringify({ revision: 0, baseline: document, current: document, applied: null }));
  // PORT=0 поручает ОС выбрать свободный порт; каталог всегда отдельный.
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, BRIDGE_DATA: data, PORT: '0' }, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code && code !== 0 ? reject(Error(`Сервер завершился с кодом ${code}`)) : resolve());
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} finally {
  await rm(data, { recursive: true, force: true });
}
