const round = value => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function shiftedOffsets(props, dx, dy) {
  return {offsetX:round(clamp((props.offsetX || 0)+dx,-4000,4000)), offsetY:round(clamp((props.offsetY || 0)+dy,-4000,4000))};
}
// Compensate direct children only: descendants inherit the corrected origin.
// Always derive from the gesture's original frames to avoid cumulative drift.
export function anchoredChildFrames(frames, parentId, dx, dy) {
  return Object.fromEntries(Object.entries(frames).map(([id, frame]) => [id,
    frame.parent === parentId ? {...frame, x:Math.round((frame.x-dx)*1000)/1000, y:Math.round((frame.y-dy)*1000)/1000} : {...frame}
  ]));
}
export function resizeRect(rect, direction, dx, dy) {
  const horizontal=direction.includes('e')||direction.includes('w'), vertical=direction.includes('n')||direction.includes('s');
  const width=horizontal?round(clamp(rect.width+(direction.includes('w')?-dx:dx),8,4000)):rect.width;
  const height=vertical?round(clamp(rect.height+(direction.includes('n')?-dy:dy),8,4000)):rect.height;
  return {left:rect.left+(direction.includes('w')?rect.width-width:0),top:rect.top+(direction.includes('n')?rect.height-height:0),width,height};
}
