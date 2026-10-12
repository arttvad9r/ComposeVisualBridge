export function setupProject({api,flush,revision,notice,addComponent}){
 const $=id=>document.getElementById(id);let catalog,loadRevision=0;
 async function load(){const request=++loadRevision,loaded=await api('/api/project');if(request!==loadRevision)return;catalog=loaded;$('projectScreens').hidden=!catalog.managed;if(!catalog.managed)return;const list=$('screenList'),previous=list.value;list.replaceChildren();for(const screen of catalog.sessions){const option=document.createElement('option');option.value=screen.session;const state=screen.state?.screenState||screen.state?.theme||'';option.textContent=screen.name+(state?' · '+state:'')+(screen.latest?' · последний':'');option.selected=screen.session===(catalog.sessions.some(s=>s.session===previous)?previous:catalog.activeSession);list.append(option);}const palette=$('projectPalette');palette.replaceChildren();for(const component of catalog.palette?.components||[]){const button=document.createElement('button');button.textContent=component.name;button.onclick=()=>addComponent(component,catalog.palette.sourceRevision);palette.append(button);}$('paletteSection').hidden=!catalog.palette?.components.length;$('liveScreen').hidden=!catalog.live;}
 async function navigate(endpoint,payload){document.body.inert=true;try{await flush();const result=await api(endpoint,'POST',{...payload,revision:revision()});location.assign(result.nativeUrl||result.url);}catch(error){notice(error.message,true);document.body.inert=false;}}
 const refresh=()=>load().catch(error=>notice(error.message,true));
 $('refreshScreens').onclick=refresh;window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 $('liveScreen').onclick=()=>navigate('/api/project/live',{});
 $('openScreen').onclick=()=>navigate('/api/project/open',{session:$('screenList').value});
 $('newScreen').onclick=()=>$('newScreenDialog').showModal();$('closeNewScreen').onclick=()=>$('newScreenDialog').close();
 $('createScreen').onclick=()=>navigate('/api/project/create',{name:$('newScreenName').value,request:$('newScreenRequest').value});
 return load;
}
