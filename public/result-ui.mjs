export function setupResult({api,accept,notice}){
 const $=id=>document.getElementById(id);let result;
 function update(state){
  result=state.result;$('transferResult').hidden=!result;if(!result)return;
  $('resultMessage').textContent=(result.mode==='test'?'Тестовый перенос · ':'')+(result.status==='failed'?'Перенос не завершён: ':result.acceptedAt?'Результат принят: ':'Перенос проверен: ')+result.message;
  const late=result.lateDraft;
  $('resultDetail').textContent=late?.status==='archived'?'Поздние правки сохранены отдельно. Верните предыдущую сессию или экспортируйте её для отдельного переноса.':late?.status==='rebased'?'Поздние правки сохранены поверх нового исходника.':result.acceptedAt?'Новый исходник готов к сверке.':result.status==='succeeded'?'Посмотрите настоящий экран и примите результат, чтобы обновить исходник.':'Черновик и исходник сохранены.';
  $('restoreLate').hidden=late?.status!=='archived';
  $('resultCompare').hidden=!result.reference;$('acceptResult').hidden=result.status!=='succeeded'||!!result.acceptedAt||result.snapshot!==state.applied?.directory;
 }
 $('resultCompare').onclick=()=>{
  $('resultBefore').hidden=!result.beforeReference;$('resultBefore').src=result.beforeReference||'';$('resultAfter').src=result.reference.url;
  $('resultBeforeMissing').hidden=!!result.beforeReference;$('resultChecks').textContent=Object.values(result.checks||{}).join('\n');$('resultDialog').showModal();
 };
 $('restoreLate').onclick=()=>$('restoreSession').click();
 $('closeResult').onclick=()=>$('resultDialog').close();
 $('acceptResult').onclick=async()=>{const id=result.id;$('acceptResult').disabled=true;try{await accept(id);}catch(error){notice(error.message,true);}finally{$('acceptResult').disabled=false;}};
 const timer=setInterval(()=>api('/api/result').then(update).catch(()=>{}),2500);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
 return update;
}
