import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
export function createPragmatic({ start, update, finish }) {
  const entries = new Map();
  const cleanupMonitor = monitorForElements({
    onDragStart: ({ source, location }) => { start(source.data.nodeId); update(source.data.nodeId, location.current.input); },
    onDrag: ({ source, location }) => update(source.data.nodeId, location.current.input),
    onDrop: ({ source, location }) => { const canceled = !location.current.dropTargets.length; if (!canceled) update(source.data.nodeId, location.current.input); queueMicrotask(() => finish(source.data.nodeId, location.current.input, canceled)); },
  });
  return {
    wire(element, nodeId) { const clean = [dropTargetForElements({element}), draggable({element, getInitialData: () => ({nodeId})})]; entries.set(element, () => clean.forEach(fn => fn())); },
    clear(root) { for (const [element, cleanup] of entries) if (root.contains(element)) {cleanup(); entries.delete(element);} },
    destroy() { entries.forEach(fn => fn()); entries.clear(); cleanupMonitor(); },
  };
}
