# Модель данных и API

Источником точных допустимых значений служит `public/model.mjs`. Протокол v1 используется и браузером, и агентом.

## Документ

```json
{
  "schemaVersion": 1,
  "name": "Настройки",
  "sourceRevision": "commit-and-source-snapshot",
  "state": {"theme": "light"},
  "viewport": {"width": 412, "height": 915},
  "root": {
    "id": "screen",
    "type": "Column",
    "props": {"width": "fill", "gap": 12},
    "children": [{
      "id": "title",
      "type": "Text",
      "props": {"text": "Настройки", "width": "fill", "textAlign": "center"},
      "source": {"file": "SettingsScreen.kt", "symbol": "SettingsScreen", "instance": "title"}
    }]
  }
}
```

Это пример структуры, а не проверенная ссылка на исходник. ID уникален в дереве. source описывает файл, символ, экземпляр; line и note необязательны. Числа размеров — dp, размер шрифта — sp. viewport: ширина 200–1500, высота 200–2000. Максимум 500 узлов и 30 уровней. Дополнительные метаданные документа допускаются, но неизвестные props отклоняются.

Типы: Column, Row, Box, Card, Text, Button, TextField, Switch, Icon, Image, Spacer. Только первые четыре содержат детей.

| Свойства | Значения |
|---|---|
| width, height | число 0–4000, auto, fill; отсутствие — по умолчанию |
| padding, paddingHorizontal, paddingVertical, gap | число 0–300 |
| align | start, center, end, stretch; положение листа или выравнивание детей контейнера |
| justify | start, center, end, space-between; распределение детей |
| textAlign | start, center, end, justify; строки внутри текстового блока |
| fontSize / lineHeight / fontWeight | 6–100 / 6–150 / 100–900 |
| fontStyle / textDecoration | normal, italic / none, underline |
| color, background, borderColor | HEX #RRGGBB |
| borderWidth / radius / weight / opacity | 0–10 / 0–200 / 0–100 / 0–1 |
| text, placeholder, src | строки до 5000 символов; непустой src только https |
| checked, scrollable | boolean |

Ограничения валидатора не равны точному поведению Compose. Цвет/шрифт наследуются в веб-превью; сохранение темы и реальных модификаторов — задача агента.

## HTTP

| Метод | Путь | Поведение |
|---|---|---|
| GET | /api/session | revision, baseline, current, applied |
| PUT | /api/session | Заменить baseline и current, очистить applied |
| PUT | /api/draft | Сохранить только current |
| POST | /api/apply | Сохранить current и отдельный снимок передачи |
| GET | /api/changes | Diff текущего черновика, draft:true |
| GET | /api/applied | Последний переданный diff; 404 до Apply |

Тело записи: `{"revision": актуальное_число, "document": документ}`; Content-Type: application/json. Успешная запись возвращает новую сессию и увеличивает revision на 1. PUT session заменяет baseline, поэтому не использовать его как сохранение черновика.

Коды: 400 — неверные данные; 403 — Host/Origin; 409 — устаревшая revision; 413 — больше 2 MB; 415 — неверный Content-Type. Проверка revision выполняется до записи. При 409 экспортируйте локальную работу, затем загрузите серверную версию; автоматического слияния нет.

## Снимок передачи

`data/session.json` хранит applied.directory. В этом каталоге находятся baseline.json, proposed.json и changes.json. GET applied возвращает changes.json, но для полного дерева агент также читает proposed.json из файловой системы.

Изменения: property — свойство, type — тип, children — окончательный порядок, reparent — родитель, add/remove — узел, document — name/viewport/state. Каждое изменение узла содержит ID и source, если ссылка имеется. Сам diff не является исполняемым патчем.

Последний applied может быть старее current. Обычное сохранение черновика не обновляет applied. Импорт очищает указатель, но не удаляет каталоги старых снимков. sourceRevision берётся из baseline и должен отражать прочитанные исходники, включая незакоммиченные изменения.

Для переноса прочитайте AGENT.md и поручение пользователя. Тестовые снимки не применяются к коду. Новый baseline создаётся после проверки разрешённого переноса.

## Передача v0.2 и совместимость

Схема макета остаётся `schemaVersion: 1`. POST `/api/apply` принимает необязательное поле `mode`: `test` (по умолчанию) или `review`. Остальные значения отклоняются. Режим записывается в `applied.mode` и `changes.handoff.mode`, а не в props или дерево документа. Ревизии и sourceRevision сохраняют прежний смысл.

`report.md` содержит читаемое описание, режим, ревизию снимка, значения до/после и source. GET `/api/handoff` возвращает `{applied, document, report}` последнего снимка. UI сравнивает полное дерево снимка с current, не только номера ревизий. Обычный draft сохраняет прежние applied и report.

Старые сессии загружаются без миграции. Если режима нет, UI показывает «режим не указан», а отчёт консервативно считает снимок тестовым. GET handoff формирует отчёт из JSON, поэтому работает и со старым снимком без report.md. `review` означает подготовку к согласованию; сам файл не является поручением изменить код.
