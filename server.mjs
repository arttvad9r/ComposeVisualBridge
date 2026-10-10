import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate, diff } from './public/model.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.BRIDGE_DATA || path.join(root, 'data'));
const port = Number(process.env.PORT || 4173);
await mkdir(data, { recursive: true });
const statePath = path.join(data, 'session.json');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function atomic(filename, value) {
  const temp = filename + '.' + randomUUID() + '.tmp';
  await writeFile(temp, json(value)); await rename(temp, filename);
}
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); validate(state.baseline); validate(state.current); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const inputIndex = process.argv.indexOf('--input');
  const input = inputIndex < 0 ? path.join(root, 'examples/server-screen.json') : process.argv[inputIndex + 1];
  const doc = validate(JSON.parse(await readFile(input, 'utf8')));
  state = { revision: 0, baseline: doc, current: doc, applied: null };
  await atomic(statePath, state);
}
let queue = Promise.resolve();
function serial(fn) { const task = queue.then(fn); queue = task.catch(() => {}); return task; }
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 2_000_000) { const e = Error('Файл больше 2 MB'); e.status = 413; throw e; } }
  try { return JSON.parse(text); } catch { throw Error('Некорректный JSON'); }
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  function reply(code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(json(value)); }
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (![expectedHost, `localhost:${server.address().port}`].includes(req.headers.host)) return reply(403, { error: 'Недопустимый Host' });
    if (req.headers.origin && ![`http://${expectedHost}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) return reply(403, { error: 'Запрос из другого origin запрещён' });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET') {
        if (url.pathname === '/api/session') return reply(200, state);
        if (url.pathname === '/api/changes') return reply(200, { ...diff(state.baseline, state.current), draft: true, revision: state.revision, applied: state.applied });
        if (url.pathname === '/api/applied') {
          if (!state.applied) return reply(404, { error: 'Пока нет Apply' });
          return reply(200, JSON.parse(await readFile(path.join(data, state.applied.directory, 'changes.json'), 'utf8')));
        }
        return reply(404, { error: 'Неизвестный endpoint' });
      }
      if (!['PUT', 'POST'].includes(req.method)) return reply(405, { error: 'Метод не поддерживается' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'Нужен Content-Type: application/json' });
      const input = await body(req);
      await serial(async () => {
        if (input.revision !== state.revision) return reply(409, { error: 'Сессия изменилась в другом окне или агентом. Загрузите серверную версию; текущий макет можно сначала экспортировать.', revision: state.revision });
        const next = { ...state, revision: state.revision + 1 };
        if (url.pathname === '/api/session' && req.method === 'PUT') {
          next.baseline = validate(input.document); next.current = input.document; next.applied = null;
        } else if (url.pathname === '/api/draft' && req.method === 'PUT') {
          next.current = validate(input.document);
        } else if (url.pathname === '/api/apply' && req.method === 'POST') {
          next.current = validate(input.document);
          const directory = `applied-${next.revision}-${randomUUID().slice(0, 8)}`;
          await mkdir(path.join(data, directory));
          const changes = { ...diff(next.baseline, next.current), appliedAt: new Date().toISOString(), revision: next.revision };
          await writeFile(path.join(data, directory, 'baseline.json'), json(next.baseline));
          await writeFile(path.join(data, directory, 'proposed.json'), json(next.current));
          await writeFile(path.join(data, directory, 'changes.json'), json(changes));
          next.applied = { directory, revision: next.revision, appliedAt: changes.appliedAt };
        } else return reply(404, { error: 'Неизвестный endpoint' });
        await atomic(statePath, next); state = next; reply(200, state);
      });
      return;
    }
    if (req.method !== 'GET') return reply(405, { error: 'Метод не поддерживается' });
    const allowed = { '/': 'index.html', '/app.mjs': 'app.mjs', '/model.mjs': 'model.mjs', '/style.css': 'style.css' };
    if (!allowed[url.pathname]) return reply(404, { error: 'Не найдено' });
    const filename = path.join(root, 'public', allowed[url.pathname]);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" });
    res.end(await readFile(filename));
  } catch (error) { reply(error.status || 400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Compose Visual Bridge: http://127.0.0.1:${server.address().port}`);
  console.log(`Session files: ${data}`);
});
