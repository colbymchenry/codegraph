# Происхождение HDL-макросов через pyslang

Для точек исходного написания и диапазонов вызовов добавлен отдельный optional
backend. Он использует SourceManager из `pyslang==11.0.0`, не ищет определения
макросов по регулярным выражениям и не исправляет неизвестные колонки догадками.

## Запуск

Понадобится отдельный Python >=3.11 с установленным pyslang 11.0.0.
В этом пакете проверен Python 3.14. CodeGraph не ставит
его автоматически и не меняет Python dependencies проекта. Пример из корня
уже инициализированного проекта с active HDL profile:

```sh
codegraph hdl-semantic data --python /absolute/path/to/venv/bin/python
```

В API:

```ts
const result = await cg.getHdlSemantics({
  pythonExecutable: '/absolute/path/to/venv/bin/python',
  query: 'top.data',
});
```

Выбрать ровно один вариант: `--python` / pythonExecutable либо прежний
`--slang` / executable. Python backend сам выполняет compilation и экспорт
фактов; результаты разных запусков compiler не склеиваются. Сохраняются
active profile, overrides, separate compilation units, limits и snapshot checks.

## Что возвращается

Имена объявлений parameter/port/typedef сохраняют прежние sourceOrigin и
macroExpansion. Макрос в initializer или типе не превращает само имя в
macro-origin: ссылка на прямое source declaration остаётся допустимой.

Дополнительно возвращаются `expressionOrigins` — уникальные compiler macro-token
origins с ролями `initializer`, `declared-initializer` и `type`. Для `type`
проверяется доступный объявленный type syntax, включая поддержанные dimensions.
Фактический initializer не смешивается с default из объявления после override.
Это прямые macro tokens соответствующего syntax, не транзитивный анализ всех
констант, от которых зависит результат.

`expressionOriginCoverage` отдельно описывает initializer, declaredInitializer
и type: `checked`, `not-applicable` или `unavailable`; initializer также может
иметь `command-line`. Пустой список при unavailable не доказывает отсутствия
макросов. `truncated=true` означает достижение лимита выдачи. На факт возвращается
не больше 32 expression origins; полнота отдельных macro frames остаётся в
macroExpansionComplete.

- `provenance.frontend = pyslang`, версия протокола/exporter и хеши Python,
  exporter и native pyslang module. Запуск идёт через Python `-I`; путь venv
  сохраняется, чтобы не выбрать site-packages другого interpreter.
- `sourceOrigin`: direct или macro. Поле source — физическая точка исходника
  либо доступная точка вызова, а не автоматически полный диапазон объявления.
- `macroExpansion`: ограниченный набор provenance frames. Для каждого доступны
  имя макроса, признак argument, точка spelling и compiler invocation range,
  когда frontend смог их сопоставить.
- Каждый point содержит project-relative file, физические line/column и
  `byteOffset`. Колонки отсчитываются с 1 в UTF-8 байтах, offset — с 0;
  это не UTF-16 колонка CodeGraph. Координаты проверяются по snapshot bytes.
- `macroExpansionComplete` явно сообщает, удалось ли сопоставить все frames.
  У collapsed/неизвестных ranges значение false. Отсутствующая часть не
  восстанавливается эвристически.

Frames — не линейный стек. SourceManager имеет разные связи original и expansion;
для nested macros нужно обходить обе. Spelling point внутри аргумента или macro
body не означает, что всё полученное имя записано там непрерывно. Особенно это
касается token concatenation: точка `bus` не является диапазоном имени `bus_data`.

У macro-origin фактов sourceNodeId не выдаётся, даже при точной spelling column:
она может указывать на аргумент вызова или definition body, а не на исходное
объявление порта. Переходы доступны через macroExpansion. Прямые факты сохраняют
проверенные source node links.

## Проверяемость и ограничения

Exporter — небольшой поставляемый Python helper; используется compiler API,
а не собственный HDL-preprocessor. Нормализованный JSON имеет отдельную версию
`codegraphSemanticVersion: 1`, проверяется до выдачи фактов. Ошибка compiler,
неизвестная версия библиотеки, повреждённый payload, source path вне snapshot,
несогласованные координаты и изменения inputs во время запуска отвергаются.

Computed include paths, files вне root и остальные ограничения snapshot runner
сохраняются. Это не OS sandbox для запуска недоверенного compiler. Нет
persistent cache, транзитивной карты зависимостей всех expressions, полного
source-map для всех constructed tokens или automatic
MCP compilation. Windows backend пока отключён; macOS runtime не проверялся.

Поведение SourceManager сверено с [официальным API](https://www.sv-lang.com/classslang_1_1_source_manager.html).
Подробные результаты пакета: `validation-hdl-macro-source-map-2026-09-12.md`.
