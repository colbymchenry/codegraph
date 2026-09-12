# Трекер развития Verilog / SystemVerilog в CodeGraph

Дата состояния: 2026-09-12. Проверенная база реализации: `b050fb8910e80116e327d9dc9a8af40bccee67bc`, extraction stamp **38**.

Назначение: довести HDL-навигацию до проверяемых ответов об иерархии, типах,
параметрах, соединениях и влиянии изменений на реальных RTL-проектах.
Это рабочий план с критериями закрытия задач, а не заявление о полном охвате языка.

Канонический рабочий файл находится в checkout `/home/danik/storage/codegraph-fix-20260911/VERILOG_TRACKER.md`.
Копия в `/home/danik/Projects_and_coding/codegraph/VERILOG_TRACKER.md` сохранена для доступа из открытого проекта.
При обновлении статуса синхронизировать эти два файла, пока checkout остаются раздельными.

## Правила ведения

- `[x]` — выполнено в указанной базе и подтверждено отчётом; `[ ]` — предстоит.
- Задача закрывается после реализации, regression tests, проверки на реальном
  корпусе и фиксации результата. Прототип сам по себе не означает поддержку.
- Для каждого закрытия записывать commit, отчёт, корпус/revision, профиль,
  версии инструментов и оставшиеся ограничения.
- Не ставить календарный срок до измерения объёма; порядок задают зависимости.
- Source graph, compiler semantics и результаты simulation/formal — отдельные
  уровни доказательств. Не подменять один другим.
- После каждого пакета актуализировать этот трекер, документацию и описание PR.

## 1. Что уже сделано

| ID | Статус | Результат и граница |
| --- | --- | --- |
| HDL-001 | [x] | Разбор `.v/.vh/.sv/.svh`, tree-sitter-systemverilog 0.4.0; версия grammar не доказывает полный охват стандарта |
| HDL-002 | [x] | Модули, instances, ports/signals, always/assign, function/task, packages, interface/modport |
| HDL-003 | [x] | Named, positional и wildcard port bindings с проверкой неоднозначности и порядка портов |
| HDL-004 | [x] | Lexical scopes, shadowing, generate templates, escaped names и устойчивые идентичности в проверенных случаях |
| HDL-005 | [x] | Синтаксические read/write/readwrite/control/event роли и `hdlAccess` / `--hdl-access` |
| HDL-006 | [x] | Пересчёт bindings/access roles при изменениях сигнатур и удалении/восстановлении объявлений |
| HDL-007 | [x] | Именованные build profiles, files/filelists, includes/defines, fingerprint и configured/indexed status |
| HDL-008 | [x] | Ограниченный выбор условных веток с сохранением исходных offsets/hashes и диагностикой unknown |
| HDL-009 | [x] | Watcher для config/filelists/includes, согласованный snapshot, диагностика частичного sync |
| HDL-010 | [x] | Реальные UART/CRC/AXI controls, sync против clean rebuild; поставка в три remote и draft PR #1845 |

Последний полный прогон: native **4894 passed / 9 skipped**, WASM **4884 passed /
19 skipped**, ошибок нет; 55 профильных тестов прошли. Это результаты базы выше,
а не гарантия для последующих коммитов. Десять активных индексов были проверены
на stamp 38, complete и 0 pending. Windows/macOS в последнем пакете не проверялись.

Отчёты в рабочем checkout:

- `docs/validation-hdl-navigation-2026-09-12.md`
- `docs/validation-hdl-port-bindings-2026-09-12.md`
- `docs/validation-hdl-wildcard-2026-09-12.md`
- `docs/validation-hdl-scopes-2026-09-12.md`
- `docs/validation-hdl-access-2026-09-12.md`
- `docs/validation-hdl-parse-gaps-2026-09-12.md`
- `docs/validation-hdl-profiles-2026-09-12.md`
- Инструкция профилей: `docs/hdl-profiles.md`; предыдущая история: `docs/hdl-roadmap.md`.

