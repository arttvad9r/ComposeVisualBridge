// Общий контракт HTML-редактора, Kotlin-адаптера и передачи агенту.
export const COMPOSE_TYPES = ['Text','Column','Row','Box','Card','Button','Spacer','Surface'];
export const COMPOSE_PROPERTIES = ['text','fontSize','lineHeight','letterSpacing','fontWeight','fontFamily','fontStyle','textDecoration','textOverflow','color','textAlign','maxLines','width','height','padding','paddingHorizontal','paddingVertical','offsetX','offsetY','background','opacity','radius','borderWidth','borderColor','weight','gap','align','justify','enabled','clipContent','scrollable'];
const typography = new Set(['text','fontSize','lineHeight','letterSpacing','fontWeight','fontFamily','fontStyle','textDecoration','textOverflow','color','textAlign','maxLines']);
export function composeCapability(type, property, value, binding) {
  const agent = reason => ({mode:'agent',reason});
  if (binding?.agentOnly) return agent('Правку этого элемента перенесёт агент с учётом состояния и экземпляра.');
  if (!COMPOSE_TYPES.includes(type)) return agent('Подключение этого элемента выполнит агент.');
  if (!property) return {mode:'direct'};
  if (!COMPOSE_PROPERTIES.includes(property)) return agent('Это свойство перенесёт агент.');
  if (typography.has(property) && !['Text','Button'].includes(type)) return agent('Оформление этого элемента перенесёт агент.');
  if (['gap','align','justify'].includes(property) && !['Column','Row'].includes(type)) return agent('Положение в этом контейнере настроит агент.');
  if (property==='enabled' && type!=='Button') return agent('Поведение этого элемента подключит агент.');
  if (property==='scrollable' && !['Column','Row','Box','Card','Surface'].includes(type)) return agent('Прокрутку этого элемента подключит агент.');
  if (property==='clipContent' && type==='Card' && value===false) return agent('Изменение обрезки карточки выполнит агент.');
  if (property==='fontFamily' && value==='Roboto Flex') return agent('Этот шрифт подключит агент из ресурсов проекта.');
  if (property==='text') {
    const expression=binding?.args?.find(a=>a.name==='text')?.value;
    if (expression && !expression.trim().startsWith('"')) return agent('Текст связан с данными или ресурсом. Изменение выполнит агент.');
  }
  return {mode:'direct'};
}
export function transferNeeds(baseline, current) {
  if(current.state?.kind==='new-screen')return [{id:current.root.id,property:'screen',reason:'Новый экран, навигацию и поведение создаёт агент из общего документа и запроса.'}];
  if(baseline.compose?.format==='compose-visual-bridge-runtime-scene-v1')return JSON.stringify(baseline.root)===JSON.stringify(current.root)&&JSON.stringify(baseline.layout)===JSON.stringify(current.layout)&&JSON.stringify(baseline.viewport)===JSON.stringify(current.viewport)?[]:[{id:current.root.id,property:'scene',reason:'Полный снимок runtime-сцены переносит агент; исходники состояния, обработчиков и повторяющихся экземпляров сохраняются.'}];
  const entries=root=>{const map=new Map();const visit=n=>{map.set(n.id,n);(n.children||[]).forEach(visit);};visit(root);return map;};
  const before=entries(baseline.root), needs=[];
  for (const [id,node] of entries(current.root)) {
    const old=before.get(id),binding=baseline.compose?.bindings?.[id];
    if (old && JSON.stringify(old)===JSON.stringify(node)) continue;
    const component=composeCapability(node.type);
    if (component.mode==='agent') {needs.push({id,property:'component',reason:component.reason});continue;}
    if (old && old.type!==node.type) {needs.push({id,property:'type',reason:'Замену компонента выполнит агент.'});continue;}
    const textBinding=binding?.label?baseline.compose.bindings[binding.label]:binding;
    for(const key of new Set([...Object.keys(old?.props||{}),...Object.keys(node.props)])) {
      if(JSON.stringify(old?.props[key])===JSON.stringify(node.props[key]))continue;
      const capability=composeCapability(node.type,key,node.props[key],textBinding);
      if(capability.mode==='agent')needs.push({id,property:key,reason:capability.reason});
    }
  }
  for(const item of current.state?.paletteInsertions||[])if(!before.has(item.id))needs.push({id:item.id,property:'projectComponent',reason:'Компонент палитры подключает агент по исходному вызову проекта; шаблон не заменяет его поведение.'});
  return needs;
}
