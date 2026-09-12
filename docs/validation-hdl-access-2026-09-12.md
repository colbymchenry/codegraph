# HDL: чтение, запись и контекст использования сигналов

База 545b083f; extraction stamp 37. Linux x64 / Node 24.15.0;
grammar tree-sitter-systemverilog 0.4.0. Реализован этап 2 roadmap.

## Использование

Из каталога проиндексированного проекта:

```sh
codegraph explore 'top::q' --hdl-access write
codegraph explore 'top::q' --hdl-access read
codegraph explore 'top::clk' --hdl-access event
```

MCP: `codegraph_explore({query:"top::q", hdlAccess:"write"})`.
Доступны read/write/readwrite/control/event/all. Qualified names с :: или
точками поддерживаются; одинаковые bare names выводятся отдельно по scopes.
Обычный explore без hdlAccess сохраняет прежнее поведение.

Read включает readwrite/control/event; write включает readwrite. Вывод содержит
точные file:line:column, source snippets и evidence formal direction для
аргументов известных подпрограмм. Перед показом исходника проверяется SHA256,
в том числе при сохранённых размере и mtime. Unknown references не выдаются за
доступ; пустой результат не доказывает отсутствия использования.

## Классификация

- Blocking/nonblocking/continuous assignments; compound и increment/decrement.
  x[i]=y означает x:write, i/y:read. Позиции одной строки хранятся отдельно
  существующим SQLite identity, поэтому x=x+1 сохраняет обе occurrences.
- Условия if/case/loops — control; события — event с posedge/negedge evidence.
  if(i++) сохраняет readwrite и control одновременно. Return и delays — read.
- Net/data initializer даёт self-reference write и отдельные RHSreads;
  bare declarations, dimensions и localparam не получают предполагаемых writes.
- Полная однозначная сигнатура function/task: input/const ref read, output
  write, inout/ref readwrite. Индексы выходного actual читаются; явный i++
  сохраняет побочный эффект. Unsupported/unknown signatures и недопустимые
  expression shapes оставляют обычные references.
- Formal direction определяется при resolution, не по глобальному имени.
  При HDL-изменениях sync переклассифицирует argument sites в неизменённых
  caller files; при удалении сигнатуры старая классификация снимается.
  Поиск ограничен HDL sources и candidate argument edges, не всем графом.

Это синтаксические и обусловленные декларацией роли доступа, а не доказательство
исполнения, электрического драйвера, latch/race, timing или CDC.

## Проверки

30 focused tests прошли, включая публичные MCP/CLI, negative controls,
неизменённый non-HDL explore и source-drift guard. Постоянный sync-тест меняет
output→input, удаляет и возвращает task как inout при неизменном top; результат
совпадает с clean rebuild и не оставляет прежних access tags.

Реальные запросы через ToolHandler:

| Корпус | Проверенные запросы |
|---|---|
| Dual UART (11 файлов) | top::hb_cnt/write, top::clk/event |
| eMMC reader (33 файла) | crc/write, bit_in/read, feedback/write, enable/control внутри emmc_crc16 |
| AXI (104 файла) | axi_atop_filter::clk_i/event |

Отдельная копия AXI: изменение axi_pkg.sv, sync 366 мс; 6981 access/argument
edges полностью совпали с clean rebuild, включая source positions и metadata.
Исходные пользовательские RTL не изменялись. Это измерение одного локального
контроля, не общая гарантия производительности.

Полный native: 295 test files, 4839 passed, 9 skipped, 0 failed.
Полный WASM: 294 test files passed, 1 skipped; 4829 passed, 19 skipped, 0 failed.
Build с viewer/30 grammar assets и TypeScript прошли. Все 10 активных индексов:
stamp 37, complete, 0 pending changes.

Первый native-прогон выявил округление mtime в новой тестовой fixture на 1 мс;
фиксированное целое значение timestamp устранило нестабильность, затем прогон
повторён. Проверка SHA256 исходника не ослаблялась.
Артефакты: .scratch/hdl-access-complete-focused.log, hdl-access-real-results.json,
hdl-access-real-sync-results.json, hdl-access-*.txt и hdl-access-final-*.log.
