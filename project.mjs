import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validate,clone,indexTree} from './public/model.mjs';
const exec=promisify(execFile);
export function blankScreen({name,request=''}){
 if(typeof name!=='string'||!name.trim()||name.length>200||typeof request!=='string'||request.length>5000)throw Error('Укажите название до 200 символов и запрос до 5000 символов');
 return validate({schemaVersion:1,name:name.trim(),sourceRevision:'new-screen-draft',state:{creationRequest:request,kind:'new-screen'},viewport:{width:360,height:640,presentation:'content'},layout:{mode:'auto'},root:{id:'screen-'+randomUUID().slice(0,8),type:'Column',props:{width:'fill',height:'fill',padding:16,gap:12},children:[]}});
}
export function validatePalette(input){
 if(input?.format!=='compose-visual-bridge-palette-v1'||typeof input.sourceRevision!=='string'||!input.sourceRevision.trim()||input.sourceRevision.length>500||!Array.isArray(input.components)||input.components.length>100)throw Error('Нужна палитра проекта с ревизией и не более 100 компонентов');
 const ids=new Set();for(const c of input.components){if(!c||typeof c.id!=='string'||!/^[\w.-]{1,100}$/.test(c.id)||ids.has(c.id)||typeof c.name!=='string'||!c.name.trim()||c.name.length>200)throw Error('Некорректный компонент палитры');ids.add(c.id);validate({schemaVersion:1,name:c.name,viewport:{width:360,height:640},root:c.node});if(!c.node.source?.file||!c.node.source?.symbol)throw Error('Компонент палитры требует связь с исходниками');}
 return clone(input);
}
export function instantiateComponent(component){const root=clone(component.node);for(const {node} of indexTree(root).values())node.id='palette-'+randomUUID().slice(0,8);return root;}
export async function projectCommand(context,command,options=[]){
 if(context?.format!=='compose-visual-bridge-project-v1'||typeof context.project!=='string'||typeof context.home!=='string')throw Error('Каталог экранов доступен в управляемой сессии плагина');
 let result;try{result=await exec(process.execPath,[fileURLToPath(new URL('./scripts/plugin.mjs',import.meta.url)),command,'--project',context.project,...options],{env:{...process.env,BRIDGE_HOME:context.home},maxBuffer:4*1024*1024,timeout:30000});}catch(error){throw Error(error.stderr?.trim()||'Не удалось открыть экран проекта');}return JSON.parse(result.stdout);
}
export async function projectContext(data){try{return JSON.parse(await readFile(data+'/project-context.json','utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
