# HDL: лексические scopes и generate declarations

База 4d97bb29; extraction stamp 36. Linux x64, Node 24.15.0,
tree-sitter-systemverilog 0.4.0. Реализован этап 1 из hdl-roadmap.md.

## Изменения

- Named/anonymous begin/end, fork/join, for/foreach получают отдельные scopes.
  Локальный x во вложенном блоке больше не подавляет ссылки на внешний x
  во всём process; соседние блоки сохраняют собственные объявления.
- Function/task formal ports — отдельные поля в scope подпрограммы.
  Сохраняются зависимости defaults и вызовы в for initializers.
- Inline/predeclared genvar и generate-body parameters представлены
  декларациями шаблона. Значения итераций и elaborated instances не придуманы.
- Signal references принадлежат точному lexical block. Calls сохраняют
  function/process owner и дополнительный lexical context для imports.
- Внутренний package import перекрывает внешнюю функцию/импорт; конфликт
  на одном уровне остаётся unresolved. Context сохраняется через SQLite,
  повторное разрешение и удаление/восстановление package function.
- Cross-file HDL edges пересчитываются по исходной qualified reference,
  а не переносятся на произвольный символ того же короткого имени.

При parser recovery внутри procedural региона сигнал не привязывается к
предполагаемому внешнему объявлению. Исходные узлы и независимые корректные
процессы остаются доступны; неполный регион может иметь меньше references.

## Проверки

32 focused tests прошли: scopes/signals/generate/packages/call scope. Review
воспроизвело пропуски defaults/initializers и неверный приоритет imports;
после исправлений повторены 10 независимых scratch controls. Выбор внутреннего
q::f подтверждён также результатом HDL-компилятора на минимальном примере.

Постоянный тест меняет package-файл с одноимёнными p::run/q::run, удаляет и
восстанавливает функцию, сохраняя top без изменений: calls совпадают с clean
rebuild. Отдельные tests проверяют удаление локального shadow и generate sync.

Реальный axi_xbar.sv: 3 generate template declarations, 8 occurrence references;
sync совпадает с clean index. Реальный emmc_crc16.v также проверен через индекс.
Повторены полные Dual UART/eMMC/AXI индексы и настоящие queries по UART ports,
CRC и AXI modport. В AXI сохранились 32 positional и 14 wildcard clauses с
28 formal/actual pairs; контрольная positional-копия UART также прошла.
Все 10 активных индексов: stamp 36, complete, 0 pending changes.
Полный native: 291 test files, 4809 passed, 9 skipped, 0 failed.
Полный WASM: 290 test files passed, 1 skipped; 4799 passed, 19 skipped, 0 failed.
TypeScript и build с viewer/30 grammar assets прошли.

## Остаточные parse errors

Все 7 ERROR классифицированы в validation-hdl-parse-gaps-2026-09-12.md.
Шесть raw conditional-header ошибок исчезают после препроцессинга полного
axi_interleaved_xbar в двух конфигурациях. Assertion macro проверен минимальным
воспроизведением; полный demux требует отсутствующих common_cells includes.
Это подтверждённая граница preprocessing context, а не повод удалять директивы
из исходника. Конфигурации сборки остаются отдельным этапом плана.

Артефакты: .scratch/hdl-scope-final-focused.log,
hdl-generate-real-axi-results.json, hdl-lexical-review-fixed.log,
hdl-lexical-corpus.log, hdl-lexical-real-bindings.log, hdl-lexical-final-*.log.
