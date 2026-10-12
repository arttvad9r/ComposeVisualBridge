# Настоящий UI, изолированные экраны и визуальные правки: исследование

Проверено 11 октября 2026. Цель — найти основу для запуска оригинального Compose UI без ручной реконструкции в HTML и для связи выбранного элемента с исходниками. Исследованы 15 решений: 12 открытых репозиториев, инструменты Android Studio, официальный screenshot-инструмент и HotSwan. Это список релевантных решений, а не полный каталог всех существующих продуктов.

## Главный результат

**Compose Buddy — ближайший кандидат для нативного слоя; Composer — источник подходов к разбору и безопасной записи Kotlin; Pose и ComposablePreviewScanner — кандидаты для автоматизации подключения экранов.** Paparazzi и Roborazzi закрывают отображение и сравнение UI без постоянного запуска эмулятора.

Composer и Compose Buddy решают разные задачи. Composer разбирает поддерживаемый Kotlin в свою модель и отображает её средствами Compose. Это лучше HTML-реконструкции, но не исполнение произвольного исходного экрана. Buddy вызывает оригинальные Preview и получает кадр из настоящего runtime либо host-renderer. Поэтому наличие слова Compose в редакторе ещё не означает точное отображение приложения.

Изолированный запуск экрана также не равен извлечению одного файла без зависимостей. Нужны тема, ресурсы, библиотеки и воспроизводимое состояние. Вариант buddyDebug собирает APK целевого проекта и открывает отдельную Preview Activity; он не обещает автоматически уменьшить APK до одного UI-модуля.

## Как проверялось

Прочитаны первичные README и LICENSE, метаданные репозиториев и выбранные исходники Composer, Buddy и Pose. Версии и хеши прочитанных файлов сохранены в [снимке источников](ui-isolation-sources-2026-10-11.json). Конкретные механизмы ниже отделены от заявлений авторов. Сторонние приложения не устанавливались, их код не запускался и не включался в продукт. Совместимость с Mealio, нашим Node-сервером и браузером пока не проверена.

## Список решений

