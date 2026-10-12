const byId = id => document.getElementById(id);
let opener, config;
export const HELP = {
  'Компоновка': 'Свободная компоновка: элементы перемещаются перетаскиванием или смещением по X/Y. Изменение размера не сдвигает соседей. Выравнивание «по центру», распределение и интервал между детьми в этом режиме отключены.\n\nАвтоматическая компоновка: Row/Column рассчитывают расположение по размерам, выравниванию и интервалам. Доступны размеры по содержимому и заполнение.\n\nПереключение на автоматическую компоновку пересчитает положение элементов. Его можно отменить через Undo.',
  'Размер': '«По содержимому» — размер текста или детей. «Заполнить место» — всё доступное место. «Точный размер» — число в dp, единицах размера Android.\n\nДоля свободного места делит оставшееся место между соседями: 1 и 1 — поровну, 1 и 2 — одна треть и две трети. В Row влияет на ширину, в Column — на высоту. Пусто или 0 — не участвовать. Доступно в автоматической компоновке.',
  'Расположение': 'Смещения по X/Y перемещают элемент относительно позиции контейнера и доступны в обоих режимах. Выравнивание элемента или детей, распределение и интервал между детьми работают в автоматической компоновке. Режим переключается над макетом.',
  'Форматирование текста': 'Выравнивает строки внутри блока. Для заметного эффекта выберите ширину «Заполнить место» или задайте точный размер.',
  'Перемещение': 'На макете тяните сам элемент для свободного перемещения. Для изменения порядка или вложенности перетащите строку за ⠿ слева. Линия показывает место вставки. Центр контейнера — перенос внутрь; Shift также переносит внутрь. Без мыши: выберите родителя в списке или нажимайте «Раньше» и «Позже».',
  'Связь с кодом': 'Source связывает элемент с конкретным экземпляром компонента в исходниках. Если прямой ссылки нет, агент использует дерево и ближайший компонент со source. Ревизию исходников нужно сверить перед переносом.',
  'Редактирование макета': 'Выберите элемент в правом макете или дереве, чтобы изменить его свойства. Тяните элемент на макете для перемещения по X/Y. Ручки по краям меняют размер. В дереве слева перетаскивайте строку за ⠿ для изменения порядка или вложенности.',
  'Передача агенту': 'Передача сохраняет снимок локально и не запускает агента. Поздние правки черновика не изменяют переданный снимок. Агент получает ваши правки и сведения об исходном экране, проверяет их и переносит в код по вашему поручению.'
};
export function helpButton(title, text = HELP[title]) {
  const button = document.createElement('button'); button.className = 'help-button'; button.type = 'button';
  button.setAttribute('aria-label', `Справка: ${title}`); button.setAttribute('aria-haspopup', 'dialog');
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [['circle',{cx:12,cy:12,r:9,fill:'none',stroke:'currentColor','stroke-width':1.7}],['circle',{cx:12,cy:7.5,r:1,fill:'currentColor'}],['path',{d:'M12 11v6',fill:'none',stroke:'currentColor','stroke-width':2,'stroke-linecap':'round'}]]) {
    const part = document.createElementNS(ns, tag); for (const [key,value] of Object.entries(attrs)) part.setAttribute(key,value); svg.append(part);
  }
  button.append(svg);
  button.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) event.stopPropagation(); });
  button.onclick = event => {
    event.preventDefault(); event.stopPropagation(); opener = button;
    byId('helpTitle').textContent = title; byId('helpText').textContent = text;
    byId('helpLayoutAction').hidden = title !== 'Компоновка' || !config.isFree();
    byId('helpDialog').showModal();
  };
  return button;
}
export function sectionHelp(group, title) { group.querySelector('summary').append(helpButton(title)); }
export function setupHelp(options) {
  config = options;
  for (const [id,title] of [['layoutHelp','Компоновка'],['interactionHelp','Редактирование макета'],['handoffHelp','Передача агенту']]) byId(id).append(helpButton(title));
  byId('closeHelp').onclick = () => byId('helpDialog').close();
  byId('helpDialog').addEventListener('close', () => { if (opener?.isConnected) opener.focus({preventScroll:true}); });
  byId('helpLayoutAction').onclick = () => { config.onAuto(); byId('helpDialog').close(); };
}
