# Подготовка Android-копии и обнаружение Preview — 11 октября 2026

Bridge 0.5.0 добавляет prepare-native/native-build/native-catalog. Подготовка создаёт новый Git-workspace вне исходного проекта, добавляет debug runtime/KSP/Activity и дополнительные Kotlin-сцены. BuddyPreviewRegistryImpl не пишется вручную. Каталог возвращается после успешной debug-сборки и связан с SHA-256 исходных файлов и APK. Изменение любого входного файла или APK отклоняет чтение прежнего результата.

## Проверка реального компилятора

Исходник — существующая проверочная копия `/home/artt/Projects/Mealio-bridge-check`; подготовлен новый `/tmp/cvb-ksp-mealio`. Основной Mealio, исходная проверочная копия и пользовательские редакторские сессии не менялись. Kotlin compiler и plugins обновлены только в новом workspace до 2.3.20 явным --upgrade-kotlin. AGP 8.9.2, compileSdk 36, KSP 2.3.6, Buddy device/runtime processor 0.3.0, OpenJDK 21.0.2.

Требование JDK проверено непосредственно у опубликованного [KSP JVM artifact](https://repo.maven.apache.org/maven2/dev/mikepenz/composebuddy/compose-buddy-device-ksp-jvm/0.3.0/): BuddyPreviewProcessor.class имеет major 65 (Java 21). Runtime без KSP ранее работал с JDK 17; это разные требования. Временный OpenJDK загружен из [официального архива](https://jdk.java.net/archive/) и проверен по SHA-256 издателя, системный JDK не заменялся.

Добавлены две public @Preview-функции с вызовом оригинального SettingsScreen и MealioTheme, синтетическим ServerAccount, русским языком, fontScale=1 и светлой/тёмной темой. Первичная сборка нашла обе функции, но остановилась из-за неверных импортов в тестовых сценах; успешный build-manifest не появился. Импорты исправлены только в новой копии. Затем KSP автоматически сгенерировал registry и instrumented wrappers, debug APK успешно собран. JSON каталога прочитан и через standalone CLI, и через команду плагина.

Ключи:

- `dev.composevisualbridge.scenes.BridgeSettingsPreviewsKt.BridgeSettingsLight`
- `dev.composevisualbridge.scenes.BridgeSettingsPreviewsKt.BridgeSettingsDark`

SHA исходников: `d224cc471167bb0bc022a6e7e062f19fdf11ca027f510a5208babd339637ea11`.
SHA установленного APK при native-проверке: `795c7c0ed1c2750f92e1f0f03f8f6d4671d2389d7863b47d922681f111134851`.

## Проверка на Android

Отдельный новый AVD API 36, 1216×2640/560 dpi, SwiftShader, serial emulator-5582; собственный adb forward и BRIDGE_DATA. APK установлен, Activity открыта с ключом из сгенерированного каталога. Каталог устройства точно совпал с результатом KSP. Bridge получил PNG 1216×2640, 34 узла, фактический шрифт заголовка 13.5.sp. Playwright выбрал «Подключение», проверил автозаполнение размера шрифта и переход к тёмной сцене с новым digest; pageerror не было. Подсказок file/line по-прежнему нет (0), source mapping элементов не считается реализованным.

Дополнительно в том же отдельном workspace: локальная правка файла отклонила чтение старого каталога; удаление файла сцен и новая сборка дали previews=[] с объяснением; восстановление сцен и новая сборка вернули два ключа и первоначальный SHA исходников. Build запускает KSP без incremental discovery, чтобы перерасчёт не зависел от неполных source dependencies стороннего генератора. Реальная пустая генерация и восстановление проверены, результат не выводится из regex по Android-исходникам.

## Автоматические проверки и упаковка

`npm test`: 29 passed. Добавлены проверки неперезаписи существующих каталогов, сохранения dirty-исходников, исключения ключей/.env, отказа на symlink и существующую KSP-интеграцию, запрета копии внутри исходного проекта даже через alias родительской папки, stale source/APK и JDK 17. Portable plugin test вызывает prepare-native/native-catalog из распакованного пакета.

`npm run test:browser`: 36 passed. Настоящий KSP APK дополнительно проверен Playwright. node --check затронутых модулей и git diff --check прошли. Установка 0.5.0 через штатный Codex CLI проверена в отдельном CODEX_HOME: installed/enabled, основной skill/setup обнаружены, setup.ready=true. Основной профиль не изменялся.

После проверки остановлены собственный Bridge, adb forward, отдельный эмулятор и Gradle daemon временного JDK. Workspace, AVD и временный JDK удалены. Компактные свидетельства и скриншот оставлены вне Git: `/tmp/cvb-ksp-native-evidence.json`, `/tmp/cvb-ksp-catalog-cases-evidence.json`, `/tmp/cvb-ksp-native-editor.png` до очистки временных файлов системой.

## Ограничения

Первый поддерживаемый проект — Git root с Android application-модулем, обычными Kotlin DSL plugins и явными версиями Kotlin; требуется Android toolchain. Существующая KSP/Buddy-интеграция, ручной registry, debug manifest, aliases/convention plugins, symlinks, flavors/splits и внешние Gradle-модули требуют отдельной интеграции. Копируется проект для сборки APK; автоматическая изоляция одной UI-библиотеки не реализована.

Discovery следует поведению опубликованного Buddy KSP: функции @Preview и доступные ему составные аннотации, один ключ на функцию; PreviewParameter использует первое значение provider. Private Preview, произвольные providers и другие конфигурации требуют отдельной проверки компиляции и запуска. Экран без Preview, требующий ViewModel/DI/данные, нуждается в тестовой сцене оригинального Composable. Полный автоматический каталог состояний приложения, точное source mapping и live patching остаются следующими задачами.