[База реализации и отчётов в GitHub](https://github.com/danusha2345/codegraph/tree/b050fb8910e80116e327d9dc9a8af40bccee67bc).

## 2. Открытые ограничения, которые нельзя забыть

- Include передаёт macro state, но не вставляет объявления header в compilation unit.
- Нет полного macro expansion и source map раскрытия. Непрозрачный macro может
  сделать дальнейший выбор веток неизвестным; такие ветки не угадываются.
- Каждый перечисленный source начинает с defines профиля. Общая compilation-unit
  семантика порядка файлов пока не моделируется.
- `topModules` и `languageMode` фиксируют намерение; нет elaboration, pruning от top
  и строгой проверки соответствия Verilog-only dialect.
- Один индекс содержит один профиль; одновременного semantic cache нескольких
  профилей пока нет.
- Нет достоверных instance-specific parameter values, ширин, типов и generate iterations.
- Source snippets могут содержать неактивные ветки. Access roles не доказывают
  электрического драйвера, race, latch, timing или CDC.
- Пределы профильного snapshot: 1 MiB на source/header и 64 MiB суммарно.
- UART sim имеет 5 диагностик неинтерпретированного timescale; оба проверенных
  AXI-профиля — 17 диагностик macro expansion. Полный demux требует отсутствовавших
  в контрольном наборе common_cells includes; неполный корпус не считать ошибкой языка.

## 3. Очередь выполнения и зависимости

| Пакет | Приоритет | Зависит от | Результат |
| --- | --- | --- | --- |
| A. Корпуса и frontend prototype | P0, следующий | текущая база | Обоснованный выбор адаптера и воспроизводимый benchmark |
| B. Preprocessing и source mapping | P0 | A | Раскрытие macros/includes с происхождением каждого результата |
| C. Типы и параметры | P0 | A–B | Проверенные значения, dimensions и type references |
| D. Elaboration и иерархия | P0 | B–C | Instance-specific graph и реальные generate branches |
| E. Сквозные сигнальные пути | P1 | C–D, HDL-005 | Трассировка соединений с явными unknown участками |
| F. Инженерные запросы и impact | P1 | E | Полезные CLI/MCP ответы с доказательствами |
| G. Verification SystemVerilog | P1 | B–D | Assertion/coverage/bind/DUT navigation |
| H. Class и UVM navigation | P2 | G, реальные сценарии | Обоснованный ограниченный охват testbench OOP |
| I. Масштаб и переносимость | сквозной | каждый пакет | Измеренные ресурсы, recovery и проверки ОС |
| J. Поставка и актуальность | сквозной | каждый пакет | Документация, индексы, commit/push/PR readback |

Пакеты идут последовательно по зависимостям. Внутри пакета независимые corpus,
frontend и review задачи можно отдавать агентам; общий schema/API контракт и
финальную интеграцию держать у одного владельца.

## A. Корпуса и выбор compiler frontend

- [ ] **A1** Зафиксировать manifest UART, eMMC/CRC, AXI: URL/revision, hashes,
  license, source lists, includes, defines, top, tool versions и отсутствующие зависимости.
- [ ] **A2** Восстановить необходимые открытые зависимости AXI в изолированной
  копии, зафиксировать версии и подтвердить корректный compiler invocation.
- [ ] **A3** Сравнить кандидатов: slang, Surelog/UHDM, Verilator; при необходимости
  Yosys для синтезируемого подмножества. Актуальные версии, лицензии, экспорт и
  ограничения проверить по официальным источникам во время прототипа.
- [ ] **A4** Измерить на одинаковых profiles: parse/elaboration success, diagnostics,
  source locations, types/parameters export, instance paths, время и peak RSS.
- [ ] **A5** Проверить интеграцию: отдельный процесс, формат обмена, доступность на
  Linux/Windows/macOS, версия API, redistributability и необязательность установки.
- [ ] **A6** Сохранить решение в `docs/hdl-frontend-decision.md` с матрицей результатов;
  выбрать один основной адаптер. Второй внедрять только при доказанном пробеле.

**Приёмка:** воспроизводимый запуск минимум на трёх реальных корпусах; сравнение
не менее двух подходящих кандидатов, либо документированный конкретный blocker.
Отсутствие frontend не ломает существующую source-навигацию. Производственный
адаптер до результатов сравнения не выбирать.

## B. Полное preprocessing через выбранный frontend

- [ ] **B1** Получать include/macro expansion и diagnostics из frontend; не писать
  собственный полный HDL-препроцессор внутри extractor.
- [ ] **B2** Сопоставить expansion с исходным файлом, диапазоном, macro definition
  и invocation. Для неоднозначного mapping возвращать явную неизвестность.
- [ ] **B3** Проверить function-like macros, arguments/defaults, nested expansion,
  token concatenation/stringification, conditional includes и include guards.
- [ ] **B4** Определить compilation-unit mode и порядок sources явно; не смешивать
  его с текущим independent-source режимом и не менять существующие profiles молча.
- [ ] **B5** Учесть compiler predefines, include search order и missing dependencies
  в effective configuration и fingerprint.
- [ ] **B6** Изменения header/macro/flags должны инвалидировать semantic context;
  old source snapshot не выдавать за новый compiler result.

**Приёмка:** текущие AXI macro controls разобраны либо получили точную compiler
ошибку; результат имеет исходные locations. Правки macro definition и invocation,
удаление include и смена compilation-unit mode дают sync/rebuild parity.

## C. Parameters, dimensions и types

- [ ] **C1** Ввести отдельные semantic records с provenance и версией формата;
  сохранить совместимость source IDs и существующих query/API.
- [ ] **C2** Parameters/localparams: declaration/default и evaluated value раздельно;
  instance overrides и type parameters не смешиваются между экземплярами.
- [ ] **C3** Packed/unpacked dimensions, signedness, range direction, structs/unions,
  enums, typedef aliases, package-qualified types и interface parameters.
- [ ] **C4** Отображать unresolved/external/unsupported состояния без фиктивных
  значений и без молчаливого преобразования unknown/X/Z в обычный integer.
- [ ] **C5** Добавить запрос «тип/ширина/параметры этого порта в этом instance»
  с переходами к declaration и override.

**Приёмка:** ручные controls и compiler export совпадают на UART/CRC/AXI;
два instance одного module с разными параметрами имеют разные правильные widths.
Смена package typedef/parameter не оставляет прежнюю semantic запись после sync.

## D. Elaboration и instance-specific hierarchy

- [ ] **D1** Явно выбрать top(s), конфигурацию и libraries; multi-top и неизвестный
  top возвращают объяснимый результат.
- [ ] **D2** Связать elaborated instance с source template, типом module и profile;
  arrayed instances и escaped hierarchical names имеют устойчивые идентичности.
- [ ] **D3** Generate if/case/for: фактические ветки/iterations отдельно от templates;
  genvar/localparams и parameter overrides брать из frontend.
- [ ] **D4** Сохранить interface/modport instances и формальные/фактические порты;
  black boxes, external libraries и unsupported primitives показывать явно.
- [ ] **D5** Определить invalidation для смены top/parameter/source/frontend version;
  запись нового semantic graph публикуется согласованно после успешного прохода.

**Приёмка:** полные instance paths совпадают с frontend; несколько экземпляров и
условный generate не сливаются. Прерванная/неуспешная elaboration не уничтожает
source graph и не маркирует старый semantic graph как актуальный.

## E. Связность и пути сигналов

- [ ] **E1** Соединить actual expression → instance port → formal signal с
  declaration direction и instance-specific widths.
- [ ] **E2** Представить slices, concatenations, replication, casts и expression
  boundaries; разделить точное bit mapping и зависимость без точного mapping.
- [ ] **E3** Учесть interface/modport directions, arrays of interfaces, inout/ref;
  спорные resolved-net/tri-state/alias случаи оставлять unknown до отдельного control.
- [ ] **E4** Трассировать source-level data/control dependencies через assign и
  procedural blocks, отдельно обозначая sequential boundaries.
- [ ] **E5** Ограничить глубину/объём обхода, обработать циклы, показать место
  остановки и доказательство каждого перехода.

**Приёмка:** UART RX → FIFO, вход CRC → crc_out, AXI valid/ready через wrapper
сверены с ручной трассировкой. Отрицательные controls для shadowing, разных
instances/profiles и неверных slices не создают ложных переходов. Source path
не называется временной трассой или доказательством физической передачи сигнала.

## F. Полезные запросы CLI/MCP и анализ изменений

- [ ] **F1** Запросы «где объявлен», «кто читает/пишет», «куда подключён»,
  «какой instance/top/profile», «тип и ширина», «почему unknown».
- [ ] **F2** Запрос «что затронет изменение порта/параметра/typedef»: различать
  подтверждённые прямые зависимости и возможные транзитивные последствия.
- [ ] **F3** Сравнение двух сохранённых profile/revision результатов — сначала
  последовательное; необходимость постоянных нескольких индексов измерить отдельно.
- [ ] **F4** В ответах показывать configured/indexed/semantic context, freshness,
  diagnostics и source links; строки header/expansion не приписывать другому файлу.
- [ ] **F5** Обновить CLI help, MCP instructions и пользовательские примеры.
  Viewer hierarchy/path UI добавлять после стабилизации query contract.
- [ ] **F6** Сравнить ответы агента с CodeGraph и без него на фиксированных задачах:
  точность, пропуски, ложные связи, число запросов, время и расход контекста.

**Приёмка:** контрольные инженерные вопросы имеют ожидаемые ответы и ссылки;
пользователь видит причину неполного результата, а не пустую «доказанную» выборку.
A/B результаты записываются отдельно от extractor unit tests.

## G. Verification-конструкции SystemVerilog

- [ ] **G1** Property/sequence declarations и references, assert/assume/cover,
  immediate/concurrent assertions, disable iff и используемые signals/clocks.
- [ ] **G2** Clocking blocks и sampled-value/event expressions: найти исходное
  использование без заявления о полном temporal semantics.
- [ ] **G3** Bind targets и DUT ↔ checker/testbench connections с provenance профиля.
- [ ] **G4** Covergroup/coverpoint/cross declarations и связи с выражениями;
  declaration coverage не путать с выполненным runtime coverage.
- [ ] **G5** Реальный открытый verification corpus плюс минимальные негативные cases.

**Приёмка:** запрос по RTL-сигналу находит относящиеся assertions/checkers и
исходные строки. Результат не обозначается formal proof или simulation pass.

## H. Classes и UVM — после RTL и verification navigation

- [ ] **H1** Собрать реальные сценарии, где текущей навигации не хватает, прежде
  чем расширять общий class resolver.
- [ ] **H2** Class inheritance, parameterized classes, methods, constructors,
  virtual methods/interfaces и lexical visibility — с отдельными ambiguity controls.
- [ ] **H3** UVM macros, factory registration/overrides, config_db и phases:
  статически подтверждённые связи отдельно от runtime possibilities.
- [ ] **H4** Измерить retrieval value на открытом testbench и выбрать полезное
  подмножество; непредсказуемые runtime overrides не угадывать.

**Приёмка:** контрольные testbench queries находят declarations и подтверждённые
связи, не выдают одну предполагаемую factory/runtime цель за точную.

## I. Производительность, надёжность и переносимость

- [ ] **I1** Для каждого пакета измерять cold index, no-op sync, source/header/profile
  change, время queries, peak RSS, DB size и стоимость semantic cache.
- [ ] **I2** На большом corpus проверить dependency invalidation; оптимизировать
  только после baseline, сохраняя согласованность source/compiler snapshots.
- [ ] **I3** Frontend process: timeout/cancel, bounded output, crash recovery,
  missing executable/version mismatch, отсутствие shell-интерполяции аргументов.
- [ ] **I4** Проверить interrupted writes, watcher churn, concurrent source changes,
  stale cache и отсутствие orphan processes после shutdown.
- [ ] **I5** Реальные Linux/Windows/macOS проверки paths, case sensitivity,
  symlinks, CRLF, Unicode, file locks и watchers при наличии соответствующих сред.
- [ ] **I6** Проекты с generated HDL и файлами больше текущих limits: измерить
  потребность, затем определить streaming/limits policy без безусловного расширения.
- [ ] **I7** Регулярно проверять обновления grammar/frontend и актуальные стандарты
  по официальным источникам; перед обновлением — corpus diff и source-map controls.

**Приёмка:** budgets фиксируются после baseline; нет необъяснённой регрессии.
Непроверенные ОС и неподдержанные constructs перечислены в отчёте явно.

## J. Проверки и поставка каждого пакета

- [ ] **J1** Сначала воспроизведение дефекта/ожидаемого поведения и минимальный
  regression; для чистой документации достаточно проверки содержания и ссылок.
- [ ] **J2** Focused tests и независимое review изменений; исправление findings.
- [ ] **J3** Реальные corpus runs и сравнение полного графа sync/clean rebuild,
  включая отрицательные случаи, diagnostics и неизменность исходников.
- [ ] **J4** Native/WASM suites при изменениях общих extraction/resolution/storage
  путей; typecheck/build/assets. Не выдавать skipped за passed.
- [ ] **J5** Обновить extraction/schema/semantic cache version, если изменилась
  интерпретация графа; проверить миграцию или понятное требование reindex.
- [ ] **J6** README/help/instructions, этот tracker, feature coverage matrix и
  validation report привести к фактически поставленному состоянию.
- [ ] **J7** Переиндексировать согласованные активные проекты, проверить freshness;
  для уже работающих MCP-сессий учесть необходимость restart новой реализации.
- [ ] **J8** В рамках согласованной поставки: JJ diff/status → commit → push
  GitHub fork/GitLab/Forgejo → одинаковый SHA → PR body/head readback.
- [ ] **J9** Перед обновлением интеграционного PR проверить уже принятые upstream
  изменения и убрать подтверждённо лишний diff. Не push в upstream main.

J — повторяемый checklist, его отметки относятся к конкретному пакету, а не
закрывают всю будущую поставку навсегда. Npm release/deploy — отдельное действие,
не подразумеваемое обновлением draft PR.

## 4. Матрица покрытия, которую нужно вести

- [ ] Создать `docs/hdl-feature-coverage.md`: для каждой конструкции отметить
  parse / extract / resolve / query / semantic и ссылку на реальный пример.
- [ ] Начальный перечень: modules/programs/interfaces/packages; ports/bindings;
  parameters/types/dimensions; lexical/generate scopes; assignments/processes;
  functions/tasks; directives/macros/includes; assertions/clocking/bind/coverage;
  classes/UVM; primitives/configurations/libraries.
- [ ] Для каждого пробела определить: grammar, extractor, resolver, query,
  отсутствующий build context или frontend limitation. Исправлять нужный слой.

## 5. Ближайшая конкретная итерация

1. Выполнить **A1–A2**: manifests и полноценный AXI build context.
2. Параллельно поручить агентам независимые frontend probes и аудит source mapping;
   основной агент готовит общую схему результатов и baseline source graph.
3. Свести **A3–A6** в decision report и зафиксировать adapter contract.
4. Реализовать минимальную вертикаль **B1–B2 + C1–C2**: один profile, один top,
   parameter value с правильным source mapping и fallback без frontend.
5. Провести J1–J9 для этого ограниченного пакета; затем расширять B/C и переходить к D.

## 6. Журнал выполнения

| Дата | Пакет | Результат | Commit / отчёт | Следующее действие |
| --- | --- | --- | --- | --- |
| 2026-09-12 | Source navigation, scopes, access | Реализованные части перечислены в HDL-001–006 | Отчёты раздела 1 | Сохранить regression coverage |
| 2026-09-12 | Build profiles | Ограниченный source-режим, реальные profile parity проверки | `b050fb89`, `docs/validation-hdl-profiles-2026-09-12.md` | A: frontend comparison |
| 2026-09-12 | Полный план | Создан этот tracker; новые implementation задачи не объявлены выполненными | `VERILOG_TRACKER.md` | A1–A2 |

Для следующей записи: дата → ID задач → наблюдаемый результат → commit/report →
непроверенное/ограничения → следующий шаг. Исторические результаты не перезаписывать
как свежие без нового запуска.
