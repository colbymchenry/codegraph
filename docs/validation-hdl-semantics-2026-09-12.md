# Проверка первой интеграции HDL semantics

Дата: 2026-09-12. База до пакета `11b3b44b`; extraction stamp остаётся 38:
source extraction/schema не меняется. Добавлены on-demand API
`CodeGraph.getHdlSemantics` и CLI `hdl-semantic`, optional slang runner и importer.
Инструкция и ограничения: `hdl-semantics.md`.

## Проверки интеграции

38 focused tests прошли: importer 10, runner 15, API 4, review controls 8,
compiled CLI 1. Покрыты shared bodies и отдельные instance parameters,
generate indices/instance arrays, malformed refs/cycles/oversized AST,
сложные unknown types и source coordinates. Runner проверен настоящими
subprocesses: timeout, AbortSignal, остановка descendants, cleanup, input/output
limits, BOM, source/snapshot modifications, missing-header creation и options
mutation. CLI передаёт overrides и отвергает duplicate parameters/invalid limits.

Review помог исправить происхождение параметров при мутации caller options,
типовую совместимость sourceNodeId и проверку диапазона source column. Повторные
controls подтвердили отсутствие ложной связи macro port с одноимённым method.
Сложные неизвестные widths не преобразуются в 0; null column остаётся unknown.

## Реальные корпуса через новую API, затем compiled CLI

Использованы отдельные копии frozen UART/CRC и AXI с восстановленными dependency
revisions A2. Originals не изменялись. Slang: `11.0.448+e222e7dc0` из установленного
OSS CAD Suite 20260825; проверен существующий wrapper executable и его hash.
Это hash launcher-файла, не fingerprint всех связанных библиотек/toolchain.

| Корпус / запрос | Проверенный результат | Время одного локального запроса |
| --- | --- | ---: |
| UART / top.CLK_FREQ, explicit compatible | value 50000000, width 32, sourceNodeId | 98 мс |
| CRC / crc_out | width 16, sourceNodeId | 70 мс |
| AXI / NoSlvMst=2 | value 32'd2, width 32, sourceNodeId | 566 мс |
| AXI / NoSlvMst=4 | value 32'd4, width 32, sourceNodeId | 638 мс |

Это одиночные measurements для smoke validation, не performance guarantee.
Fingerprint AXI меняется между overrides. Строгий UART возвращает compiler error;
compatibility включается только явно. Отсутствующий executable возвращает ошибку,
source graph statistics остаются прежними (динамический getStats.lastUpdated
исключён из сравнения). На реальном compiled CLI повторён AXI override 4:
проверены value, sourceNodeId и compilationUnitMode=separate.

## Include change, два экземпляра и sync/rebuild

Отдельный небольшой RTL control использует leaf с parameter W из header,
два экземпляра `top.a` и `top.b`, у второго override W=16.

1. Начальный header WIDTH=8: widths 8/16.
2. Header изменён на WIDTH=12: следующий on-demand запрос возвращает 12/16,
   fingerprint меняется, sourceGraphProfileMatches=false, старые node links не выдаются.
3. Scoped sync include-файла: sourceGraphProfileMatches=true, ссылки доступны.
4. CodeGraph.recreate и полная indexAll: facts, sourceNodeId и semantic fingerprint
   совпадают с результатом после sync.

Это подтверждает первую вертикаль вычислений; persistent semantic cache,
автоматическая elaboration при sync и semantic edges в SQLite не добавлены.

## Build и полная матрица

Production build с viewer и 30 grammar assets прошёл.
Полный native: 306 test files, 4932 passed, 9 skipped, 0 failed.
Полный WASM: 305 test files passed, 1 skipped; 4922 passed, 19 skipped, 0 failed.
Матрица выполнена последовательно с двумя workers; 38 focused tests также прошли.

## Оставшиеся границы

Macro-generated source locations могут иметь column 0 (в API null); точная
expansion/spelling chain остаётся B2. Macro-computed include paths и пути вне
project snapshot пока отклоняются. Нет полного type/struct/enum/query coverage,
сохранённого semantic cache и автоматического MCP compiler query. Windows runner
явно отключён до проверки process-tree cancellation; реальные macOS запуски
не выполнялись. Simulation, synthesis, timing/CDC и аппаратные проверки не заявлены.
