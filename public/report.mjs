const labels = {property:'Свойство',children:'Порядок детей',reparent:'Перенос в контейнер',add:'Добавлен элемент',remove:'Удалён элемент',type:'Тип компонента',document:'Параметр макета'};
const values = value => value == null ? 'по умолчанию' : typeof value === 'object' ? JSON.stringify(value) : String(value);
// JSON quoted values prevent user text from becoming Markdown headings/instructions.
const quote = value => JSON.stringify(values(value)).replaceAll('<','&lt;').replaceAll('>','&gt;');
export function createReport(changes, handoff = {}) {
  const test = handoff.mode !== 'review';
  const lines = ['# Визуальные правки для агента','',`Макет: ${quote(changes.name)}`,`Снимок: ${quote(handoff.directory || 'черновик')}`,`Ревизия снимка: ${changes.revision ?? 'не передан'}`,`Исходники: ${quote(changes.sourceRevision)}`,`Размер экрана: ${changes.viewport.width} × ${changes.viewport.height} dp`,'',test ? '**Тестовый снимок. Не переносить в код.**' : '**Снимок для согласования. Для переноса требуется поручение пользователя.**','', 'Кнопка сохраняет файлы локально и не запускает агента. Читайте baseline.json и proposed.json вместе с changes.json. Сверьте исходники; сохраните логику и проверьте результат в Android.','', changes.layoutMode === 'auto' ? 'Автоматическая компоновка: размеры участвуют в размещении соседей.' : 'Свободная компоновка: layout.frames фиксирует геометрию; при resize соседи не сдвигаются. Числовые width/height переопределяют размеры frames, offsetX/offsetY добавляются к координатам. Это визуальное намерение, а не команда механически сделать все элементы абсолютными.', '',`## Изменения (${changes.changes.length})`,''];
  for (const change of changes.changes) {
    lines.push(`- ${labels[change.operation] || change.operation}: ${quote(change.id || 'экран')}${change.property ? ` / ${quote(change.property)}` : ''}`,`  Было: ${quote(change.before)}`,`  Стало: ${quote(change.after)}`);
    if (change.source?.file) lines.push(`  Связь: ${quote(change.source.file)}${change.source.symbol ? ' / '+quote(change.source.symbol) : ''}${change.source.instance ? ' / '+quote(change.source.instance) : ''}`);
    else lines.push('  Прямой ссылки на исходник нет: используйте дерево и ближайший компонент со source.');
  }
  if (!changes.changes.length) lines.push('Изменений нет.');
  return lines.join('\n')+'\n';
}
