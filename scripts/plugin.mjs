import {blankScreen,validatePalette} from '../project.mjs';
import {transferNeeds} from '../public/compose-capabilities.mjs';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, realpath, access, open, readdir, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isVerified, BRIDGE_VERSION, readReference } from '../baseline.mjs';
import {bindWorkspaceCapture,planCompose,importCompose,instrumentWorkspace,restoreWorkspace} from '../compose.mjs';
const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'scripts/bridge.mjs');
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const json = value => JSON.stringify(value, null, 2) + '\n';
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function load(filename) { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomic(filename, value) {
  const temp = filename + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, json(value)); await rename(temp, filename); }
  finally { await rm(temp, { force: true }); }
}
async function locked(directory, fn) {
  const filename = path.join(directory, '.manager.lock');
  let owned = false;
  for (let i = 0; i < 100; i++) {
    try { await writeFile(filename, String(process.pid), { flag: 'wx' }); owned = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid; try { pid = Number(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A writer can exist before it has flushed its PID. Wait rather than deleting an empty lock.
      if (pid && !alive(pid)) await rm(filename, { force: true });
      else await pause();
    }
  }
  if (!owned) throw Error('Сессия занята другой командой. Повторите запуск.');
  try { return await fn(); } finally { await rm(filename, { force: true }); }
}
async function runtime(data) {
  const value = await load(path.join(data, 'runtime.json'));
  if (!value || !alive(value.pid)) return null;
  const owner = Number(await readFile(path.join(data, '.bridge-open.lock'), 'utf8').catch(() => '0'));
  if (owner !== value.pid) throw Error('Не удалось подтвердить процесс этой сессии. Проверьте server.log.');
  return value;
}
async function serverVersion(value) {
  try { const response = await fetch(value.url + '/api/session', { signal: AbortSignal.timeout(1500), redirect: 'error' }); if(response.ok)return (await response.json()).bridgeVersion || 'legacy'; } catch {}
  return null;
}
let projectContext;
async function launch(data) {
  if(projectContext)await atomic(path.join(data,'project-context.json'),projectContext);
  const existing = await runtime(data);
  if (existing) {
    const version=await serverVersion(existing);
    if (!version) throw Error('Процесс сессии работает, но редактор недоступен. Выполните stop, затем open.');
    if(version===BRIDGE_VERSION)return {...existing,reused:true};
    await stop(data);
  }
  const lock = path.join(data, '.bridge-open.lock');
  const owner = Number(await readFile(lock, 'utf8').catch(() => '0'));
  if (alive(owner)) throw Error('Сессия уже открыта другим способом. Сначала остановите тот сервер.');
  await rm(lock, { force: true });
  const logfile = path.join(data, 'server.log');
  const handle = await open(logfile, 'w');
  let child;
  try {
    child = spawn(process.execPath, [cli, 'open', '--data', data], { cwd: root, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
    child.on('error', () => {}); child.unref();
  } finally { await handle.close(); }
  try {
    for (let i = 0; i < 100; i++) {
      const text = await readFile(logfile, 'utf8');
      const match = text.match(/Compose Visual Bridge: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && alive(child.pid)) {
        const value = { pid: child.pid, url: match[1] };
        if (await serverVersion(value)===BRIDGE_VERSION) { await atomic(path.join(data, 'runtime.json'), value); return { ...value, reused: false }; }
      }
      if (!alive(child.pid)) break;
      await pause();
    }
    throw Error(`Редактор не запустился. Диагностика: ${logfile}`);
  } catch (error) { if (alive(child.pid)) process.kill(child.pid, 'SIGTERM'); throw error; }
}
async function stop(data) {
  const value = await runtime(data);
  if (!value) return { stopped: false };
  process.kill(value.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    // The CLI removes this lock only after its server exits.
    try { await access(path.join(data, '.bridge-open.lock')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await rm(path.join(data, 'runtime.json'), { force: true }); return { stopped: true };
    }
    await pause();
  }
  throw Error('Сервер ещё останавливается. Повторите stop. Данные сохранены.');
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw Error('Для плагина нужен Node.js 20 или новее.');
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Compose Visual Bridge: setup | edit-scene --adapter <JSON> --preview <Preview> --serial <эмулятор> --state <сцена> | edit-compose --file <Kotlin> --symbol <Composable> --serial <эмулятор> --state <сцена> | create-compose --input <импорт> --capture <кадр> | compose-plan | prepare-native --output <копия> | native-run --workspace <копия> --serial <эмулятор> --state <сцена> | native-build --workspace <копия> | native-catalog --workspace <копия> | create --input <JSON> | create-native | native --endpoint <WS> --source-revision <SHA> --state <сцена> [--workspace <копия>] | source-native --workspace <копия> | read-native | list | open | reference --input <снимок> --label <экран> | edit-previews --adapter <JSON> | prepare-live --adapter <JSON> --serial <эмулятор> --sdk <SDK> | edit-live --workspace <копия> | result --input <результат.json> | create-screen --name <экран> [--request <запрос>] | palette --input <палитра.json> | read | stop\nПараметры: --project <проект> (по умолчанию текущий каталог), --session <ID> для open/read/stop.'); return;
  }
  const allowed = { 'edit-previews':['--project','--adapter','--module','--sdk','--output'], 'live-run':['--project','--workspace','--serial'], 'prepare-live':['--project','--adapter','--serial','--sdk','--module','--output'], 'edit-live':['--project','--workspace'], 'create-screen':['--project','--name','--request'], palette:['--project','--input'], setup: [], list:['--project'], create: ['--input', '--project'], 'create-compose':['--input','--capture','--project'],'edit-scene':['--project','--workspace','--adapter','--serial','--state','--preview','--sdk','--module'], 'edit-compose':['--project','--workspace','--file','--symbol','--serial','--state','--preview','--sdk','--module','--parameters','--resources'], 'compose-plan':['--project','--session','--workspace'], 'create-native':['--project'], 'prepare-native':['--project','--output','--module','--preview-source','--sdk','--upgrade-kotlin'], 'native-build':['--workspace'], 'native-catalog':['--workspace'], native:['--project','--session','--endpoint','--source-revision','--state','--origin-x','--origin-y','--workspace'], 'native-run':['--project','--session','--workspace','--serial','--state','--preview','--sdk'], 'source-native':['--project','--session','--workspace'], 'read-native':['--project','--session'], open: ['--project', '--session'], read: ['--project', '--session'], result:['--project','--session','--input'], reference: ['--project','--session','--input','--label'], stop: ['--project', '--session'] }[command];
  if (!allowed) throw Error('Неизвестная команда. Используйте --help.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key]) throw Error(`Некорректный аргумент: ${key}`);
    options[key] = value;
  }
  if(['prepare-native','native-build','native-catalog'].includes(command)) {
    if(command==='prepare-native'&&!options['--project'])options['--project']=process.cwd();
    const action={'prepare-native':'prepare','native-build':'build','native-catalog':'catalog'}[command];
    const result=await exec(process.execPath,[path.join(root,'scripts/native-project.mjs'),action,...Object.entries(options).flat()],{maxBuffer:16*1024*1024});
    console.log(result.stdout.trim());return;
  }
  if (command === 'reference' && (!options['--input'] || !options['--label'])) throw Error('Для эталона нужны --input <снимок> и --label <экран, состояние и устройство>');
  if (command === 'setup') {
    for (const name of ['project.mjs', 'live.mjs', 'previews.mjs', 'docs/previews.md', 'integrations/android/BridgePreviewCapture.kt', 'docs/live-app.md', 'integrations/android/BridgeLiveCapture.kt', 'scene.mjs', 'server.mjs', 'public/build/entry.js', 'public/model.mjs', 'AGENT.md', 'docs/protocol.md', 'docs/native-ui.md', 'native.mjs', 'source-map.mjs', 'scripts/native-project.mjs', 'scripts/native-device.mjs', 'public/build/native.js', 'public/index.html']) await access(path.join(root, name));
    const {toolchain}=await import('./native-project.mjs');const native=await toolchain();
    console.log(json({ ready: true, node: process.versions.node, native, editorReady:true, composeToolchainReady:native.nodeReady&&native.buildReady, liveCapture:{status:'experimental',nativeAccepted:false}, message: native.nodeReady&&native.buildReady?'Редактор установлен, Android toolchain найден. Откройте выбранную сцену через edit-compose и сверьте настоящий исходник.':'Редактор установлен. Для Android-захвата настройте недостающие компоненты toolchain, указанные в native.' })); return;
  }
  const project = await realpath(path.resolve(options['--project'] || process.cwd()));
  const home = path.resolve(process.env.BRIDGE_HOME || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'compose-visual-bridge'));
  const projectKey = createHash('sha256').update(project).digest('hex').slice(0, 24);
  const projectData = path.join(home, projectKey);
  await mkdir(projectData, { recursive: true });
  projectContext={format:'compose-visual-bridge-project-v1',project,home};
  if(command==='palette'){if(!options['--input'])throw Error('Нужен --input с палитрой проекта');const palette=validatePalette(await load(path.resolve(options['--input'])));await locked(projectData,()=>atomic(path.join(projectData,'palette.json'),palette));console.log(json(palette));return;}
  if(command==='create-screen'){const document=blankScreen({name:options['--name'],request:options['--request']||''}),container=await mkdtemp(path.join(projectData,'screen-')),data=path.join(container,'data');try{await mkdir(data);await atomic(path.join(data,'session.json'),{revision:0,baseline:document,current:document,applied:null});const server=await launch(data);await locked(projectData,()=>atomic(path.join(projectData,'latest.json'),{session:path.basename(container)}));console.log(json({project,session:path.basename(container),data,...server}));}catch(error){await stop(data).catch(()=>{});await rm(container,{recursive:true,force:true});throw error;}return;}
  if(command==='live-run'){if(!options['--serial'])throw Error('Нужен выделенный эмулятор --serial');const workspace=options['--workspace']||(await load(path.join(projectData,'live.json')))?.workspace;if(!workspace)throw Error('Сначала prepare-live');const {launchLive}=await import('../live.mjs');console.log(json(await launchLive(workspace,{serial:options['--serial']})));return;}
  if(command==='prepare-live'){
    if(!options['--adapter']||!options['--sdk'])throw Error('Нужны --adapter и --sdk');
    const {prepareLive}=await import('../live.mjs');const result=await prepareLive({project,output:options['--output']||path.join(projectData,'live-'+randomUUID()),adapter:await load(path.resolve(options['--adapter'])),serial:options['--serial'],sdk:options['--sdk'],module:options['--module']});await locked(projectData,()=>atomic(path.join(projectData,'live.json'),{workspace:result.workspace,captures:{}}));console.log(json(result));return;
  }
  if(command==='edit-previews'){
    if(!options['--adapter'])throw Error('Нужен --adapter со связями экранов');
    const {capturePreviews}=await import('../previews.mjs');
    const captured=await capturePreviews({project,output:options['--output']||path.join(projectData,'previews-'+randomUUID()),adapter:await load(path.resolve(options['--adapter'])),module:options['--module'],sdk:options['--sdk']});
    // One session per screen; the editor's screen list switches between them.
    const sessions=[];
    try{for(const {document,frame} of captured.screens){const container=await mkdtemp(path.join(projectData,'screen-')),data=path.join(container,'data');sessions.push(data);await mkdir(data);await atomic(path.join(data,'session.json'),{revision:0,baseline:document,current:document,applied:null,reference:readReference({mime:'image/png',image:frame.image,label:document.name}),verification:null});}}
    catch(error){for(const data of sessions)await rm(path.dirname(data),{recursive:true,force:true});throw error;}
    const first=path.basename(path.dirname(sessions[0])),server=await launch(sessions[0]);await locked(projectData,()=>atomic(path.join(projectData,'latest.json'),{session:first}));
    console.log(json({project,session:first,workspace:captured.workspace,...server,mode:'compose',entry:'preview',screens:captured.screens.map((s,i)=>({name:s.document.name,session:path.basename(path.dirname(sessions[i]))})),skipped:captured.skipped,next:'Экраны открыты в списке «Экран и состояние». Пропущенным Preview нужны связи в адаптере.'}));return;
  }
  if(command==='edit-live'){
    const {captureLive}=await import('../live.mjs');
    const result=await locked(projectData,async()=>{const live=await load(path.join(projectData,'live.json')),workspace=options['--workspace']||live?.workspace;if(!workspace)throw Error('Сначала подготовьте debug-копию: prepare-live');const captured=await captureLive(workspace);if(live?.workspace===workspace&&live.captures?.[captured.captureId]){const id=live.captures[captured.captureId],data=path.join(projectData,id,'data');await atomic(path.join(projectData,'latest.json'),{session:id});return {project,session:id,data,...await launch(data),reusedCapture:true};}const container=await mkdtemp(path.join(projectData,'screen-')),data=path.join(container,'data');try{await mkdir(data);await atomic(path.join(data,'session.json'),{revision:0,baseline:captured.document,current:captured.document,applied:null,reference:readReference({mime:'image/png',image:captured.frame.image,label:captured.document.name}),verification:null});const server=await launch(data),id=path.basename(container);await atomic(path.join(projectData,'live.json'),{workspace,captures:{...(live?.workspace===workspace?live.captures:{}),[captured.captureId]:id}});await atomic(path.join(projectData,'latest.json'),{session:id});return {project,session:id,data,...server,mode:'compose',entry:'live'};}catch(error){await stop(data).catch(()=>{});await rm(container,{recursive:true,force:true});throw error;}});console.log(json(result));return;
  }
  if(command==='edit-scene'){
    for(const key of ['--adapter','--serial','--state','--preview'])if(!options[key])throw Error('Нужен '+key);
    const {prepare,build,sourceRevision}=await import('./native-project.mjs'),{launch:launchNative,stop:stopNative}=await import('./native-device.mjs');
    const {prepareScene,instrumentScene,restoreScene,bindScene}=await import('../scene.mjs');
    const workspace=options['--workspace']?await realpath(path.resolve(options['--workspace'])):(await prepare({project,output:path.join(projectData,'workspace-'+randomUUID()),module:options['--module']||':app',sdk:options['--sdk'],upgradeKotlin:'2.3.20'})).workspace;
    const scene=await prepareScene(workspace,await load(path.resolve(options['--adapter'])));
    const placeholder={schemaVersion:1,name:scene.name,sourceRevision:scene.workspaceRevision,viewport:{width:360,height:640},root:{id:'capture-root',type:'Box',props:{}}};
    const container=await mkdtemp(path.join(projectData,'capture-')),captureData=path.join(container,'data');let instrumented=false,connection;
    try{
      await instrumentScene(scene);instrumented=true;const buildResult=await build(workspace);
      await mkdir(captureData);await atomic(path.join(captureData,'session.json'),{revision:0,nativeOnly:true,baseline:placeholder,current:placeholder,applied:null});
      const captureServer=await launch(captureData);connection=await launchNative({workspace,serial:options['--serial'],url:captureServer.url,screenState:options['--state'],preview:options['--preview'],sdk:options['--sdk']});
      const captured=await load(path.join(captureData,'native-session.json'));await atomic(path.join(workspace,'.bridge-scene-frame.json'),captured.frame);if(captured.frame.sourceRevision!==buildResult.sourceRevision||await sourceRevision(workspace)!==buildResult.sourceRevision)throw Error('Кадр сцены устарел');
      await restoreScene(workspace);instrumented=false;const bound=await bindScene(scene,captured.frame);
      const screen=await mkdtemp(path.join(projectData,'screen-')),data=path.join(screen,'data');
      try{await mkdir(data);await atomic(path.join(data,'session.json'),{revision:0,baseline:bound,current:bound,applied:null,reference:readReference({mime:'image/png',image:captured.frame.image,label:captured.frame.screenState+' · '+captured.frame.preview}),verification:null});const server=await launch(data);await locked(projectData,()=>atomic(path.join(projectData,'latest.json'),{session:path.basename(screen)}));console.log(json({project,session:path.basename(screen),data,workspace,mode:'compose',...server,next:'Редактируются элементы настоящей сцены; полный снимок переносит агент.'}));}
      catch(e){await stop(data).catch(()=>{});await rm(screen,{recursive:true,force:true});throw e;}
    }finally{if(connection)await stopNative(connection).catch(()=>{});await stop(captureData).catch(()=>{});if(instrumented)await restoreScene(workspace);await rm(container,{recursive:true,force:true});}
    return;
  }
  if(command==='edit-compose'){
    for(const key of ['--file','--symbol','--serial','--state'])if(!options[key])throw Error('Нужен '+key);
    const {prepare,build}=await import('./native-project.mjs'),{launch:launchNative,stop:stopNative}=await import('./native-device.mjs');
    const workspace=options['--workspace']?await realpath(path.resolve(options['--workspace'])):(await prepare({project,output:path.join(projectData,'workspace-'+randomUUID()),module:options['--module']||':app',sdk:options['--sdk'],upgradeKotlin:'2.3.20'})).workspace;
    const document=await importCompose({workspace,file:options['--file'],symbol:options['--symbol'],parameters:options['--parameters']?await load(path.resolve(options['--parameters'])):{},resources:options['--resources']?await load(path.resolve(options['--resources'])):{}});
    const container=await mkdtemp(path.join(projectData,'capture-')),captureData=path.join(container,'data');let instrumented=false,connection;
    try {
      await instrumentWorkspace(document);instrumented=true;await build(workspace);
      await mkdir(captureData);await atomic(path.join(captureData,'session.json'),{revision:0,nativeOnly:true,baseline:document,current:document,applied:null});
      const captureServer=await launch(captureData);connection=await launchNative({workspace,serial:options['--serial'],url:captureServer.url,screenState:options['--state'],preview:options['--preview'],sdk:options['--sdk']});
      const captured=await load(path.join(captureData,'native-session.json'));await restoreWorkspace(workspace);instrumented=false;
      const bound=await bindWorkspaceCapture(document,captured.frame),screen=await mkdtemp(path.join(projectData,'screen-')),data=path.join(screen,'data');
      try {await mkdir(data);await atomic(path.join(data,'session.json'),{revision:0,baseline:bound,current:bound,applied:null,reference:readReference({mime:'image/png',image:captured.frame.image,label:captured.frame.screenState+' · '+captured.frame.preview}),verification:null});
        const server=await launch(data);await locked(projectData,()=>atomic(path.join(projectData,'latest.json'),{session:path.basename(screen)}));
        console.log(json({project,session:path.basename(screen),data,workspace,mode:'compose',...server,next:'Редактируются сами HTML-элементы. Сравните исходник с Android-эталоном перед передачей.'}));
      }catch(e){await stop(data).catch(()=>{});await rm(screen,{recursive:true,force:true});throw e;}
    }finally{if(connection)await stopNative(connection).catch(()=>{});await stop(captureData).catch(()=>{});if(instrumented)await restoreWorkspace(workspace);await rm(container,{recursive:true,force:true});}
    return;
  }
  if (command === 'list') {
    const latest=(await load(path.join(projectData,'latest.json')))?.session;
    const sessions=[];
    for(const id of await readdir(projectData)) {
      if(!/^screen-[a-zA-Z0-9]+$/.test(id))continue;
      const filename=path.join(projectData,id,'data/session.json'), session=await load(filename);
      if(!session)continue;
      const native=session.nativeOnly?await load(path.join(projectData,id,'data/native-session.json')):null;
      sessions.push({session:id,mode:session.nativeOnly?'native':session.baseline.compose?'compose':'model',name:session.nativeOnly?(native?.frame?.screenState||'Настоящий UI'):session.current.name,state:session.nativeOnly?(native?.frame?.preview||null):(session.baseline.state||null),latest:id===latest,verified:session.nativeOnly?!!(native?.frame&&native.confirmedDigest===native.frame.digest):isVerified(session),updatedAt:(await stat(filename)).mtime.toISOString()});
    }
    sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    console.log(json({project,sessions,palette:await load(path.join(projectData,'palette.json')),live:!!(await load(path.join(projectData,'live.json')))})); return;
  }
  if (command === 'create' || command === 'create-native' || command === 'create-compose') {
    if (command==='create'&&!options['--input']) throw Error('Для нового экрана нужен JSON: --input <файл>. Макет готовит агент по исходникам.');
    const container = await mkdtemp(path.join(projectData, 'screen-'));
    const data = path.join(container, 'data');
    try {
      if(command==='create-compose'){if(!options['--input']||!options['--capture'])throw Error('Нужны импорт Compose --input и настоящий кадр --capture');const input=await load(path.resolve(options['--input'])),capture=await load(path.resolve(options['--capture'])),frame=capture?.frame||capture,document=await bindWorkspaceCapture(input,frame);await mkdir(data,{recursive:true});const reference=readReference({mime:'image/png',image:frame.image,label:frame.screenState+' · '+frame.preview});await atomic(path.join(data,'session.json'),{revision:0,baseline:document,current:document,applied:null,reference,verification:null});
      }else if(command==='create-native') {
        await mkdir(data,{recursive:true});
        const document={schemaVersion:1,name:'Служебная сессия настоящего UI',viewport:{width:360,height:640,presentation:'content'},root:{id:'native-placeholder',type:'Column',props:{width:'fill',height:'fill'},children:[]}};
        await atomic(path.join(data,'session.json'),{revision:0,baseline:document,current:document,applied:null,nativeOnly:true});
      }else await exec(process.execPath, [cli, 'create', '--input', path.resolve(options['--input']), '--data', data]);
      await locked(projectData, () => atomic(path.join(projectData, 'latest.json'), { session: path.basename(container) }));
    } catch (error) { await rm(container, { recursive: true, force: true }); throw error; }
    console.log(json({ project, session: path.basename(container), data })); return;
  }
  if(command==='result'&&!options['--input'])throw Error('Нужен --input с результатом переноса');
  const id = options['--session'] || (await load(path.join(projectData, 'latest.json')))?.session;
  if (!id) throw Error('В этом проекте ещё нет макета. Подготовьте экран и выполните create.');
  if (!/^screen-[a-zA-Z0-9]+$/.test(id)) throw Error('Неверный идентификатор сессии. Используйте session из create/open.');
  const data = path.join(projectData, id, 'data');
  await access(path.join(data, 'session.json'));
  const value = await locked(data, async () => {
    if (command === 'stop') {
      const device=await load(path.join(data,'native-device.json'));let deviceCleanupError;
      if(device){try{await exec(process.execPath,[path.join(root,'scripts/native-device.mjs'),'stop','--serial',device.serial,'--port',String(device.port),...(device.sdk?['--sdk',device.sdk]:[])]);await rm(path.join(data,'native-device.json'),{force:true});}catch(error){deviceCleanupError=error.stderr?.trim()||error.message;}}
      return {...await stop(data),...(deviceCleanupError?{deviceCleanupError}:{})};
    }
    const server = await launch(data);
    if(command==='compose-plan'){const response=await fetch(server.url+'/api/handoff'),handoff=await response.json();if(!response.ok)throw Error(handoff.error);if(handoff.applied.mode!=='review'||!handoff.verification)throw Error('Нужна подтверждённая передача; тестовый снимок не переносится автоматически');const needs=transferNeeds(handoff.baseline,handoff.document);if(needs.length||handoff.baseline.compose?.format==='compose-visual-bridge-runtime-scene-v1')return {strategy:'agent',applied:handoff.applied,requiresAgent:needs,document:handoff.document,next:'Перенесите полный снимок вручную по AGENT.md; сохраните все намерения и проверьте Android. Автоматический план не создавался.'};const workspace=options['--workspace']||handoff.baseline.compose?.workspace;if(!workspace)throw Error('Нет связанной рабочей копии');const plan=await planCompose({baseline:handoff.baseline,current:handoff.document,workspace}),filename=path.join(data,'compose-plan-'+randomUUID()+'.json');await atomic(filename,plan);return {strategy:'adapter',plan:filename,file:plan.file,beforeHash:plan.beforeHash,afterHash:plan.afterHash,operations:plan.operations,next:'Прочитайте план; применяйте только по поручению на перенос: scripts/compose.mjs apply --plan <файл>'};}
    if (command === 'open') {await locked(projectData,()=>atomic(path.join(projectData,'latest.json'),{session:id}));const session=await load(path.join(data,'session.json'));return {project,session:id,data,...server,mode:session.nativeOnly?'native':session.baseline.compose?'compose':'model',editing:session.nativeOnly?'frames':'elements',...(session.nativeOnly?{nativeUrl:server.url+'/native',notice:'Это PNG с рамками. Для редактирования элементов используйте edit-compose.'}:{})};}
    if(command==='native-run'){
      if(!(await load(path.join(data,'session.json')))?.nativeOnly)throw Error('Сначала создайте настоящую сессию: create-native');
      const parameters=['launch','--url',server.url,...Object.entries(options).filter(([key])=>!['--project','--session'].includes(key)).flat()];
      const result=JSON.parse((await exec(process.execPath,[path.join(root,'scripts/native-device.mjs'),...parameters],{maxBuffer:16*1024*1024})).stdout);
      const previous=await load(path.join(data,'native-device.json'));if(previous&&previous.port!==result.port){try{await exec(process.execPath,[path.join(root,'scripts/native-device.mjs'),'stop','--serial',previous.serial,'--port',String(previous.port),'--sdk',previous.sdk]);}catch{}}
      await atomic(path.join(data,'native-device.json'),result);return result;
    }
    if(['native','source-native','read-native'].includes(command)) {
      const parameters=command!=='read-native'?[command==='source-native'?'source':'connect','--url',server.url,...Object.entries(options).filter(([key])=>!['--project','--session'].includes(key)).flat()]:['read','--url',server.url];
      return JSON.parse((await exec(process.execPath,[path.join(root,'scripts/native.mjs'),...parameters],{maxBuffer:12*1024*1024})).stdout);
    }
    try { return JSON.parse((await exec(process.execPath, [cli, command, '--url', server.url, ...(command==='result'?['--input',path.resolve(options['--input'])]:[]), ...(command === 'reference' ? ['--input',path.resolve(options['--input']),'--label',options['--label']] : [])], { maxBuffer: 8 * 1024 * 1024 })).stdout); }
    catch (error) { throw Error(error.stderr?.trim() || error.message); }
  });
  console.log(json(value));
}
main().catch(error => { console.error(`Ошибка: ${error.stderr?.trim() || error.message}`); process.exitCode = 1; });
