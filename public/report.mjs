const labels = {property:'Свойство',children:'Порядок детей',reparent:'Перенос в контейнер',add:'Добавлен элемент',remove:'Удалён элемент',type:'Тип компонента',document:'Параметр макета'};
const values = value => value == null ? 'по умолчанию' : typeof value === 'object' ? JSON.stringify(value) : String(value);
// JSON quoted values prevent user text from becoming Markdown headings/instructions.
const quote = value => JSON.stringify(values(value)).replaceAll('<','&lt;').replaceAll('>','&gt;');
export function createReport(changes, handoff = {}) {
  const test = handoff.mode !== 'review';
  const intention=changes.intent?.changes || changes.changes;
  const lines = ['# Визуальные правки для агента','',`Макет: ${quote(changes.name)}`,`Снимок: ${quote(handoff.directory || 'черновик')}`,`Ревизия снимка: ${changes.revision ?? 'не передан'}`,`Исходники: ${quote(changes.sourceRevision)}`,`Размер экрана: ${changes.viewport.width} × ${changes.viewport.height} dp`,'',test ? '**Тестовый снимок. Не переносить в код.**' : '**Снимок для согласования. Для переноса требуется поручение пользователя.**','', 'Кнопка сохраняет файлы локально и не запускает агента. Читайте baseline.json и proposed.json вместе с changes.json. Сверьте исходники; сохраните логику и проверьте результат в Android.','', changes.layoutMode === 'auto' ? 'Автоматическая компоновка: размеры участвуют в размещении соседей.' : 'Свободная компоновка: layout.frames фиксирует геометрию; при resize соседи и содержимое контейнера остаются на месте. Координаты прямых детей компенсируют движение границ; обычный drag переносит всю группу. Числовые width/height переопределяют размеры frames, offsetX/offsetY добавляются к координатам. Это визуальное намерение, а не команда механически сделать все элементы абсолютными.', ''];
  if (changes.verification) lines.push('## Проверка исходного макета', '', changes.verification.confirmedBy === 'render' ? `Подтверждён отрисовкой Preview: ${quote(changes.verification.confirmedAt)}` : `Подтверждён пользователем: ${quote(changes.verification.confirmedAt)}`, `Версия редактора: ${quote(changes.verification.bridgeVersion)}`, `Исходный макет SHA-256: ${quote(changes.verification.baselineFingerprint)}`, `Эталон: ${quote(changes.reference?.label)} / SHA-256 ${quote(changes.verification.referenceDigest)}`, 'Эталон сохранён в reference.json. Подтверждение относится к baseline, состоянию, viewport и sourceRevision этого снимка.', '');
  else lines.push('Исходный макет не подтверждён. Перенос в код запрещён.', '');
  lines.push('Автоматическая фиксация layout.frames — технический контекст. Переносите только intent.changes, учитывая baseline/proposed; не трактуйте все frames как пользовательские перемещения.', '');
  if (changes.transfer?.requiresAgent?.length) {
    lines.push('## Изменения, требующие работы агента', '', 'Автоматический Kotlin-адаптер не применяет этот снимок целиком. Реализуйте перечисленное по полному proposed.json, сохранив остальные намерения; не отбрасывайте неподдерживаемые правки.', '');
    for(const need of changes.transfer.requiresAgent)lines.push(`- ${quote(need.id)} / ${quote(need.property)}: ${quote(need.reason)}`);
    lines.push('');
  }
  lines.push(`## Изменения (${intention.length})`,'');
  for (const change of intention) {
    lines.push(`- ${labels[change.operation] || change.operation}: ${quote(change.id || 'экран')}${change.property ? ` / ${quote(change.property)}` : ''}`,`  Было: ${quote(change.before)}`,`  Стало: ${quote(change.after)}`);
    if (change.source?.file) lines.push(`  Связь: ${quote(change.source.file)}${change.source.symbol ? ' / '+quote(change.source.symbol) : ''}${change.source.instance ? ' / '+quote(change.source.instance) : ''}`);
    else lines.push('  Прямой ссылки на исходник нет: используйте дерево и ближайший компонент со source.');
  }
  if (!intention.length) lines.push('Изменений нет.');
  return lines.join('\n')+'\n';
}
