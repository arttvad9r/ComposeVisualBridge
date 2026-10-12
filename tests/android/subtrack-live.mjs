// Запускается пользователем на хосте. Работает только с собственной арендой android-emu.
import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {captureLive} from '../../live.mjs';

const exec=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const decode=value=>value.replace(/&quot;|&apos;|&lt;|&gt;|&amp;/g,entity=>({'&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'}[entity]));
export function uiNodes(xml){
 return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)])));
}
export function uiPoint(nodes,predicate){
 const matches=nodes.filter(predicate).filter(node=>node.enabled!=='false'&&/^\[\d+,\d+\]\[\d+,\d+\]$/.test(node.bounds||''));
 if(matches.length!==1)throw Error('Ожидался один доступный элемент UI, найдено: '+matches.length);
 const [left,top,right,bottom]=matches[0].bounds.match(/\d+/g).map(Number);
 if(right<=left||bottom<=top)throw Error('У элемента UI нет видимой области');
 return [Math.floor((left+right)/2),Math.floor((top+bottom)/2)];
}

async function main(){
 const options=Object.fromEntries(process.argv.slice(2).reduce((entries,value,index,args)=>index%2?entries:[...entries,[value,args[index+1]]],[]));
 if(!options['--workspace']||!options['--output']||Object.keys(options).some(key=>!['--workspace','--output','--avd'].includes(key)))throw Error('Нужны --workspace <подготовленная копия> --output <новый каталог> [--avd oneplus-13s-2]');
 await access('/dev/kvm',constants.R_OK|constants.W_OK);
 const workspace=path.resolve(options['--workspace']),output=path.resolve(options['--output']),avd=options['--avd']||'oneplus-13s-2';
 if(!/^[a-z0-9-]+$/.test(avd))throw Error('Некорректное имя AVD');
 const manifest=JSON.parse(await readFile(path.join(workspace,'.bridge-live.json'),'utf8'));
 const native=JSON.parse(await readFile(path.join(workspace,'.bridge-native-workspace.json'),'utf8'));
 assert.equal(manifest.applicationId,'com.arttvad9r.subtrack.composebridge','Стенд рассчитан на debug-копию Subtrack');
 assert.equal(manifest.captureProtocol,2,'Нужна новая prepare-live');
 await mkdir(output); // Не перезаписывать предыдущую проверку.
 const env={...process.env,EMU_OWNER_PID:String(process.pid),ANDROID_HOME:manifest.sdk,PATH:manifest.sdk+'/emulator:'+manifest.sdk+'/platform-tools:'+process.env.PATH,BRIDGE_HOME:output+'/sessions'};
 const plugin=fileURLToPath(new URL('../../scripts/plugin.mjs',import.meta.url));
 let serial,attempted=false,browser,night,failed;
 const evidence={workspace,project:native.sourceProject,avd,captures:[],nativeScenarioPassed:false,visualAccepted:false};
 const run=async(command,args,timeout=30000)=>{const result=await exec(command,args,{env,timeout,maxBuffer:32*1024*1024});return result.stdout;};
 const cli=async(...args)=>JSON.parse(await run(process.execPath,[plugin,...args,'--project',native.sourceProject],90000));
 const adb=(...args)=>{assert.match(serial||'',/^emulator-\d+$/);return run(path.join(manifest.sdk,'platform-tools/adb'),['-s',serial,...args]);};
 const dump=async()=>{await adb('shell','uiautomator','dump','/sdcard/cvb-live-ui.xml');const xml=await adb('shell','cat','/sdcard/cvb-live-ui.xml');await writeFile(output+'/last-ui.xml',xml);return uiNodes(xml);};
 const tap=async(predicate)=>{let error;for(let i=0;i<12;i++){try{const point=uiPoint(await dump(),predicate);await adb('shell','input','tap',...point.map(String));await pause(500);return;}catch(e){error=e;await pause(500);}}throw error;};
 const labelled=label=>node=>node.text===label||node['content-desc']===label;
 const capture=async(label)=>{
  console.log('Захват: '+label);
  await adb('shell','run-as',manifest.applicationId,'rm','-f','files/compose-visual-bridge-live.json');
  await tap(node=>/^(Редактировать экран|Экран сохранён для редактора)$/.test(node.text||'')||/^(Редактировать экран|Экран сохранён для редактора)$/.test(node['content-desc']||''));
  let captured,lastError;
  for(let i=0;i<20;i++){try{captured=await captureLive(workspace);break;}catch(e){lastError=e;await pause(500);}}
  if(!captured){
   // Сохранять настоящий кадр и semantics до bind: при отказе импортера
   // устройство освобождается, а причина остаётся воспроизводимой без ADB.
   try{const raw=await adb('shell','run-as',manifest.applicationId,'cat','files/compose-visual-bridge-live.json');await writeFile(output+'/'+label+'-raw.json',raw);const frame=JSON.parse(raw);if(frame.image)await writeFile(output+'/'+label+'-raw.png',Buffer.from(frame.image,'base64'));}catch(error){evidence.captureEvidenceError=error.message;}
   throw lastError;
  }
  await writeFile(output+'/'+label+'.png',Buffer.from(captured.frame.image,'base64'));
  await writeFile(output+'/'+label+'.json',JSON.stringify(captured.document,null,2));
  const session=await cli('edit-live','--workspace',workspace);
  assert.equal((await cli('edit-live','--workspace',workspace)).session,session.session,'Повторный captureId должен вернуть ту же сессию');
  const page=await browser.newPage();
  try{await page.goto(session.url);await page.locator('#projectScreens').waitFor();await page.screenshot({path:output+'/'+label+'-editor.png',fullPage:true});}finally{await page.close();}
  evidence.captures.push({label,captureId:captured.captureId,session:session.session,screen:captured.document.name,systemTheme:captured.document.state.systemTheme});
  return {captured,session};
 };
 try{
  const status=await run('android-emu',['status']);await writeFile(output+'/status-before.txt',status);
  const row=status.split('\n').find(line=>line.startsWith(avd+' '));
  if(!row||row.trim().split(/\s+/)[3]!=='free')throw Error('Нужен свободный AVD: '+avd);
  attempted=true;console.log('Аренда '+avd+'; ожидание загрузки…');
  const claim=await run('android-emu',['claim',avd],660000);await writeFile(output+'/claim.txt',claim);
  serial=claim.match(/^ANDROID_SERIAL=(emulator-\d+)$/m)?.[1];assert.ok(serial,'android-emu не вернул serial');evidence.serial=serial;
  await cli('live-run','--workspace',workspace,'--serial',serial);
  // Данные только тестовой копии, на выделенном чистом устройстве.
  await adb('shell','pm','grant',manifest.applicationId,'android.permission.POST_NOTIFICATIONS');
  night=(await adb('shell','cmd','uimode','night')).match(/Night mode:\s*(yes|no|auto|custom)/i)?.[1]?.toLowerCase();
  if(!night)throw Error('Не удалось прочитать исходный режим темы');
  const {chromium,expect}=await import('@playwright/test');browser=await chromium.launch({headless:true});
  await adb('shell','cmd','uimode','night','no');await pause(1000);
  const empty=await capture('empty-light');assert.equal(empty.captured.document.name,'Подписки');assert.equal(empty.captured.document.state.systemTheme,'light');
  for(let i=0;i<2;i++){
   await tap(labelled('Добавить подписку'));
   for(const [index,value] of [[0,'BridgeTest'],[1,'100']]){const fields=(await dump()).filter(node=>node.class==='android.widget.EditText');assert.equal(fields.length,3,'Поля формы Subtrack изменились');const point=uiPoint([fields[index]],()=>true);await adb('shell','input','tap',...point.map(String));await adb('shell','input','text',value);await adb('shell','input','keyevent','111');}
   await adb('shell','input','keyevent','111');await tap(labelled('Сохранить'));await tap(labelled('Назад'));
  }
  const list=await capture('list-light');
  const identities=doc=>Object.entries(doc.compose.bindings).filter(([,binding])=>binding.source.symbol==='SubscriptionCard'&&binding.type==='Text').map(([id,binding])=>({id,identity:binding.runtimeIdentity})).sort((a,b)=>a.id.localeCompare(b.id));
  const twins=Object.entries(list.captured.document.compose.bindings).filter(([id,binding])=>binding.source.symbol==='SubscriptionCard'&&list.captured.document.compose.initial&&findNode(list.captured.document.root,id)?.props.text==='BridgeTest');
  assert.equal(twins.length,2,'Две одинаково названные подписки должны иметь две отдельные связи');assert.notEqual(twins[0][0],twins[1][0]);
  const editor=await browser.newPage();await editor.goto(list.session.url);
  await editor.locator('#tree [data-node-id="'+twins[0][0]+'"]').click();
  const textField=editor.locator('#inspector [data-property="text"]'),section=textField.locator('xpath=ancestor::details');
  if(await section.getAttribute('open')===null)await section.locator('summary').first().click();
  await textField.fill('BridgeDraft');await textField.press('Tab');await expect(editor.locator('#saveStatus')).toHaveText('Черновик сохранён ✓');
  const savedDraft=await(await fetch(list.session.url+'/api/session')).json();
  assert.equal(findNode(savedDraft.current.root,twins[0][0]).props.text,'BridgeDraft');
  // Первый из двух одинаковых элементов выбирается явно, по текущей видимой геометрии.
  const names=(await dump()).filter(labelled('BridgeTest')).sort((a,b)=>Number(a.bounds.match(/\d+/g)[1])-Number(b.bounds.match(/\d+/g)[1]));assert.equal(names.length,2);
  await adb('shell','input','tap',...uiPoint([names[0]],()=>true).map(String));await pause(500);
  const detail=await capture('detail-light');assert.equal(detail.captured.document.name,'Подписка');await tap(labelled('Назад'));
  await adb('shell','cmd','uimode','night','yes');await pause(1000);
  const dark=await capture('list-dark');assert.equal(dark.captured.document.state.systemTheme,'dark');assert.deepEqual(identities(dark.captured.document),identities(list.captured.document),'Смена темы должна сохранять runtime-идентичность данных');
  await editor.locator('#refreshScreens').click();await editor.locator('#screenList').selectOption(dark.session.session);await editor.locator('#openScreen').click();await expect(editor.locator('#projectName')).toHaveText('Подписки');
  await editor.locator('#screenList').selectOption(list.session.session);await editor.locator('#openScreen').click();await expect(editor.locator('#undo')).toBeEnabled();
  assert.deepEqual((await(await fetch(list.session.url+'/api/session')).json()).current,savedDraft.current);
  await editor.close();await cli('stop','--session',list.session.session);
  const reopened=await cli('open','--session',list.session.session);const restored=await(await fetch(reopened.url+'/api/session')).json();assert.deepEqual(restored.current,savedDraft.current);
  const reopenedPage=await browser.newPage();await reopenedPage.goto(reopened.url);await expect(reopenedPage.locator('#undo')).toBeEnabled();await reopenedPage.close();
  evidence.nativeScenarioPassed=true;
  console.log('Переходы, темы, две одинаковые строки и импорт проверены. PNG требуют визуальной сверки.');
 }catch(error){failed=error;evidence.error=error.stack;}
 finally{
  const cleanup=[];
  if(browser)await browser.close().catch(error=>cleanup.push(error.message));
  for(const session of (await cli('list').catch(error=>{cleanup.push(error.message);return {sessions:[]};})).sessions)await cli('stop','--session',session.session).catch(error=>cleanup.push(error.message));
  if(serial&&night)await adb('shell','cmd','uimode','night',night).catch(error=>cleanup.push(error.message));
  if(attempted)await run('android-emu',['release',avd],60000).catch(error=>cleanup.push(error.message));
  evidence.cleanupErrors=cleanup;await writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));
  if(cleanup.length&&!failed)failed=Error('Не завершена очистка: '+cleanup.join('; '));
 }
 console.log('Результаты: '+output+'/evidence.json');if(failed)throw failed;
}
function findNode(node,id){if(node.id===id)return node;for(const child of node.children||[]){const found=findNode(child,id);if(found)return found;}return null;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
