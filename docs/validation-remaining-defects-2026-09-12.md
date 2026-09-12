# Оставшиеся дефекты: исправления и реальная проверка — 12 сентября 2026

База работы: bc4a057d, Linux x64 / Node 24.15.0. Extraction stamp 31.
Работа разделена на C/C++, IDs/Dart и MCP lifecycle; callback и интеграция
проверялись отдельно. Новые дефекты, найденные в ходе реальных проверок,
закреплены регрессиями до окончательной проверки.

## Callback и совместимость TS/TSX (#1355)

- this.handler разрешается по лексическому owner через contains, затем по
  extends для наследуемого метода. Одноимённый метод соседнего файла или
  другого класса, в том числе на одной строке, не является кандидатом.
- Registrar/dispatcher с одноимённым полем связываются только внутри своего
  класса. Сохранена регистрация this.handler.bind(this).
- Типизированный method lookup использует семейство языка: TSX/JSX вызов
  метода TS-класса не отбрасывается из-за разных extension tags.

Реальный Excalidraw afa3a653fc5d2b742adcbd5a6063187b056d2419: неизменённые
App.tsx, Scene.ts, barrel index.ts и tsconfig.json скопированы в storage.
App::componentDidMount → Scene::onUpdate (строка3818), Scene::triggerUpdate →
единственный App::triggerRender (строка5392). Добавление отдельного
искусственного Decoy.triggerRender не меняет target. Native/WASM результаты
совпадают; SHA исходников сохранены в real-excalidraw-callback-native.json.
Это настоящий observer path на выбранных файлах, не весь браузерный runtime.

## C/C++ (#1838, #1839, #1373)

- Function-like #define представлены невызываемыми constant nodes. Numeric/
  object-like defines не добавлены: они увеличивали ADRC-граф на ~57k узлов
  без пользы для исправления вызовов.
- Макросы проверяются до name/import resolution. Учитываются порядок
  define/undef, quoted sibling headers, include-root и однозначный suffix
  fallback. Macro constant никогда не становится target обычного calls.
- Видимость вычисляется по завершённому обходу translation unit, а не по
  зависимому от порядка обхода child-cache. Cache ограничен 128 root timelines.
- Локально решаемые if/ifdef/ifndef/elif/else и defined/числовые флаги
  исключают неактивные ветки. Неизвестные build guards остаются возможными;
  факты внутри одной hypothetical ветки сохраняют корреляцию. Внешние flags,
  произвольные арифметические выражения и полный preprocessing не реализованы.
- Default/direct/brace construction дают calls к constructor method отдельно
  от instantiates. Extern, pointer/reference, prototype и aggregate controls
  не создают вызов произвольного конструктора.
- Одноаргументные объявления функций через макрос получают реальное имя
  при подтверждённой форме определения, а не угадываются по любому аргументу.

ADRC extraction native/WASM: 717 совпадений на 881 исходном файле src/main,
164 штатных parse-error deferrals в WASM, 0 diff. Это не означает, что каждый
из 881 файлов разобран native. Полная пересборка изолированной копии проверяет
отдельно ложные macro calls и 15 сохранённых настоящих вызовов, включая sin_approx.

## IDs и Dart (#1349 и прежние parity failures)

TS/JS/TSX/JSX IDs учитывают UTF-16 колонку: getter/setter одной строки сохраняют
разные строки SQLite и правильные исходящие вызовы. Формат IDs остальных
языков не менялся; это исправление подтверждённого TS/JS-сценария, не заявление
об отсутствии любых возможных коллизий в остальных языках.

Dart extension_type_declaration распознаётся контейнером в native и WASM;
getter и method имеют корректного владельца и границы тела. Четыре старых
Dart parity failures устранены без удаления их assertions.

Реальные проверки: 83 CodeGraph extraction/MCP/UI-файла — byte parity 83/83,
без deferral; dart-lang/shelf f36dd68654814e0498c30b9f7ccc4bb0aa2bc118 —
89/99 byte parity, 10 штатных deferrals, 0 diff. В shelf нет extension types:
они проверены отдельными fixtures, включая прежние LF/CRLF failures.

