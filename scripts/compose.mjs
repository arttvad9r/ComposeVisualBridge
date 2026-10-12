import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {importCompose,instrumentWorkspace,restoreWorkspace,bindWorkspaceCapture,generateCompose,planCompose,writeComposePlan} from '../compose.mjs';
const [command,...args]=process.argv.slice(2),options={};const allowed={import:['--workspace','--file','--symbol','--parameters','--resources','--viewport','--output'],instrument:['--input'],restore:['--workspace'],bind:['--input','--capture','--output'],plan:['--baseline','--current','--workspace','--output'],apply:['--plan'],generate:['--input','--package','--symbol','--output']}[command];
if(!allowed)throw Error('Команды: import, instrument, bind, restore, plan, apply, generate. См. docs/browser-compose.md');
for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options[args[i]])throw Error('Некорректный аргумент '+args[i]);options[args[i]]=args[i+1];}
const need=key=>{if(!options[key])throw Error('Нужен '+key);return options[key];},json=async file=>JSON.parse(await readFile(path.resolve(file),'utf8')),output=async value=>{if(options['--output'])await writeFile(path.resolve(options['--output']),JSON.stringify(value,null,2)+'\n',{flag:'wx'});else console.log(JSON.stringify(value,null,2));};
if(command==='import')await output(await importCompose({workspace:need('--workspace'),file:need('--file'),symbol:need('--symbol'),parameters:options['--parameters']?await json(options['--parameters']):{},resources:options['--resources']?await json(options['--resources']):{},viewport:options['--viewport']?await json(options['--viewport']):undefined}));
if(command==='instrument')await output(await instrumentWorkspace(await json(need('--input'))));
if(command==='restore')await output(await restoreWorkspace(path.resolve(need('--workspace'))));
if(command==='bind'){const capture=await json(need('--capture'));await output(await bindWorkspaceCapture(await json(need('--input')),capture.frame||capture));}
if(command==='plan')await output(await planCompose({baseline:await json(need('--baseline')),current:await json(need('--current')),workspace:need('--workspace')}));
if(command==='apply')await output(await writeComposePlan(await json(need('--plan'))));

if(command==='generate'){const code=generateCompose(await json(need('--input')),{packageName:need('--package'),symbol:need('--symbol')});await writeFile(path.resolve(need('--output')),code,{flag:'wx'});console.log(JSON.stringify({file:options['--output']}));}
