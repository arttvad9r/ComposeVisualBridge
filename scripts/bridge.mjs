import { readFile, writeFile, mkdir, rm, access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReference } from '../baseline.mjs';
import { validate } from '../public/model.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = `Compose Visual Bridge — команды агента
create --input <макет.json> --data <новый каталог>  Создать отдельную сессию
open --data <каталог> [--port <порт>]              Запустить редактор; без --port выбирается свободный порт
read --url <http://127.0.0.1:порт>                Прочитать переданный снимок
result --url <URL> --input <результат.json>       Записать результат переноса
reference --url <URL> --input <снимок> --label <экран и устройство>  Загрузить эталон
Данные сохраняются после остановки. read не переносит правки в исходники.`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(help); return; }
  const allowed = { create: ['--input', '--data'], open: ['--data','--port'], read: ['--url'], result:['--url','--input'], reference: ['--url','--input','--label'] }[command];
  if (!allowed) throw Error(`Неизвестная команда: ${command}. Используйте --help.`);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key]) throw Error(`Некорректный аргумент: ${key}. Используйте --help.`);
    options[key] = value;
  }
  for (const key of allowed.filter(key=>key!=='--port')) if (!options[key]) throw Error(`Нужен аргумент ${key}. Используйте --help.`);
  if (command === 'create') {
    const document = validate(JSON.parse(await readFile(path.resolve(options['--input']), 'utf8')));
    const data = path.resolve(options['--data']);
    try { await mkdir(data); } catch (error) {
      if (error.code === 'EEXIST') throw Error('Каталог уже существует. Выберите новый каталог: существующая сессия не перезаписывается.');
      throw error;
    }
    try {
      await writeFile(path.join(data, 'session.json'), JSON.stringify({ revision: 0, baseline: document, current: document, applied: null }, null, 2) + '\n', { flag: 'wx' });
    } catch (error) { await rm(data, { recursive: true, force: true }); throw error; }
    console.log(JSON.stringify({ data, name: document.name, revision: 0, applied: null }, null, 2));
  } else if (command === 'open') {
    const port=options['--port']??'0';
    if(!/^\d+$/.test(port)||Number(port)>65535)throw Error('Порт должен быть целым числом от 0 до 65535');
    const data = path.resolve(options['--data']);
    const state = JSON.parse(await readFile(path.join(data, 'session.json'), 'utf8'));
    validate(state.baseline); validate(state.current);
    try { await access(path.join(root, 'public/build/app.js')); }
    catch { throw Error('Сборка редактора отсутствует. Выполните npm ci и npm run build в каталоге Bridge.'); }
    const lock = path.join(data, '.bridge-open.lock');
    try { await writeFile(lock, String(process.pid), { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw Error('Эта сессия уже запущена через open. После аварийного завершения проверьте процессы перед удалением .bridge-open.lock.'); throw error; }
    try {
    const serverLock=path.join(data,'.bridge-server.lock');
    const owner=Number(await readFile(serverLock,'utf8').catch(()=>''));
    if(owner) {
      let running=false; try {process.kill(owner,0);running=true;}catch(error){if(error.code==='EPERM')running=true;}
      if(running)throw Error('Эта сессия уже открыта другим сервером. Сначала остановите его.');
      await rm(serverLock,{force:true});
    }
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, BRIDGE_DATA: data, PORT: port }, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1; resolve(); }); });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    } finally { await rm(lock, { force: true }); }
  } else {
    const url = new URL(options['--url']);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Нужен корневой HTTP URL локального редактора: http://127.0.0.1:порт.');
    if(command==='result'){
      const input=JSON.parse(await readFile(path.resolve(options['--input']),'utf8'));
      const stateResponse=await fetch(new URL('/api/session',url),{signal:AbortSignal.timeout(5000),redirect:'error'});if(!stateResponse.ok)throw Error('Не удалось прочитать сессию');const state=await stateResponse.json();
      const response=await fetch(new URL('/api/result',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,revision:state.revision}),signal:AbortSignal.timeout(10000),redirect:'error'});const value=await response.json();if(!response.ok)throw Error(value.error);console.log(JSON.stringify(value.result,null,2));return;
    }
    if (command === 'reference') {
      const filename=path.resolve(options['--input']);
      if((await stat(filename)).size>8_000_000)throw Error('Снимок больше 8 MB');
      const bytes=await readFile(filename);
      const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(filename).toLowerCase()];
      const reference=readReference({image:bytes.toString('base64'),mime,label:options['--label']});
      const stateResponse=await fetch(new URL('/api/session',url),{signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!stateResponse.ok)throw Error('Не удалось прочитать сессию');
      const state=await stateResponse.json();
      const response=await fetch(new URL('/api/baseline/reference',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,...reference}),signal:AbortSignal.timeout(5000),redirect:'error'});
      const result=await response.json(); if(!response.ok)throw Error(result.error);
      console.log(JSON.stringify({revision:result.revision,reference:result.reference,verification:result.verification},null,2)); return;
    }
    let response;
    try { response = await fetch(new URL('/api/handoff', url), { signal: AbortSignal.timeout(5000), redirect: 'error' }); }
    catch { throw Error('Редактор недоступен. Запустите open и используйте URL из его вывода.'); }
    const handoff = await response.json();
    if (response.status === 404) throw Error('Переданного снимка нет. Сохранение черновика недостаточно: нажмите «Передать агенту».');
    if (!response.ok) throw Error(handoff.error || `Ошибка HTTP ${response.status}`);
    validate(handoff.document);
    if (!handoff.applied || typeof handoff.report !== 'string') throw Error('Некорректный ответ handoff.');
    console.log(JSON.stringify(handoff, null, 2));
  }
}
main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
