# Проверка compiler macro provenance

Дата: 2026-09-12. База CodeGraph до пакета: `d1d25f02`; source extraction stamp
остаётся 38. Добавлен optional pyslang backend для `hdl-semantic --python`,
отдельный нормализованный протокол exporter и проверка координат по snapshot.
Инструкция: `hdl-macro-source-map.md`.

## Реализация и доказательства

Использован `pyslang==11.0.0` в отдельном Python 3.14 venv. В production runtime
зависимость сама не устанавливается; script поставляется вместе с dist.
Backend выполняет собственную compilation через Driver/SourceManager и получает
значения и provenance в одном процессе. JSON от отдельного slang CLI не
склеивается с координатами другой compilation.

SourceManager даёт две связи: original и expansion. Exporter обходит обе,
сохраняет bounded set frames и не выдаёт их за линейный стек. Points отражают
физические UTF-8 byte offsets и line/column, включая BOM/CRLF и `line` directives.
Macro-origin никогда не получает предполагаемый sourceNodeId. Прямые parameter,
port и typedef факты могут связаться с подходящим source node при совпадении
профиля, raw hash, имени, строки и вида узла.

Объём — происхождение имени объявления. Macro uses только внутри initializer
или выражения ширины этим пакетом полностью не представлены. Token concatenation
даёт spelling point префикса, а не диапазон всего склеенного имени.

## Реальный AXI

В восстановленной копии A2 через новое API и compiled CLI проверен
`synth_axi_lite_xbar.aw_chan_t` при `NoSlvMst=4`:

- `kind=type`, `width=35`, `sourceOrigin=macro`.
- Точка аргумента: `test/axi_synth_bench.sv:415:31`, byteOffset 13097.
- Точка исходного текста в теле определения: `include/axi/typedef.svh:178:44`,
  byteOffset 9228.
- Внешний invocation range: `test/axi_synth_bench.sv:415:3–49`,
  byteOffsets 13069..13115.
- Внутренний argument range у SourceManager сворачивается в одну точку:
  `macroExpansionComplete=false`. Диапазон не дорисовывается по строке.
- sourceNodeId отсутствует: аргумент/тело macro не подменяет literal declaration.

Отдельно через новый backend повторены UART CLK_FREQ=50000000, CRC width=16
и AXI NoSlvMst=4. В custom nested/concat control с UTF-8 и CRLF проверены
parameter P=7 и macro-generated bus_data width=4. Все API assertions прошли.
Original UART/CRC/AXI корпуса не изменялись.

## Автоматические проверки

53 focused tests прошли: 20 runner, 10 прежнего importer, 4 API, 8 прежнего
review, 1 compiled CLI, 4 normalized importer, 5 source-map review, 1 asset.
Проверены ровно один selector, venv launch path, native/helper hashes, timeout,
cancel, source changes, malformed envelope, forged sourceNodeId, byte-offset
расхождения, UTF-8 continuation, граница CRLF, incomplete/collapsed ranges и limits.

Шесть отдельных проверок с настоящим pyslang:

```sh
/path/to/venv/bin/python -I scripts/verify-hdl-source-map-export.py \
  --work-root /path/to/storage
```

Они покрывают nested/include/default macros, обе parent relations, quoted
filename/arguments, BOM/UTF-8/CRLF, physical `line` coordinates, token concatenation,
ноль/пустую строку/XZ, shared instance bodies/generate, compiler error gating и
macro typedef. В первой live-интеграции найдена и исправлена ошибка чтения
ConstantValue: методы empty/isContainer нельзя трактовать как boolean свойства;
валидность и container state теперь проверяются правильно.

Production build прошёл; helper в dist побайтно совпадает с source и присутствует
в `npm pack --dry-run` (11889 bytes на этой базе). Ничего в npm не опубликовано.
Полный native: 309 test files, 4947 passed, 9 skipped, 0 failed.
Полный WASM: 308 test files passed, 1 skipped; 4937 passed, 19 skipped, 0 failed.
Матрица выполнена последовательно с двумя workers.

## Границы

Нет полной origin map выражений, persistent cache, автоматической MCP compilation,
simulation, synthesis или аппаратных проверок. Windows runner отключён;
проверен Linux, macOS runtime не запускался. Пределы snapshot/процесса сохранены.
Версия normal slang CLI не заменяется и старый selector остаётся доступен.
