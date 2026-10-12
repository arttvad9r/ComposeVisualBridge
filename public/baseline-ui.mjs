const $ = id => document.getElementById(id);
let session, config;
export function handoffMode(document) {
  const verified=!!session?.verification && session.verification.baselineFingerprint===session.baselineFingerprint && session.verification.referenceDigest===session.reference?.digest;
  return verified && document.sourceRevision===session.baseline.sourceRevision ? 'review' : 'test';
}
export function updateBaselineSession(value) {
  session=value;
  const verified=!!value.verification && value.verification.baselineFingerprint===value.baselineFingerprint && value.verification.referenceDigest===value.reference?.digest;
  $('baselineStatus').textContent=verified?'Исходник проверен':'Исходник не проверен';
  $('baselineStatus').classList.toggle('verified',verified);
  $('baselineConfirm').disabled=true;
  $('referencePreview').hidden=!value.reference;
  $('uploadReference').textContent=value.reference?'Заменить снимок':'Загрузить снимок';
  $('referencePreview').onload=()=>{ $('baselineConfirm').disabled=verified; };
  $('referencePreview').onerror=()=>{ $('baselineConfirm').disabled=true; $('baselineError').textContent='Не удалось прочитать эталон. Загрузите корректное изображение.'; };
  if(value.reference) { $('referencePreview').src=`/api/reference?revision=${value.revision}`; $('referenceLabel').value=value.reference.label; }
  else { $('referencePreview').removeAttribute('src'); $('referenceLabel').value=''; }
  $('baselineFingerprint').textContent=`Исходники: ${value.baseline.sourceRevision || 'не указаны'} · ${value.baseline.viewport.width} × ${value.baseline.viewport.height} dp`;
}
export function setupBaseline(options) {
  config=options;
  $('baselineStatus').onclick=()=>{
    const original=$('before').firstElementChild.cloneNode(true), scale=220/session.baseline.viewport.width;
    original.style.transform=`scale(${scale})`;
    $('baselinePreview').style.width=`${session.baseline.viewport.width*scale}px`;
    $('baselinePreview').style.height=`${session.baseline.viewport.height*scale}px`;
    $('baselinePreview').replaceChildren(original);
    $('baselineError').textContent=''; $('baselineAcknowledged').checked=false;
    $('baselineDialog').showModal();
  };
  $('closeBaseline').onclick=()=>$('baselineDialog').close();
  $('baselineDialog').addEventListener('close',()=>$('baselineStatus').focus());
  const write=async(endpoint,payload)=>{
    $('baselineError').textContent='';
    try { const value=await config.write(endpoint,payload); updateBaselineSession(value); return value; }
    catch(error) { $('baselineError').textContent=error.message; }
  };
  $('uploadReference').onclick=()=> $('referenceFile').click();
  $('referenceFile').onchange=async()=>{
    const file=$('referenceFile').files[0]; if(!file)return;
    if(file.size>8_000_000) { $('baselineError').textContent='Снимок больше 8 MB. Выберите менее объёмный файл.'; return; }
    if(!$('referenceLabel').value.trim()) { $('baselineError').textContent='Сначала укажите экран, состояние и устройство.'; $('referenceFile').value=''; return; }
    $('baselineConfirm').disabled=true;
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte);
    await write('/api/baseline/reference',{image:btoa(binary),mime:file.type,label:$('referenceLabel').value});
    $('referenceFile').value='';
  };
  $('baselineConfirm').onclick=async()=>{
    if(!$('baselineAcknowledged').checked) { $('baselineError').textContent='Подтвердите совпадение после сравнения изображений.'; return; }
    const value=await write('/api/baseline/confirm',{baselineFingerprint:session.baselineFingerprint,acknowledged:true});
    if(value)$('baselineDialog').close();
  };
}
