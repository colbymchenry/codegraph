# HDL: positional, wildcard и актуальная grammar

База 7d0321ae, extraction stamp 35. Linux x64, Node 24.15.0.

## Версии

На 12 сентября 2026 активный стандарт — [IEEE 1800-2023 SystemVerilog](https://standards.ieee.org/ieee/1800/7743/), опубликованный 28 февраля 2024. Старый Verilog IEEE 1364 входит в объединённое семейство SystemVerilog.

Grammar обновлена с 0.3.1 до [tree-sitter-systemverilog 0.4.0](https://github.com/gmlarumbe/tree-sitter-systemverilog/releases/tag/v0.4.0), релиз 17 июля 2026. Upstream commit aa09b9004478cea0f46d877608910dc153b277b6, ABI 15, web-tree-sitter 0.25.10. Официальный release WASM SHA256: 52e470eacf2a87af5056fe054c081d4495d1da72f5d0a9bb0d431e111ee8f235 (21,802,386 bytes).

Изолированное сравнение 137 HDL-файлов (11 Dual UART, 33 eMMC reader, 93 AXI): одинаковые 7 ERROR/0 missing и их позиции. Хотя AST 19 файлов изменился, результаты nodes/refs/edges совпали полностью после исключения timestamps. Дополнительные method_call wrappers вокруг field accesses не создали calls. Отдельно подтверждены улучшения class timeunits, generate inside, keywords в аргументах макросов. Это не сертификация полной поддержки IEEE 1800-2023.

## Связи

- Порядок портов берётся из заголовка, включая non-ANSI с другим порядком body declarations. Unknown/complex headers не угадываются.
- Позиционные подключения представлены port[0], port[1] и т.д. Пустые позиции сохраняются; extra/mixed/error inputs не получают formal bindings.
- Wildcard clause имеет узел *. Только однозначные formal/local пары получают endpoints. Explicit .a и .a() имеют приоритет; genvar, параметры и другие shadow declarations не подменяются внешним сигналом.
- Каждое вычисляемое подключение сохраняет зависимость от целевого модуля. Это позволяет обновить результат после изменения заголовка, даже когда прежние ID портов не изменились.
- Sync заменяет всю группу производных endpoints; surviving actual edges не остаются после удаления formal. Failed bindings восстанавливаются после удаления дублирующего модуля, включая deletion-only sync.

Это синтаксическое соответствие имён. Width compatibility, elaboration, generate expansion, timing/CDC не вычисляются.

## Проверки

Постоянные focused tests: порядок заголовков, пустые позиции/комментарии,
unknown headers, explicit precedence, escaped names, genvar/parameter shadows,
восстановление после удаления duplicate, удаление последнего модуля и старых
actual endpoints. Добавлены 6 parser regression cases для grammar 0.4.0.

Реальные копии: Dual UART 11 файлов/86 named; eMMC reader 33/560 named;
AXI 104 файла, 3411 named, 32 positional, 14 wildcard clauses.
В AXI получены 28 formal/actual wildcard pairs: например
axi_synth_bench::generate@28:33::s::* связывает synth_slice::clk_i с
axi_synth_bench::clk_i и аналогично rst_ni. Для дополнительного positive control
создана отдельная копия Dual UART: u_rx1 переписан из named в 6 positional
аргументов с комментариями. Port[2] сохранил uart_rx::rx и top::rx1.
Исходные RTL-проекты не изменялись.

Полный native: 288 test files, 4796 passed, 9 skipped, 0 failed.
Полный WASM: 287 test files passed, 1 skipped; 4786 passed, 19 skipped, 0 failed.
Все 10 активных индексов пересобраны до stamp 35: complete, 0 pending changes.

Build копирует точный проверенный WASM: source/dist SHA256 совпадают.

Артефакты: .scratch/grammar-v040/manifest.json, compare.json,
extraction-deltas.json, .scratch/hdl-expanded-real-results.json и
hdl-expanded-final-*.log. Полные RTL/scratch snapshots вне Git.
