import {readFile} from 'node:fs/promises';
const [command,...args]=process.argv.slice(2),options={};
try {
  if(!command||command==='--help') {
    console.log('Native UI: connect --url <редактор> --endpoint <ws://127.0.0.1:PORT/> --source-revision <SHA> --state <сцена> | import --url <редактор> --input <Buddy JSON> --source-revision <SHA> --state <сцена> [--workspace <рабочая копия>] | source --url <редактор> --workspace <рабочая копия> | read --url <редактор> | status --url <редактор> | disconnect --url <редактор>');
  }else {
    const allowed=new Set(['--url','--endpoint','--source-revision','--state','--input','--origin-x','--origin-y','--workspace']);
    for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||options[args[i]])throw Error('Некорректные параметры');options[args[i]]=args[i+1];}
    const url=new URL(options['--url']);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Нужен loopback URL редактора');
    const request=async(route,input)=>{const res=await fetch(new URL(route,url),input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});const data=await res.json();if(!res.ok)throw Error(data.error);return data;};
    const state=await request('/api/native');let result;
    if(command==='status')result=state;
    else if(command==='read')result=await request('/api/native/handoff');
    else if(command==='disconnect')result=await request('/api/native/disconnect',{revision:state.revision});
    else if(command==='source')result=await request('/api/native/source',{revision:state.revision,digest:state.frame?.digest,workspace:options['--workspace']});
    else if(['connect','import'].includes(command)) {
      const metadata={workspace:options['--workspace'],sourceRevision:options['--source-revision'],screenState:options['--state'],origin:{x:Number(options['--origin-x']||0),y:Number(options['--origin-y']||0)},revision:state.revision};
      result=await request('/api/native/'+(command==='import'?'frame':'connect'),{...metadata,...(command==='import'?{frame:JSON.parse(await readFile(options['--input'],'utf8'))}:{endpoint:options['--endpoint']})});
    }else throw Error('Неизвестная команда');
    console.log(JSON.stringify({url:new URL('/native',url).href,...result},null,2));
  }
}catch(error){console.error(`Ошибка: ${error.message}`);process.exitCode=1;}
