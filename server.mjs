import {projectCommand,projectContext} from './project.mjs';
import http from 'node:http';
import { unlinkSync, readFileSync } from 'node:fs';
import { publicSession, readReference, isVerified, confirmBaseline } from './baseline.mjs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReport } from './public/report.mjs';
import { readTransferResult,rebaseLateDraft,resultHistory,publicResult } from './transfer-result.mjs';
import { validate, diff, History } from './public/model.mjs';
import { createNativeBridge } from './native.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.BRIDGE_DATA || path.join(root, 'data'));
const port = Number(process.env.PORT || 4173);
await mkdir(data, { recursive: true });
const serverLock=path.join(data,'.bridge-server.lock');
try { await writeFile(serverLock,String(process.pid),{flag:'wx'}); }
catch(error) { if(error.code==='EEXIST')throw Error('Эта сессия уже открыта или остался lock после аварийного завершения. Возобновите её командой плагина open.'); throw error; }
process.on('exit',()=>{try{if(readFileSync(serverLock,'utf8')===String(process.pid))unlinkSync(serverLock);}catch{}});
const statePath = path.join(data, 'session.json');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function cleanup(filename, options = {}) {
  try { await rm(filename, { ...options, force: true }); }
  catch (error) { console.error(`Не удалось удалить незавершённую запись ${filename}: ${error.message}`); }
}
async function atomic(filename, value) {
  const temp = filename + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, json(value)); await rename(temp, filename); }
  catch (error) { await cleanup(temp); throw error; }
}
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); validate(state.baseline); validate(state.current); History.restore(state.current,state.history); }
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
const nativeBridge=await createNativeBridge({data,atomic,serial});
async function body(req, limit=2_000_000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) { const e = Error(`Запрос больше ${limit/1_000_000} MB`); e.status = 413; throw e; } chunks.push(chunk); }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  try { return JSON.parse(text); } catch { throw Error('Некорректный JSON'); }
}
const mime = { '.ttf': 'font/ttf', '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  function reply(code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(json(value)); }
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (![expectedHost, `localhost:${server.address().port}`].includes(req.headers.host)) return reply(403, { error: 'Недопустимый Host' });
    if (req.headers.origin && ![`http://${expectedHost}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) return reply(403, { error: 'Запрос из другого origin запрещён' });
    if(req.method==='GET'&&url.pathname==='/native'&&state.baseline.compose&&!state.nativeOnly){res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'});res.end();return;}
    if(req.method==='GET'&&url.pathname==='/'&&state.nativeOnly){res.writeHead(302,{Location:'/native','Cache-Control':'no-store'});res.end();return;}
    if(await nativeBridge.handle(req,res,url,reply,body))return;
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET') {
        const snapshotReference = url.pathname.match(/^\/api\/snapshots\/(applied-\d+-[a-f0-9]{8})\/reference$/);
        if (snapshotReference) {
          const reference=JSON.parse(await readFile(path.join(data,snapshotReference[1],'reference.json'),'utf8'));
          res.writeHead(200, {'Content-Type':reference.mime, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
          return res.end(Buffer.from(reference.image,'base64'));
        }
        const resultReference=url.pathname.match(/^\/api\/results\/(transfer-[a-f0-9-]{36})\/reference$/);
        if(resultReference){
          if(!state.results?.some(result=>result.id===resultReference[1]))return reply(404,{error:'Результат не найден'});
          const result=JSON.parse(await readFile(path.join(data,resultReference[1]+'.json'),'utf8'));
          if(!result.reference)return reply(404,{error:'Кадра результата нет'});
          res.writeHead(200,{'Content-Type':result.reference.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(Buffer.from(result.reference.image,'base64'));
        }
        if(url.pathname==='/api/project'){const context=await projectContext(data);if(!context)return reply(200,{managed:false,sessions:[],palette:null});return reply(200,{managed:true,activeSession:path.basename(path.dirname(data)),...await projectCommand(context,'list')});}
        if(url.pathname==='/api/result')return reply(200,{result:state.result||null,applied:state.applied});
        if (url.pathname === '/api/session') return reply(200, publicSession(state));
        if (url.pathname === '/api/reference') {
          if (!state.reference) return reply(404, {error:'Эталон не загружен'});
          res.writeHead(200, {'Content-Type':state.reference.mime, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
          return res.end(Buffer.from(state.reference.image,'base64'));
        }
        if (url.pathname === '/api/handoff') {
          const applied = state.applied;
          if (!applied) return reply(404, {error:'Снимок ещё не создан'});
          const directory = path.join(data, applied.directory);
          const changes = JSON.parse(await readFile(path.join(directory, 'changes.json'), 'utf8'));
          if (applied.mode === 'review' && changes.verification?.confirmedBy !== 'user') return reply(422, {error:'Старый снимок не содержит подтверждённой сверки исходного макета с эталоном. Создайте новый снимок после сверки.'});
          return reply(200, {applied, baseline:JSON.parse(await readFile(path.join(directory, 'baseline.json'), 'utf8')), verification:changes.verification || null, reference:changes.reference ? {...changes.reference,url:`/api/snapshots/${applied.directory}/reference`} : null, intent:changes.intent || null, transfer:changes.transfer || null, document:JSON.parse(await readFile(path.join(directory, 'proposed.json'), 'utf8')), report:createReport(changes, applied)});
        }
        if (url.pathname === '/api/changes') return reply(200, { ...diff(state.baseline, state.current), draft: true, revision: state.revision, applied: state.applied });
        if (url.pathname === '/api/applied') {
          if (!state.applied) return reply(404, { error: 'Пока нет Apply' });
          return reply(200, JSON.parse(await readFile(path.join(data, state.applied.directory, 'changes.json'), 'utf8')));
        }
        return reply(404, { error: 'Неизвестный endpoint' });
      }
      if (!['PUT', 'POST'].includes(req.method)) return reply(405, { error: 'Метод не поддерживается' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'Нужен Content-Type: application/json' });
      const input = await body(req,['/api/baseline/reference','/api/result','/api/draft','/api/apply'].includes(url.pathname) ? 12_000_000 : 2_000_000);
      if(['/api/draft','/api/apply'].includes(url.pathname)&&Buffer.byteLength(JSON.stringify(input.document))>2_000_000){const error=Error('Макет больше 2 MB');error.status=413;throw error;}
      if(input.history&&Buffer.byteLength(JSON.stringify(input.history))>8_000_000){const error=Error('История больше 8 MB');error.status=413;throw error;}
      if(['/api/project/open','/api/project/create','/api/project/live'].includes(url.pathname)&&req.method==='POST'){
        if(input.revision!==state.revision)return reply(409,{error:'Черновик изменился; сохраните его перед переключением'});
        const context=await projectContext(data);if(!context)throw Error('Каталог экранов доступен в управляемой сессии');
        if(url.pathname.endsWith('/live'))return reply(200,await projectCommand(context,'edit-live'));
        if(url.pathname.endsWith('/open')){if(!/^screen-[a-zA-Z0-9]+$/.test(input.session||''))throw Error('Некорректная сессия');return reply(200,await projectCommand(context,'open',['--session',input.session]));}
        if(typeof input.name!=='string'||typeof (input.request||'')!=='string')throw Error('Нужно название экрана и текст запроса');
        return reply(200,await projectCommand(context,'create-screen',['--name',input.name,...(input.request?['--request',input.request]:[])]));
      }
      await serial(async () => {
        if (input.revision !== state.revision) return reply(409, { error: 'Сессия изменилась в другом окне или агентом. Загрузите серверную версию; текущий макет можно сначала экспортировать.', revision: state.revision });
        const next = { ...state, revision: state.revision + 1 };
        let snapshotPath, archivePath, resultPath;
        async function archiveSession() {
          const directory=`session-${state.revision}-${randomUUID().slice(0,8)}`; archivePath=path.join(data,directory);
          await mkdir(archivePath); await writeFile(path.join(archivePath,"session.json"),json(state));
          return directory;
        }
        try {
          if (url.pathname === '/api/result' && req.method === 'POST') {
            if(state.nativeOnly)throw Error('Для PNG-сессии результат пока не поддерживается');
            if(!state.applied||input.snapshot!==state.applied.directory){const error=Error('Снимок устарел; результат не записан');error.status=409;throw error;}
            if(state.result?.snapshot===input.snapshot&&state.result.acceptedAt)throw Error('Этот результат уже принят');
            const directory=path.join(data,state.applied.directory),snapshot={baseline:JSON.parse(await readFile(path.join(directory,'baseline.json'),'utf8')),document:JSON.parse(await readFile(path.join(directory,'proposed.json'),'utf8'))};
            const result={...readTransferResult(input,snapshot),beforeReference:await readFile(path.join(directory,'reference.json'),'utf8').then(()=>`/api/snapshots/${state.applied.directory}/reference`).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),id:'transfer-'+randomUUID(),recordedAt:new Date().toISOString(),mode:state.applied.mode||'test'};
            resultPath=path.join(data,result.id+'.json');await writeFile(resultPath,json(result),{flag:'wx'});
            next.result=publicResult(result);next.results=[...(state.results||[]),next.result];
            // Result metadata does not change the edit revision or invalidate an
            // in-flight draft save. Adopting its baseline is a separate transaction.
            next.revision=state.revision;
          } else if(url.pathname==='/api/result/accept'&&req.method==='POST'){
            if(!state.result||input.id!==state.result.id||state.result.snapshot!==state.applied?.directory||state.result.status!=='succeeded'||state.result.acceptedAt)throw Error('Актуального успешного результата для принятия нет');
            const result=JSON.parse(await readFile(path.join(data,state.result.id+'.json'),'utf8'));
            if(result.beforeSourceRevision!==state.baseline.sourceRevision)throw Error('Baseline изменился; результат устарел');
            const proposed=JSON.parse(await readFile(path.join(data,state.applied.directory,'proposed.json'),'utf8'));
            const rebased=rebaseLateDraft(proposed,state.current,result.document);
            next.previousSession=await archiveSession();next.baseline=result.document;next.current=rebased.current;
            next.history=resultHistory(next.baseline,next.current);next.reference=result.reference;next.verification=null;
            next.result={...state.result,acceptedAt:new Date().toISOString(),lateDraft:{status:rebased.conflicts.length?'archived':JSON.stringify(proposed)===JSON.stringify(state.current)?'none':'rebased',archive:next.previousSession,conflicts:rebased.conflicts}};
            next.results=(state.results||[]).map(item=>item.id===next.result.id?next.result:item);
          } else if (url.pathname === '/api/session' && req.method === 'PUT') {
            validate(input.document); next.previousSession=await archiveSession();
            next.baseline = validate(input.document); next.current = input.document; next.applied = null; next.reference = null; next.verification = null; next.history=new History(next.current).snapshot(); next.result=null; next.results=[];
          } else if (url.pathname === '/api/session/restore' && req.method === 'POST') {
            if (!state.previousSession || !/^session-\d+-[a-f0-9]{8}$/.test(state.previousSession)) throw Error('Предыдущей сессии нет');
            const restored=JSON.parse(await readFile(path.join(data,state.previousSession,'session.json'),'utf8'));
            validate(restored.baseline); validate(restored.current);
            const previousSession=await archiveSession();
            Object.assign(next,restored,{revision:state.revision+1,previousSession});
          } else if (url.pathname === '/api/baseline/reference' && req.method === 'POST') {
            next.reference = readReference(input); next.verification = null;
          } else if (url.pathname === '/api/baseline/confirm' && req.method === 'POST') {
            next.verification = confirmBaseline(next,input);
          } else if (url.pathname === '/api/draft' && req.method === 'PUT') {
            next.current = validate(input.document);
            if(input.history!=null)next.history=History.restore(next.current,input.history).snapshot();else{const h=History.restore(state.current,state.history);h.commit(next.current);next.history=h.snapshot();}
          } else if (url.pathname === '/api/apply' && req.method === 'POST') {
            next.current = validate(input.document);
            if(input.history!=null)next.history=History.restore(next.current,input.history).snapshot();else{const h=History.restore(state.current,state.history);h.commit(next.current);next.history=h.snapshot();}
            if (input.mode != null && !['test','review'].includes(input.mode)) throw Error('mode: test или review');
            const mode = input.mode || 'test';
            if (mode === 'review' && (!isVerified(next) || next.current.sourceRevision !== next.baseline.sourceRevision)) { const error = Error('Исходный макет не проверен. Сверьте его с настоящим экраном; пока доступна только тестовая передача.'); error.status=422; throw error; }
            const directory = `applied-${next.revision}-${randomUUID().slice(0, 8)}`;
            await mkdir(path.join(data, directory));
            snapshotPath = path.join(data, directory);
            const changes = { ...diff(next.baseline, next.current), verification:isVerified(next)?next.verification:null, reference:publicSession(next).reference, appliedAt: new Date().toISOString(), revision: next.revision, handoff: {mode} };
            if (next.reference) await writeFile(path.join(snapshotPath, 'reference.json'), json(next.reference));
            await writeFile(path.join(snapshotPath, 'baseline.json'), json(next.baseline));
            await writeFile(path.join(snapshotPath, 'proposed.json'), json(next.current));
            await writeFile(path.join(snapshotPath, 'changes.json'), json(changes));
            next.applied = { directory, revision: next.revision, appliedAt: changes.appliedAt, mode };
            await writeFile(path.join(snapshotPath, 'report.md'), createReport(changes, next.applied));
          } else return reply(404, { error: 'Неизвестный endpoint' });
          await atomic(statePath, next);
        } catch (error) {
          if(resultPath)await cleanup(resultPath);
          if (snapshotPath) await cleanup(snapshotPath, { recursive: true });
          if (archivePath) await cleanup(archivePath, {recursive:true});
          throw error;
        }
        state = next; reply(200, publicSession(state));
      });
      return;
    }
    if (req.method !== 'GET') return reply(405, { error: 'Метод не поддерживается' });
    const allowed = { '/': 'index.html', '/app.mjs': 'build/entry.js', '/lab': 'lab.html', '/lab.mjs': 'build/lab.js', '/model.mjs': 'model.mjs', '/style.css': 'style.css', '/fonts/RobotoFlex.ttf':'fonts/RobotoFlex.ttf', '/fonts/Roboto.ttf':'fonts/Roboto.ttf', '/fonts/Roboto-3.015.ttf':'fonts/Roboto-3.015.ttf', '/fonts/Roboto-Italic.ttf':'fonts/Roboto.ttf' };
    Object.assign(allowed,{'/native':'index.html','/native.mjs':'build/native.js','/native.css':'native.css'});
    allowed['/compose-capabilities.mjs']='compose-capabilities.mjs';
    if (!allowed[url.pathname]) return reply(404, { error: 'Не найдено' });
    const filename = path.join(root, 'public', allowed[url.pathname]);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" });
    res.end(await readFile(filename));
  } catch (error) {
    reply(error.status || (error.code ? 500 : 400), { error: error.code ? `Ошибка файлового хранилища: ${error.message}` : error.message });
  }
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  nativeBridge.stop();
  server.close(async()=>{await queue; process.exit(0);});
  setTimeout(()=>server.closeAllConnections(),5000).unref();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Compose Visual Bridge: http://127.0.0.1:${server.address().port}`);
  console.log(`Session files: ${data}`);
});
