# Проверка HDL profiles — 12 сентября 2026

База 5f903355; extraction stamp 38. Linux x64, Node 24.15.0,
tree-sitter-systemverilog 0.4.0. Конфигурация и границы — hdl-profiles.md.

## Проверенные сценарии

- Загрузчик: .f/.F, вложенные -f/-F, quotes/comments, incdir/define,
  fingerprint, неизвестные флаги, циклы/конфликты и недопустимые пути.
- Выбор веток: offsets CRLF/UTF16, вложенные includes, guards/cycles,
  отсутствующие заголовки и неизвестные эффекты непрозрачных макросов.
- Index: смена профиля удаляет предыдущий HDL-вариант, сохраняет остальные
  языки и raw hashes, пересчитывает общие units при изменениях контекста.
- Compiled CLI index/sync/status/explore: выбранный source проходит через
  worker threads; configured/indexed profiles разделены.
- Настоящий fs.watch: ignored filelists, заголовки с произвольным расширением,
  переключение на ранее не наблюдавшиеся каталоги и callback dependencies.
- Include с сохранёнными размером/mtime меняет fingerprint; scoped sync
  выбирает новую ветку. Правка во время прохода сохраняет согласованный старый
  snapshot и подхватывается следующим sync вместо записи пустого marker.
- Частичные indexFiles/scoped sync сохраняют диагностику необработанных source units.

Ревью нашло и помогло исправить два интеграционных дефекта: несогласованный
snapshot/raw hash и устаревшую диагностику частичных обновлений. Также исправлен
выбор неверного else после непрозрачного макровызова; compiler controls
подтверждают необходимость состояния unknown.

## Реальные корпуса

Filelists для независимых копий сгенерированы явно; это не исходные build
files авторов. Исходные 11 UART и 67 AXI source/include файлов проверены
по SHA256 до и после; originals и copies не изменились.

| Корпус / профиль | Файлы | Узлы | Рёбра | Проверка |
| --- | ---: | ---: | ---: | --- |
| Dual UART synth | 6 | 396 | 1159 | tb_top отсутствует |
| Dual UART sim | 11 | 853 | 2978 | tb_top присутствует |
| AXI normal | 2 | 301 | 660 | default_mst_port_i использует idx_width(Cfg.NoMstPorts) |
| AXI VCS | 2 | 303 | 662 | default_mst_port_i использует MstPortsIdxWidth |

Для обоих корпусов выполнено переключение туда и обратно через scoped sync
и сравнение всех nodes/edges с CodeGraph.recreate: полное совпадение,
включая metadata. Возврат UART synth восстановил исходный hash графа.
Все проходы вместе заняли 3.85 с на этой машине; это локальная проверка,
не обещание производительности на иных проектах.

UART sim отмечен incomplete: 5 сохранённых, но не интерпретированных timescale.
Оба AXI-профиля отмечены incomplete: 17 диагностик macro expansion.
Эти результаты подтверждают выбор условных исходников, но не elaboration,
полный preprocessing, синтез или аппаратную корректность.

## Обновление активных проектов

Все 10 ранее выбранных активных проектов переиндексированы установленным CLI:
extraction stamp 38, state complete, reindexRecommended false, pending changes 0.
Это индексы ADRC (три checkout), FreeFCC, Wails, bot, CodeGraph,
CSQTT android-server/desktop и Skylab Hub. Уже работающие MCP-сессии
нужно перезапустить, чтобы они загрузили новую реализацию.

## Автоматические проверки

- 55 профильных tests: loader 22, preprocessor 14, status 10, index 4,
  настоящий fs.watch 4 и compiled CLI/worker 1 — все прошли.
- Полный native: 301 suite, 4894 passed, 9 skipped, 0 failed.
- TypeScript и production build с viewer/30 grammar assets прошли.
- Полный WASM: 300 suites passed, 1 skipped; 4884 passed, 19 skipped, 0 failed.
- Полная матрица выполнена последовательно с двумя workers.
- Уточнена прежняя MCP-проверка: запрещается сообщение о неактивном сервере,
  а не слово inactive в справке об условных ветках HDL.

Windows/macOS в этом пакете не проверялись.
