# Verilog/SystemVerilog и общие исправления — 12 сентября 2026

## Восстановленная поддержка HDL

Ветка, установленная после 11 сентября, не содержала Verilog, хотя предыдущая
интеграционная сборка его поддерживала. Перенесены extractor и grammar из
`eval/402-verilog` (`875880c`), включая include/define и simulation-stub
disambiguation. Первоначальный автор extractor — FHYQ-Dong, upstream PR #402
(`26610932a9900d98df8802363581274b62b67262`); локальный порт — `e380bf7`,
дополнение include/define — `a87170a`.

- Расширения: .v, .vh, .sv, .svh; используется tree-sitter-systemverilog 0.3.1.
- Модули/interfaces/packages, functions/tasks, constants/typedefs, imports/includes.
- Иерархия модулей через instantiates доступна в callers/callees и named flow.
- Flow следует instantiates только для Verilog; обычные new X() не превращаются
  из-за этого в цепочки исполнения TypeScript.
- Порты/внутренние сигналы, timing и полный elaboration не моделируются.
  Выбор по synthesis/simulation пути — эвристика, не замена filelist FPGA-tools.

Грамматика: ABI 15, 20 повторных parse, 0 ошибок. SHA256:
`b07c23a12884f3bad0043ed77d246a7a3b04da70fc74d9193b67166481487801`.
WASM включён в version control и копируется в dist при build (30 грамматик).
Verilog разбирается WASM-путём, отдельного Rust extractor для него нет.

## Реальные корпуса

Использованы копии RTL/testbench-файлов наших проектов без дампов и bitstream,
а также clone pulp-platform/axi на `da8793b0e3f14c9186c94fac9ed6ec06375c254e`.

| Корпус | HDL-файлы | Контейнеры class | Interfaces | Instantiates | Проверенный путь |
|---|---:|---:|---:|---:|---|
| 2uart_to_1uart | 11 | 11 | 0 | 11 | top → uart_rx |
| fpga_tang_nano_9k_card_reader | 33 | 32 | 0 | 34 | top → uart_bridge → uart_rx |
| pulp-platform/axi | 93 | 176 | 7 | 276 | axi_xbar → axi_xbar_unmuxed → axi_demux |

AXI: всего проиндексировано 104 файла, из них 93 HDL; 587 typedef и 186 import.
Это новые детерминированные проверки extraction/retrieval. Старые agent A/B
из PR не переиспользуются как текущие. Нового платного agent A/B и timing/
синтеза/прошивки FPGA не выполнялось.

Артефакты: `.scratch/verilog-corpus.cjs`, `verilog-corpus-results.json`,
`verilog-corpus-final.log`; копии в `~/storage/codegraph-real-issues-20260912/`.

## Общие исправления

- #1356: закрывшийся во время hello socket не получает новую MCP session.
  Проверяется реальным TCP connect → server hello → disconnect; clients=0.
- #1777: resolution tests сбрасывают ссылку cg перед тестом и удаляют tempDir
  в finally после закрытия графа, а не только в альтернативной ветке else.
- #1832: prompt-hook игнорирует целый envelope task-notification до поиска
  по проекту. Упоминание envelope в пользовательском вопросе не подавляется.
  Реальный CLI на CodeGraph: notification — exit 0 / 0 bytes; обычный
  structural prompt — exit 0 / 9223 bytes.

Extraction stamp повышен до 30: ранее существовавшие HDL-файлы требуют rebuild.

## Особенность тестового runtime

Первый совместный запуск двух тяжёлых наборов без --liftoff-only завершился
V8 Fatal process out of memory: Zone; full native также имел таймауты под
нагрузкой. Эти прогоны не считаются успешными. npm test теперь запускает Vitest
с --liftoff-only, как рабочий CLI: это отключает дорогостоящую оптимизацию
тяжёлой WASM-грамматики. Контролируемый повтор выполняется последовательно,
с двумя workers.

Итог controlled native: **4672 passed, 4 прежних Dart parity failures,
9 skipped**, 272 файла. Новых отказов нет. Профильный WASM с одним worker:
**945 passed**, 6 файлов (extraction, resolution, Verilog flow/resolution,
frontload-hook, daemon-client-liveness). TypeScript, build и whitespace
проверены. Windows/macOS не запускались.