## MCP projectPath и cleanup (#1835, #1782)

- Explicit projectPath получает один catch-up gate, watcher и writer ownership.
  Несколько запросов разделяют первоначальную синхронизацию; no-watch сохранён.
  Новые индексы автоматически не создаются.
- Если root обслуживает другой writer, текущий engine остаётся читателем.
  После ухода владельца следующий explicit-запрос берёт ownership и запускает
  catch-up/watch. Фоновый takeover без следующего запроса не реализован.
- closeAsync прекращает watch и дожидается текущих записей. Daemon/direct/proxy
  ожидают engine.stop. Поздний запрос не открывает повторно закрываемый cache.
- mcp-writer-lock test ждёт proxies, останавливает подтверждённый daemon своего
  temp-проекта и проверяет удаление каталога без подавления ошибок cleanup.

Один реальный stdio JSON-RPC MCP обслужил копии CSQTT desktop (51файл) и bot
(30файлов): catch-up до ответа, последующие правки обоих проектов дают
SHA256(source)==stored hash. Завершение exit0, writer locks удалены, shutdown
sync errors отсутствуют. Проверены также два engine в разных OS-процессах
с передачей writer ownership после следующего запроса.

## Артефакты

Локальные .scratch/cpp-real-adrc-results.json, cpp-real-adrc-validation.txt,
cpp-remaining-validation-20260912.md, cpp-adrc-parity-20260912.txt,
ids-real-ts-parity.log, dart-shelf-parity.log, real-excalidraw-callback*.json,
real-project-lifecycle-mcp-results.json и их воспроизводимые scripts.
Регрессионные tests включены в исходники. Windows/macOS не проверялись.

Verilog остаётся структурным графом; полный elaboration/timing — отдельная
интеграция toolchain и не добавлен в этот пакет исправлений.

## Финальная проверка

Полный native-suite на замороженных исходниках: **4715 passed, 9 skipped**,
**278 test files passed**, 0 failed. Прежние четыре Dart parity failures
устранены. Команда: `CODEGRAPH_KERNEL_EXPECT=1 npm test -- --maxWorkers 2 --minWorkers 1`.

Финальная ADRC-копия после recreate: 2021файл; 0 проверенных ложных macro calls;
15/15 настоящих контрольных calls сохранены; 32811nodes,70930edges,22663calls.
Полная длительность9.217с, resolver6.311с. 0filesErrored; 7 прежних parse warnings
в config headers. Это не обещание полного разбора всех условных C-конфигураций.

Ошибочные промежуточные варианты (все numeric defines; child-cache при cyclic
includes; потеря локального FAST_MATH в unknown arm) не опубликованы. Они
выявлены реальными controls/review и закреплены дополнительными тестами.

Native-only deep-nesting и raw-kernel transport tests теперь учитывают
CODEGRAPH_KERNEL=0. В WASM-arm они не могут требовать выключенный kernel;
в native-arm отдельно повторены: 10/10 passed. Это исправление условий
тестовой матрицы, а не удаление native-проверок.

Полный WASM-suite: **4705 passed, 19 skipped, 0 failed**; 277 test files passed,
1 native-only suite skipped. Команда: `CODEGRAPH_KERNEL=0 npm test -- --maxWorkers 2 --minWorkers 1`.
Native-only suites дополнительно проверены 10/10 в native-режиме.
TypeScript, build viewer/30 грамматик и diff whitespace прошли.
Все 10 активных индексов пересозданы с extraction31; появившиеся во время
работы три изменения CSQTT desktop дополнительно поглощены sync.

SHA256 собранного native kernel:
`a8acf04245b805c136a777ab8f8bd065c100bb2a7dd7b9bfd2915a45e241ca1b`.
Существующие чужие MCP-процессы не перезапускались; новый runtime загружается
после перезапуска соответствующей сессии.
