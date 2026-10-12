// Both providers use index.html and the same workspace. Controllers own provider semantics.
if(location.pathname==='/native')await import('./native.mjs');
else await import('./app.mjs');

const tools=document.getElementById('advancedTools');
document.addEventListener('click',event=>{if(!tools.contains(event.target))tools.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]'))tools.open=false;});
