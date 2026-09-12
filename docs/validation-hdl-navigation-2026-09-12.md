# Практическая навигация по HDL — 12 сентября 2026

База e174e684; Linux x64, Node 24.15.0. Extraction stamp 33.
Verilog/SystemVerilog использует WASM grammar и при включённом native kernel.

## Что теперь можно спросить у графа

- `top.u_rx1 top.u_rx2`: разные экземпляры одного модуля, тип, параметры,
  исходные named/positional/shorthand подключения и локальные сигналы.
- `emmc_crc16.crc emmc_crc16.crc_out`: объявления, исходные always/assign
  и синтаксические references; initializer feedback связан с bit_in.
- `AXI_BUS.Master AXI_BUS.Slave`: отдельные modports, направления в source
  signature, ссылки на сигналы интерфейса. Interface-порт связан через type_of
  с конкретным modport.
- Package calls сохраняют pkg::func. Bare calls требуют lexical/import
  evidence; одинаковые функции разных packages не выбираются произвольно.

Именованные generate blocks образуют scope. Для безымянных используется
позиция исходника. Массив instances представлен одной декларацией с исходным
диапазоном; одинаковые имена на одной строке различаются колонкой ID.
Module→module instantiates сохранён для прежних flow queries; дополнительно
есть instance→type. Новых schema kinds и Rust wire indexes не добавлено.

## Реальные проекты

Неизменённые копии исходников находятся вне Git в
`~/storage/codegraph-real-issues-20260912/`. AXI — pulp-platform/axi,
ревизия da8793b0e3f14c9186c94fac9ed6ec06375c254e.

| Корпус | Файлы индекса | Поля/сигналы | Instances | Always/assign/initial blocks | Время index + query |
|---|---:|---:|---:|---:|---:|
| Dual UART | 11 | 226 | 11 | 36 | 0.620 с |
| eMMC card reader | 33 | 1266 | 35 | 180 | 1.069 с |
| AXI | 104 | 3333 | 494 | 905 | 1.755 с |

До изменения первые два корпуса вообще не имели port/signal/instance nodes;
AXI также не имел этих nodes. Все три запроса выше выполнены через настоящий
ToolHandler codegraph_explore; ответы содержат соответствующие исходники.
SQLite readback подтвердил u_rx1→rx1, u_rx2→rx2, feedback→bit_in.
В отдельном probe трёх AXI файлов: 18 modports, 534 references от modports,
точные mst/slv→AXI_BUS::Master/Slave. Дубликатов ID в трёх RTL-корпусах нет.

## Проверки и границы

Полный native: 283 test files, 4745 passed, 9 skipped, 0 failed.
Полный WASM: 282 test files passed, 1 skipped; 4735 passed, 19 skipped, 0 failed.
TypeScript и build с viewer/30 grammar assets прошли.


22 focused HDL tests и 8 extraction tests прошли. Проверяются generate scopes,
повторная индексация, массивы, wildcard без придуманных connections, named/
positional/shorthand references, non-ANSI redeclaration, port direction,
shadowing (включая genvar), package qualifiers не становятся сигналами, конфликтующие imports и explicit package calls.

Первый полный запуск не засчитан: агент удалил временный probe из __tests__
после обнаружения его Vitest, получился ENOENT при загрузке suite. Все проверки
повторены после фиксации набора файлов; временные probes не входят в commit.

References означают синтаксическое использование, без классификации read/write.
Procedural locals подавляются консервативно при shadowing; hierarchical signal
access и LHS part-select не дают предполагаемую локальную связь. `.*`, generate
iterations, preprocessing/filelists, widths/types expressions не elaborated.
Нет timing, synthesis, CDC, UVM class-method dispatch или аппаратной проверки.
Windows/macOS и новый agent A/B не запускались.

Все 10 активных индексов пересобраны до stamp 33; readback: complete и 0 pending changes.
Другим ранее созданным HDL-индексам нужен rebuild до stamp 33. Уже запущенный MCP-процесс
загружает новый extractor после перезапуска.

Артефакты: `.scratch/hdl-usefulness-results.json`, `hdl-explore-*.txt`,
`hdl-instances-corpus-results.json`, `hdl-package-real.log`, `hdl-final-*.log`.
