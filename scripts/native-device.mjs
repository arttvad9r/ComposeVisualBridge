import {randomInt} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalog} from './native-project.mjs';
const exec=promisify(execFile);
export async function launch({workspace,serial,url,screenState,preview,sdk}){
  if(!/^emulator-\d+$/.test(serial||''))throw Error('Укажите serial выбранного тестового Android-эмулятора');
  if(typeof screenState!=='string'||!screenState.trim())throw Error('Укажите воспроизводимое состояние экрана');
  const editor=new URL(url);if(editor.protocol!=='http:'||!['127.0.0.1','localhost'].includes(editor.hostname)||!editor.port||editor.username||editor.password||editor.pathname!=='/'||editor.search||editor.hash)throw Error('Нужен loopback URL редактора');
  const initialResponse=await fetch(new URL('/api/native',editor)),initial=await initialResponse.json();if(!initialResponse.ok)throw Error(initial.error);if(initial.draft?.length)throw Error('Сначала завершите текущие правки; новая установка не заменяет исходник черновика');
  const build={...await catalog(workspace),workspace:await realpath(workspace)};preview||=build.previews[0];if(!build.previews.includes(preview))throw Error('Preview не найден в каталоге успешной сборки');
  if(!sdk){const local=await readFile(path.join(build.workspace,'local.properties'),'utf8').catch(()=> '');sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||local.match(/^sdk\.dir=(.+)$/m)?.[1]?.replace(/\\([\\:])/g,'$1');}
  if(!sdk)throw Error('Укажите --sdk или ANDROID_HOME');
  const adb=path.join(sdk,'platform-tools/adb'),versions=(await readdir(path.join(sdk,'build-tools'))).filter(v=>/^\d+(?:\.\d+)*$/.test(v)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(!versions.length)throw Error('Не найден Android build-tools/aapt');
  const apk=path.join(build.workspace,build.apk),badging=(await exec(path.join(sdk,'build-tools',versions.at(-1),'aapt'),['dump','badging',apk])).stdout;
  const applicationId=badging.match(/^package: name='([\w.]+)'/m)?.[1];if(!applicationId)throw Error('Не удалось определить applicationId APK');
  const call=(args)=>exec(adb,['-s',serial,...args],{maxBuffer:2*1024*1024});
  if((await call(['get-state'])).stdout.trim()!=='device'||(await call(['shell','getprop','sys.boot_completed'])).stdout.trim()!=='1')throw Error('Выбранный эмулятор ещё не готов');
  const installation=await call(['install','-r',apk]);if(!installation.stdout.includes('Success'))throw Error('APK не установлен');
  await catalog(workspace);
  const devicePort=randomInt(20000,60000);
  const port=Number((await call(['forward','tcp:0',`tcp:${devicePort}`])).stdout.trim());if(!Number.isInteger(port)||port<1||port>65535)throw Error('ADB не выделил порт для Preview');
  try{
    // Start a fresh Activity after an APK rebuild; no old Buddy server is reused.
    await call(['shell','am','force-stop',applicationId]);
    const activity=await call(['shell','am','start','-S','-W','-f','0x10008000','-n',applicationId+'/dev.mikepenz.composebuddy.device.BuddyPreviewActivity','--es','preview',preview,'--ei','port',String(devicePort)]);
    if(/Error:|Exception/.test(activity.stdout+activity.stderr))throw Error('Не удалось открыть Preview Activity');
    const endpoint=`ws://127.0.0.1:${port}/`;
    const result=await exec(process.execPath,[fileURLToPath(new URL('./native.mjs',import.meta.url)),'connect','--url',editor.href,'--endpoint',endpoint,'--source-revision',build.sourceRevision,'--state',screenState,'--workspace',build.workspace],{maxBuffer:16*1024*1024});
    let state=JSON.parse(result.stdout),readySince=0;
    for(let attempt=0;attempt<150;attempt++){const response=await fetch(new URL('/api/native',editor));state=await response.json();if(!response.ok)throw Error(state.error);if(state.connection.status==='error')throw Error(state.connection.error);if(state.connection.status==='connected'&&state.frame?.preview===preview&&state.frame.sourceRevision===build.sourceRevision){readySince||=Date.now();if(Date.now()-readySince>=300)break;}else readySince=0;await new Promise(resolve=>setTimeout(resolve,100));}
    if(state.frame?.preview!==preview||state.frame.sourceRevision!==build.sourceRevision||state.connection.status!=='connected')throw Error('Preview не прислал кадр новой сборки');
    return {sdk,serial,port,devicePort,applicationId,preview,sourceRevision:build.sourceRevision,apkSha256:build.apkSha256,endpoint,nativeUrl:new URL('/native',editor).href,nodes:state.frame.nodes.length};
  }catch(error){await call(['forward','--remove',`tcp:${port}`]).catch(()=>{});throw error;}
}
export async function stop({serial,port,sdk}){
  if(!/^emulator-\d+$/.test(serial||'')||!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535)throw Error('Некорректный serial или порт');
  sdk||=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;if(!sdk)throw Error('Укажите --sdk или ANDROID_HOME');
  await exec(path.join(sdk,'platform-tools/adb'),['-s',serial,'forward','--remove',`tcp:${port}`]);return {stopped:true,serial,port:Number(port)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [action,...args]=process.argv.slice(2),options={};const flags={'--workspace':'workspace','--serial':'serial','--url':'url','--state':'screenState','--preview':'preview','--sdk':'sdk','--port':'port'};
    for(let i=0;i<args.length;i+=2){if(!flags[args[i]]||!args[i+1]||options[flags[args[i]]])throw Error('Некорректные параметры');options[flags[args[i]]]=args[i+1];}
    if(!['launch','stop'].includes(action))throw Error('Используйте launch --workspace --serial --url --state [--preview --sdk] или stop --serial --port --sdk');
    console.log(JSON.stringify(await(action==='launch'?launch(options):stop(options)),null,2));
  }catch(error){console.error('Ошибка: '+error.message);process.exitCode=1;}
}
