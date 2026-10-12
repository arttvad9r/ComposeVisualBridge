# Плагин в Claude Code — 12 октября 2026

Версия 0.9.1, Claude Code 2.1.285, Linux. Пользовательский профиль Claude, пользовательские сессии Bridge и Android-проекты не изменялись.

## Пакет

- В `plugin/.claude-plugin/plugin.json` добавлен манифест Claude Code. `package-plugin` подставляет версию из package.json и создаёт `dist/.claude-plugin/marketplace.json`; оба файла входят в архив.
- Skills не менялись: корень плагина вычисляется от SKILL.md, поэтому одни и те же инструкции работают в Codex и Claude.
- `claude plugin validate --strict` для пакета и marketplace проходит.

## Установка

В изолированном `CLAUDE_CONFIG_DIR`:

```sh
claude plugin marketplace add ./dist
claude plugin install compose-visual-bridge@compose-visual-bridge-local
```

`plugin list` показывает 0.9.1 enabled, `plugin details` находит skills `compose-visual-bridge` и `setup` (постоянная стоимость ~86 токенов).

## Сценарий из установленной копии

Сессия Claude Code (Opus 5.5) выполняла команды skill по пути из cache установки, с отдельным BRIDGE_HOME:

1. `setup` — `ready=true`, редактор готов; Android toolchain не готов (найден JDK 17, нужен 21) и назван в ответе.
2. `create --project <пустой каталог> --input examples/server-screen.json`, затем `read` — отказ «Переданного снимка нет».
3. `open` — URL на 127.0.0.1; во встроенном браузере Claude изменён текст «Настройки» → «Параметры», нажато «Передать агенту».
4. `read` — снимок `test`, одно изменение text, report запрещает перенос (исходник не подтверждён).
5. `stop` → `list` (сессия latest) → `open` на новом порту → `read` возвращает тот же снимок → `stop`.

## Не проверено

- Отдельный headless-ход модели (`claude -p --plugin-dir`): локальный CLI не авторизован.
- Установка в основной профиль пользователя.
- Native-, live- и compose-режимы в Claude: они требуют JDK 21 и эмулятора.

## Наблюдения

- При ширине панели около 440 px у редактора появляется горизонтальная прокрутка страницы.
- Повторная передача неизменённого черновика теперь сообщает об этом отдельно («Снимок сохранён повторно…»); блокировать её нельзя, потому что после подтверждения исходника тот же черновик передаётся как review.
