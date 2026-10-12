// Shared meaning of sizes and painting for the restricted Compose adapter.
export const MODIFIER_MODEL = 'outer-size-v1';
export const MODIFIER_GROUPS = ['width','height','padding','offset','background','opacity','radius','border','weight','clipContent','scrollable'];
const properties = {padding:['padding','paddingHorizontal','paddingVertical'],offset:['offsetX','offsetY'],border:['borderWidth','borderColor']};

export function modifierMetrics(props, binding) {
  const order = [...(binding?.modifierLayout?.order || [])];
  // The Kotlin patch appends new calls in this same order, after existing calls.
  for (const group of MODIFIER_GROUPS) {
    if (!order.includes(group) && (properties[group] || [group]).some(key => props[key] !== undefined)) order.push(group);
  }
  const padding = order.indexOf('padding');
  const precedes = group => padding >= 0 && padding < order.indexOf(group);
  const horizontal = props.paddingHorizontal ?? props.padding ?? 0;
  const vertical = props.paddingVertical ?? props.padding ?? 0;
  return {horizontal,vertical,widthInset:precedes('width')?2*horizontal:0,heightInset:precedes('height')?2*vertical:0,backgroundInset:precedes('background')?{horizontal,vertical}:{horizontal:0,vertical:0}};
}

export function outerModifierProps(props, binding) {
  const metrics = modifierMetrics(props,binding), result = {...props};
  for (const key of ['width','height']) if (typeof result[key] === 'number') result[key] += metrics[key+'Inset'];
  return result;
}

export function kotlinModifierProps(props, binding) {
  const metrics = modifierMetrics(props,binding), result = {...props};
  for (const key of ['width','height']) if (typeof result[key] === 'number') {
    result[key] -= metrics[key+'Inset'];
    if (result[key] < 0) throw Error(`${key==='width'?'Ширина':'Высота'} меньше внешних отступов. Уменьшите отступы или увеличьте размер.`);
  }
  return result;
}
