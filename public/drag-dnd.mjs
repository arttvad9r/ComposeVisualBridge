import { DragDropManager, Draggable, PointerSensor, PointerActivationConstraints, Cursor, PreventSelection } from '@dnd-kit/dom';

// The library owns sensor activation/cancellation; the model owns the tree.
export function createDrag({ start, update, finish }) {
  const manager = new DragDropManager({
    sensors: [PointerSensor.configure({
      activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
      preventActivation: event => Boolean(event.target.closest('.resize-handle')),
    })],
    plugins: [Cursor, PreventSelection],
  });
  const entries = new Map();
  let active, latestPointer;
  const origins = new WeakMap();
  const trackPointer = event => { if (event.isPrimary) latestPointer = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey}; };
  document.addEventListener('pointermove',trackPointer,true);
  document.addEventListener('pointerup',trackPointer,true);
  const position = event => latestPointer || ({ clientX: event.nativeEvent?.clientX ?? event.to?.x ?? event.operation.position.current.x, clientY: event.nativeEvent?.clientY ?? event.to?.y ?? event.operation.position.current.y, shiftKey: event.nativeEvent?.shiftKey || false });
  manager.monitor.addEventListener('dragstart', event => { active = event.operation.source.data.nodeId; const initial = event.operation.activatorEvent; start(active, origins.get(event.operation.source.element) || {clientX:initial?.clientX ?? event.operation.position.initial.x,clientY:initial?.clientY ?? event.operation.position.initial.y}, event.operation.source.element); update(active, position(event)); });
  manager.monitor.addEventListener('dragmove', event => update(active, position(event)));
  manager.monitor.addEventListener('dragend', event => {
    const id = active; active = null;
    // Rerender only after the sensor has completed cleanup of its original DOM.
    const point = position(event);
    queueMicrotask(() => { if (!event.canceled) update(id, point); finish(id, point, event.canceled); });
  });
  return {
    wire(element, nodeId) {
      element.draggable = false;
      const captureOrigin = event => { if(event.isPrimary && event.button === 0) {origins.set(element,{clientX:event.clientX,clientY:event.clientY});trackPointer(event);} };
      element.addEventListener('pointerdown',captureOrigin,true);
      const draggable = new Draggable({ id: `${element.classList.contains('tree-node') ? 'tree' : 'preview'}:${nodeId}`, element, data: { nodeId } }, manager);
      entries.set(element, () => {element.removeEventListener('pointerdown',captureOrigin,true);draggable.destroy();});
    },
    clear(root) { for (const [element, cleanup] of entries) if (root.contains(element)) { cleanup(); entries.delete(element); } },
    destroy() { for (const cleanup of entries.values()) cleanup(); entries.clear(); manager.destroy(); document.removeEventListener('pointermove',trackPointer,true);document.removeEventListener('pointerup',trackPointer,true); },
  };
}