| Решение | Возможности | Как устроено | Что использовать у нас | Лицензия / граница |
|---|---|---|---|---|
| [Composer](https://github.com/cinkhangin/composer) | Визуальное редактирование, дерево, размеры, направляющие, Undo/Redo, палитра Material 3, темы, импорт Kotlin/JSON, синхронизация с Kotlin и IDE | Общая Kotlin-модель, ограниченный детерминированный parser, собственный Compose renderer, codegen; Android Studio ComposePanel и Kotlin/Wasm | Сохранение неподдерживаемого кода, обработка экземпляров компонентов, план обратной записи | Apache-2.0; активная разработка, ограниченный синтаксис |
| [Compose Buddy](https://github.com/mikepenz/compose-buddy) | Preview на устройстве и без IDE, PNG и иерархия, inspector, настройки сцены, MCP, проверки доступности | Gradle/KSP, отдельная Activity, WebSocket; Layoutlib/Paparazzi или Desktop Skia; semantics и slot table | Протокол кадра и дерева, discovery, native backend и экспорт source-контекста | Apache-2.0; экспериментальный, обнаружены ограничения команд |
| [Pose](https://github.com/AkshayChordiya/Pose) | Автоматическое создание Preview, тестовые значения, состояния sealed-типа, sample providers, матрицы Preview, диагностика отказов, IDE-навигация | KSP анализирует сигнатуры и генерирует Kotlin в build/generated | Создание адаптеров для подходящих UI-функций, явный список неподдерживаемых экранов | Apache-2.0; не анализирует тело функции и не изолирует бизнес-логику |
| [ComposablePreviewScanner](https://github.com/sergio-sastre/ComposablePreviewScanner) | Обнаружение Preview, multipreview и параметров, private Preview, фильтры и настройки устройства, разные source sets и платформы | Поиск доступных Preview в подготовленном проекте; выдача описаний и вызываемых Preview | Каталог экранов/сцен и адаптеры к screenshot-backend | MIT; не renderer и не редактор |
| [Showkase](https://github.com/airbnb/Showkase) | Каталог компонентов, цветов и типографики, поиск, группы, варианты dark/RTL/font scale, интеграция screenshot-тестов | Annotation processor KAPT/KSP и генерируемый Android-каталог | Каталог сцен, токенов и вариантов вместо ручного списка экранов | Apache-2.0; обычно нужны Preview или Showkase-аннотации и доступные параметры |
| [Paparazzi](https://github.com/cashapp/paparazzi) | Android Views/Compose снимки без устройства, эталоны, record/verify, HTML-отчёты | JVM-тесты с Android Layoutlib, ресурсами и настройкой устройства | Настоящие кадры исходного UI без постоянного AVD, проверка визуальных изменений | Apache-2.0; не интерактивный редактор и не идентичная устройству среда |
| [Roborazzi](https://github.com/takahirom/roborazzi) | Снимки, сравнение эталонов, record/compare/verify, интеграция Preview, UI dump, запись изменений во времени | Robolectric Native Graphics для Android; дополнительные интеграции и Compose Desktop | Визуальная регрессия сцен с состоянием и Android-зависимостями | Apache-2.0; совместимость и различия rendering проверяются на проекте |
| [Android Studio: Preview, Inspector, Live Edit](https://developer.android.com/develop/ui/compose/tooling/previews) | Изолированный Preview, интерактивность, конфигурации; дерево, атрибуты и переход к source; ограниченное обновление кода на устройстве | Layoutlib для Preview, runtime inspection для приложения, IDE/компилятор для Live Edit | Образец UX и source mapping; изучить отдельные AndroidX tooling-модули | Инструменты не являются готовым встраиваемым браузерным SDK |
| [Compose Preview Screenshot Testing](https://developer.android.com/studio/preview/compose-screenshot-testing) | Обнаружение Preview, генерация эталонов, проверка снимков и отчёты | Официальная Gradle-интеграция, host-side Layoutlib | Стандартный способ проверить каталог Preview без собственного screenshot-runner | Проверять совместимость конкретных AGP/tool-версий; не live editor |
| [JetBrains Compose Hot Reload](https://github.com/JetBrains/compose-hot-reload) | Обновление работающего Compose UI после изменения кода, Gradle/IDE/CLI, сохранение части состояния | JetBrains Runtime, JVM class redefinition и Compose invalidation | Быстрый цикл для будущего Desktop/CMP backend; идеи управления обновлением | Apache-2.0; не готовый Android hot-reload backend |
| [Compose HotSwan](https://hotswan.dev/) | Android/CMP hot reload, Preview runner, snapshots, сравнение/возврат кода, MCP и управление сценой | По документации: Kotlin/D8, доставка изменённого кода в runtime, interpreter и recomposition | Сравнение пользовательского сценария и требований к быстрому циклу | Проприетарная EULA; запрещено использование для конкурирующего продукта |
| [ComposeFlow](https://github.com/ComposeFlow/ComposeFlow) | Визуальный builder, компоненты и modifiers, темы, состояние, AI, Firebase, экспорт CMP-проекта | Сериализуемая модель компонентов/параметров и генерация Kotlin | Единое описание свойств для validator/inspector/renderer; визуальные токены | LICENSE изменён относительно Apache-2.0, GitHub NOASSERTION; код не выбран для переноса |
| [Design Mode](https://github.com/SandeepBaskaran/design-mode) | Визуальные правки живой веб-страницы, текст/стили/структура, передача агенту, разные поверхности редактора | Browser extension, DOM/CSS и MCP с вариантами подключения | Снимок пользовательского намерения и сценарий передачи агенту | MIT; веб-DOM, а не Android Compose |
| [moldui](https://github.com/Manavarya09/moldui) | Resize, reorder/swap, типографика/цвета/отступы, направляющие, пакет правок и обновление страницы после записи кода | Локальный proxy внедряет JS overlay; агент редактирует source, dev server обновляет страницу | Разделение overlay, пакета правок и code update; отдельные JS-механизмы | MIT; не переносит Compose в браузер |
| [React Grab](https://github.com/aidenybai/react-grab) | Выбор элемента, component stack и source locations для агента; primitives для собственного интерфейса | DOM selection и React source-контекст | Контракт «выбранный экземпляр → source + контекст», выбор неоднозначных элементов | MIT; React-механизм нельзя напрямую применить к Compose |

## Composer: что именно стоит изучить

У автора есть Android Studio plugin и отдельный Kotlin/Wasm-редактор. Поддерживаются top-level Composable, часть layout/Material/modifier-конструкций, theme tokens, межфайловые вызовы и параметризованный текст. Есть синхронизация выбора с Kotlin, обновление после изменения файла, undoable IDE-запись и создание Composable. Полное моделирование ViewModel, состояний и навигации ещё не завершено. [README](https://github.com/cinkhangin/composer).

Три проверенных механизма:

- [Renderer.kt](https://github.com/cinkhangin/composer/blob/1b228e51129cffb1e0a671d03cd191b4b3a81a12/app/src/commonMain/kotlin/render/Renderer.kt) отображает узлы модели через реальные Compose Text/Button/контейнеры. RawCode не рисуется. Поэтому этот renderer не гарантирует точность произвольного исходного UI и не исполняет исходные callbacks.
- [DesignParser.kt](https://github.com/cinkhangin/composer/blob/1b228e51129cffb1e0a671d03cd191b4b3a81a12/codeparse/src/commonMain/kotlin/composer/codeparse/DesignParser.kt) и [ModuleDesignParser.kt](https://github.com/cinkhangin/composer/blob/1b228e51129cffb1e0a671d03cd191b4b3a81a12/codeparse/src/commonMain/kotlin/composer/codeparse/ModuleDesignParser.kt) дают основу детерминированной подготовки дерева вместо догадок агента, но в пределах поддерживаемого синтаксиса.
- [WriteBackPlanner.kt](https://github.com/cinkhangin/composer/blob/1b228e51129cffb1e0a671d03cd191b4b3a81a12/codeparse/src/commonMain/kotlin/composer/codeparse/WriteBackPlanner.kt) пропускает неизменённые функции, для изменённой функции регенерирует декларацию, добавляет imports без удаления и сортировки. Это не точечный AST-патч каждого свойства. Переименование не исправляет все внешние call sites автоматически.

Полезная идея — неизвестный код сохраняется и помечается как неподдерживаемый. Для нас такую запись следует дополнить проверкой исходной ревизии и блокировкой неоднозначных source-ссылок. Перенос Kotlin-модулей в Node.js не будет прямым: понадобится отдельный Kotlin-процесс либо реализация собственного ограниченного parser.

## Compose Buddy: наиболее близкая основа native backend

CLI умеет list/render/inspect/analyze/device/serve. Есть нативные Preview, Desktop inspector с деревом и свойствами, экспорт типографики/semantics, multi-preview и PreviewParameter, проверки contrast/touch targets/content description. Backend выбирается между Android Layoutlib/Paparazzi и Desktop ImageComposeScene. MCP даёт list_previews, render_preview, inspect_hierarchy и analyze_accessibility. [README](https://github.com/mikepenz/compose-buddy).

Проверенные точки интеграции:

- [BuddyPreviewProcessor.kt](https://github.com/mikepenz/compose-buddy/blob/d0be3047104a8710f4a8c717fdfebd996f107682/compose-buddy-device-ksp/src/jvmMain/kotlin/dev/mikepenz/composebuddy/ksp/BuddyPreviewProcessor.kt) запускает генерацию registry и wrappers через KSP. Это кандидат для discovery и вызова реальных функций.
- [BuddyDeviceConfigurator.kt](https://github.com/mikepenz/compose-buddy/blob/d0be3047104a8710f4a8c717fdfebd996f107682/compose-buddy-gradle-plugin/src/main/kotlin/dev/mikepenz/composebuddy/gradle/device/BuddyDeviceConfigurator.kt) создаёт buddyDebug из debug и подключает исходники/ресурсы debug. Это отдельный режим целевого Android-проекта, а не независимый от проекта HTML-макет.
- [BuddyPreviewActivity.kt](https://github.com/mikepenz/compose-buddy/blob/d0be3047104a8710f4a8c717fdfebd996f107682/compose-buddy-device/src/main/kotlin/dev/mikepenz/composebuddy/device/BuddyPreviewActivity.kt) запускает выбранный Preview, захватывает кадр, semantics и дополнительную информацию.
- [SemanticsCapture.kt](https://github.com/mikepenz/compose-buddy/blob/d0be3047104a8710f4a8c717fdfebd996f107682/compose-buddy-device/src/main/kotlin/dev/mikepenz/composebuddy/device/capture/SemanticsCapture.kt) читает semantics и GetTextLayoutResult. [SlotTableCapture.kt](https://github.com/mikepenz/compose-buddy/blob/d0be3047104a8710f4a8c717fdfebd996f107682/compose-buddy-device/src/main/kotlin/dev/mikepenz/composebuddy/device/capture/SlotTableCapture.kt) дополнительно получает source/параметры через tooling и reflection. Ошибки reflection могут вернуть пустые данные: source mapping нельзя считать гарантированным для каждого узла.

По README команды устройства: Navigate, RequestPreviewList, SetConfig, Tap и Rerender; кадр содержит PNG, semantics, slot table, timing и density. Это удобная граница для адаптера к нашему браузерному UI, но Kotlin-client не становится браузерным клиентом автоматически.

**Найденные ограничения реализации:** в handleCommand Activity команда Tap отправляет только ACTION_DOWN, без ACTION_UP; обычный завершённый клик этим не гарантирован. Rerender вызывает captureAndBroadcast, а не компиляцию или замену исходного кода. Наличие этих команд не подтверждает полноценный live-edit цикл. Перед использованием нужны проверка на нашей версии Compose, исправление tap и проверка отсутствующих source/атрибутов.

Apache-2.0 позволяет рассматривать адаптацию модулей с сохранением обязательных уведомлений. Предпочтителен сначала тонкий адаптер к протоколу, а не перенос всего Desktop inspector или форк всего проекта.

## Автоматическая подготовка экранов и состояний

**Pose** генерирует Preview из сигнатуры Composable: синтезирует подходящие значения, поддерживает пользовательские samples/PreviewParameterProvider, sealed-варианты и multi-preview. Результат живёт в build/generated, исходники не переписываются. Есть bulk opt-in для модуля. Но параметры ViewModel/Hilt/NavController/Context и другие runtime-типы отвергаются; вызов hiltViewModel внутри тела функция может скрывать от анализа. Такие экраны требуют Content(state, onEvent) или ручного адаптера. Синтетическое состояние не равно состоянию пользовательского приложения. [README и ограничения](https://github.com/AkshayChordiya/Pose).

**ComposablePreviewScanner** следует использовать для поиска уже существующих сцен: Preview, пользовательские multipreview, параметры и private-функции, фильтры по пакетам и source sets. Он поставляет описание сцены, а renderer выбирается отдельно. Для открытого проекта с хорошими Preview это более простой первый путь, чем генерация новых wrappers. [README/API](https://github.com/sergio-sastre/ComposablePreviewScanner).

**Showkase** решает каталогизацию: группирует компоненты, цвета и типографику, даёт поиск и варианты окружения. Это полезная модель будущего списка экранов и дизайн-токенов. Каталог не обнаруживает автоматически все состояния навигации и не снимает ограничения параметров. [README](https://github.com/airbnb/Showkase).

Для нас сцена должна иметь явное происхождение: существующий Preview, предоставленные проектом fixtures или автоматически сгенерированный пример. Сгенерированный пример нельзя без сверки подписывать как точное пользовательское состояние Mealio.

## Отображение без полного запуска приложения

**Paparazzi** отображает исходные Android UI-компоненты в JVM без устройства/эмулятора, поддерживает Compose snapshots, запись эталонов, проверку и HTML-отчёт. Подходит как backend подготовки кадра и regression-check. Ему всё равно нужны сборка UI, ресурсы и classpath проекта. [README](https://github.com/cashapp/paparazzi).

**Roborazzi** использует Robolectric Native Graphics и screenshot-задачи record/compare/verify. В экосистеме есть Preview-scanner, UI dump и запись последовательностей кадров; Desktop имеет отдельную интеграцию. Это кандидат для более сложных Android-сцен с тестовым состоянием. Он не делает из runtime-зависимого экрана чистую UI-функцию автоматически. [README](https://github.com/takahirom/roborazzi).

**Официальный Compose Preview Screenshot Testing** связывает Preview с Gradle screenshot-проверками и host-side Layoutlib. Его стоит предпочесть самописному runner, если версия AGP и используемые Preview совместимы. [Документация инструмента](https://developer.android.com/studio/preview/compose-screenshot-testing), [сравнение rendering-подходов](https://developer.android.com/training/testing/ui-tests/screenshot).

Host-side изображение следует проверить против устройства на первом реальном экране. Layoutlib/Robolectric устраняют необходимость постоянного AVD, но не дают обещания полного совпадения всех платформенных эффектов. Наш текущий HTML renderer пригоден для прежних эскизных сессий; он не должен подменять эталон native backend.

## Инспекция и быстрые обновления

**Android Studio** уже показывает Preview отдельно, умеет интерактивные сцены и несколько конфигураций. Layout Inspector показывает Compose-дерево и атрибуты, связывает выбор с кодом. Live Edit обновляет поддерживаемые изменения тела функций на устройстве; изменение сигнатур и ряд структурных изменений требуют другого цикла. Эти функции не являются одним публичным browser SDK. Для нашей интеграции нужно отдельно изучать AndroidX ui-tooling/ui-inspection и их совместимость. [Preview](https://developer.android.com/develop/ui/compose/tooling/previews), [Compose inspection](https://developer.android.com/develop/ui/compose/tooling/debug), [Live Edit](https://developer.android.com/develop/ui/compose/tooling/iterative-development).

**JetBrains Compose Hot Reload** решает быстрый JVM/Desktop-цикл через JetBrains Runtime, обновление классов и Compose. Он полезен для будущего CMP Desktop backend, но Android-only проект нельзя подключить к нему как к готовому Android runtime. [README](https://github.com/JetBrains/compose-hot-reload).

**HotSwan** по публичной документации совмещает Android hot reload, изолированный Preview runner, историю снимков и кодовых изменений, MCP и операции над semantics. Описан pipeline incremental Kotlin/D8 → runtime interpreter → targeted recomposition с fallback на reset/restart. Эти характеристики не проверялись запуском. Код и Maven-артефакты закрыты; EULA запрещает модификацию/redistribution и применение для конкурирующего продукта, поэтому HotSwan не выбран как backend нашей разработки. [Preview runner](https://hotswan.dev/docs/preview), [механизм](https://hotswan.dev/docs/how-it-works), [MCP/изменения продукта](https://hotswan.dev/docs/releases), [EULA](https://hotswan.dev/license).

## Веб-редакторы и связь с агентом

**Design Mode** показывает удобный цикл: пользователь меняет настоящую веб-страницу, затем агент получает конкретное намерение. **moldui** внедряет overlay локальным proxy, собирает пакет визуальных правок, агент меняет исходники, dev server обновляет страницу. **React Grab** формирует source-контекст выбранного экземпляра вместо передачи одного скриншота. Эти проекты полезны для нашего протокола, выбора элементов, overlay и inspector; их DOM/React-механизмы не извлекают Compose UI. [Design Mode](https://github.com/SandeepBaskaran/design-mode), [moldui](https://github.com/Manavarya09/moldui), [React Grab](https://github.com/aidenybai/react-grab).

**ComposeFlow** полезен как пример единой модели компонентов, modifier и свойств, которая обслуживает inspector, rendering и codegen. Его основной сценарий — создание/экспорт проекта, а не безопасное редактирование произвольного существующего Kotlin. Заимствовать идею registry разумнее, чем весь генератор. [README](https://github.com/ComposeFlow/ComposeFlow), [TextTrait](https://github.com/ComposeFlow/ComposeFlow/blob/3347013354285e6103a9a693aff5f77b74e37912/core/model/src/commonMain/kotlin/io/composeflow/model/parameter/TextTrait.kt), [CodeGenerator](https://github.com/ComposeFlow/ComposeFlow/blob/3347013354285e6103a9a693aff5f77b74e37912/core/model/src/commonMain/kotlin/io/composeflow/model/CodeGenerator.kt).

## Что можно брать кодом

| Приоритет | Кандидат | Способ использования | Что проверить перед включением |
|---|---|---|---|
| 1 | Buddy device/Gradle/KSP/protocol | Отдельный Kotlin native backend и адаптер кадра/дерева к нашему серверу | Версии Compose/AGP, вызов Preview, tap, source mapping, отсутствующие атрибуты |
| 2 | ComposablePreviewScanner | Зависимость в backend для каталога существующих сцен | Multipreview, параметры и наши source sets |
| 3 | Paparazzi либо официальный screenshot tool | Host renderer для кадра и baseline | Ресурсы/шрифты/тема, совпадение с устройством, время повторного отображения |
| 4 | Pose | Генерация Preview и wrappers для чистых Content-функций | Отказы, fixtures, бизнес-зависимости внутри тела, маркировка синтетических сцен |
| 5 | Composer codeparse/writeback | Kotlin-модуль или ограниченная собственная реализация по изученному подходу | Поддерживаемый синтаксис, RawCode, функции-обёртки, sourceRevision и сохранность пользовательского кода |
| 6 | Roborazzi / Showkase | Регрессия сложных сцен / каталог компонентов | Реальная потребность: не подключать все альтернативы одновременно |
| 7 | MIT веб-инструменты | Отдельные JS-компоненты или архитектурные идеи | DOM-зависимости, окружение браузера, сохранение лицензий |

Для Apache-2.0 и MIT сохраняются соответствующие LICENSE/copyright/NOTICE; зависимости проверяются при выборе конкретного модуля. Публичность GitHub сама по себе не даёт разрешения копировать код.

Особый случай ComposeFlow: заголовок LICENSE говорит Apache 2.0, но сравнение нормализованного текста с [канонической лицензией](https://www.apache.org/licenses/LICENSE-2.0.txt) выявило изменённые определения и grant, а GitHub сообщает NOASSERTION. Поэтому стандартная Apache-2.0 для этого репозитория не подтверждена; готовый код из него пока не выбран. Для остальных перечисленных open-source кандидатов прочитан LICENSE, совпадающий по типу с таблицей; отдельная проверка полного dependency-tree ещё не проводилась.

## Рекомендуемый следующий эксперимент

Это предложение по итогам исследования, не утверждённая смена архитектуры и не уже реализованные функции.

1. В отдельной копии Mealio открыть существующий SettingsScreen Preview через Buddy. Если подходящего Preview нет, подготовить явный тестовый wrapper; не выдавать сгенерированные значения за настоящее состояние аккаунта.
2. Получить один настоящий кадр, дерево, dp/density/fontScale и source-контекст. Проверить их на разных экземплярах одинакового компонента и на элементах без semantics.
3. Показать кадр в нашем браузерном UI с выбором через bounds. Сохранить произвольные неизвестные узлы видимыми; редактирование без надёжной source-ссылки ограничить пояснением/аннотацией.
4. По разрешению на перенос изменить одно поддерживаемое свойство в исходном Compose, пересобрать/обновить Preview и показать настоящий результат. Rerender кадра не считать обновлением кода.
5. Сравнить такой цикл с host-side Paparazzi/официальным runner: точность, зависимость от AVD, диагностика и стоимость подключения. Выбрать один основной backend по результатам.

Первый критерий успеха — оригинальный экран без HTML-реконструкции, надёжный выбор конкретного экземпляра и проверенный переход к source. Свободное перемещение и мгновенное изменение любых свойств в native runtime — отдельная задача; ни один найденный проект не подтвердил готовое универсальное решение для произвольного Android-приложения.
