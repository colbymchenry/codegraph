# Остаточные ошибки разбора HDL: 2026-09-12

Все **7 `ERROR` в 2 файлах** из корпуса 137 HDL-файлов связаны с обработкой
исходного текста до препроцессора. Невалидность RTL этими ошибками не доказана.
Шесть ошибок исчезают после настоящего препроцессора на полном исходном файле;
седьмая воспроизведена и устранена препроцессором на минимальном валидном примере.
Полная сборка AXI и аппаратная проверка в этот аудит не входят.

## Объект проверки

- Корпус: `dual-uart` — 11 файлов, `card-reader` — 33, `axi` — 93.
  В первых двух проектах `ERROR` и `MISSING` отсутствуют по сохранённому сравнению
  `.scratch/grammar-v040/compare.json` от 2026-09-12.
- AXI revision: `da8793b0e3f14c9186c94fac9ed6ec06375c254e`.
- Грамматика: `tree-sitter-systemverilog` v0.4.0, release commit
  `aa09b9004478cea0f46d877608910dc153b277b6`, ABI 15.
- SHA-256 WASM: `52e470eacf2a87af5056fe054c081d4495d1da72f5d0a9bb0d431e111ee8f235`.
- Node `v24.15.0`, `web-tree-sitter` `0.25.10`, запуск с `--liftoff-only`.
- Компилятор контрольных примеров: `Verilator 5.051 devel rev v5.050-260-g1c9a9e0cc (mod)`
  из OSS CAD Suite 20260825.

Старая и новая грамматики дают одинаковые 7 `ERROR`, `MISSING` — 0.
В этом аудите повторно разобраны оба проблемных исходника новой грамматикой;
их SHA-256 совпадают с исходным сравнением:

| Файл AXI | SHA-256 |
| --- | --- |
| `src/axi_demux_simple.sv` | `f0beea644e9b4721046e27fb1179e9a1f481a1767a52092fe5ee7a1b3d287d08` |
| `src/axi_interleaved_xbar.sv` | `c3673eab4a89a5c9395d75630e959c5fda383653a21d0970d2347a25f80c8959` |

## Классификация всех семи ERROR

Номера строк — 1-based, в исходном AXI checkout.

| Файл и строки | Ошибочный фрагмент AST | Причина и проверка |
| --- | --- | --- |
| `axi_demux_simple.sv:510` | `>` в `ASSUME(... |-> ...)` | Макроаргумент содержит property expression. Грамматика пытается разобрать его до раскрытия макроса. Минимальный пример ниже точно повторяет `ERROR >`; после `-E` AST чистый, Verilator lint проходит. |
| `axi_interleaved_xbar.sv:54–55` | директива `else` перед `input logic` | Альтернативные ANSI-порты внутри `ifdef VCS`. Обе отдельные конфигурации полного файла успешно препроцессируются и разбираются. |
| `axi_interleaved_xbar.sv:55–56` | `default_mst_port_i` и `endif` | Продолжение той же условной декларации порта; отдельного дефекта RTL не установлено. |
| `axi_interleaved_xbar.sv:323` | `ifdef VCS` | Условное добавление `localparam` в parameter port list. Обе конфигурации после препроцессора дают чистый AST. |
| `axi_interleaved_xbar.sv:325–326` | тернарное выражение и `endif` | Продолжение условного параметра, а не отдельная ошибка `$clog2` или cast. Минимальный пример отдельно принят компилятором. |
| `axi_interleaved_xbar.sv:337–338` | директива `else` перед `input logic` | Повтор условного ANSI-порта в interface wrapper. Обе конфигурации полного файла проверены. |
| `axi_interleaved_xbar.sv:338–339` | `default_mst_port_i` и `endif` | Продолжение той же условной декларации interface wrapper. |

Это ограничения грамматики на непрепроцессированном SystemVerilog и отсутствие
выбранного preprocessing profile в текущем индексаторе. Отсутствующий файл include
не создаёт эти шесть ошибок xbar: для полного `axi_interleaved_xbar.sv` достаточно
существующего `axi/include`, и `Verilator -E` завершился с кодом 0 как без `VCS`,
так и с `+define+VCS`. Полученные два полных текста имеют **0 ERROR / 0 MISSING**.
Это проверка preprocessing + parsing, не полная elaboration зависимого проекта.

Для полного `axi_demux_simple.sv` препроцессор остановился на отсутствующих в данном
корпусе `common_cells/assertions.svh` и `common_cells/registers.svh` (exit 1).
Нельзя считать этот полный файл проверенным компилятором или подставлять заглушки
и выдавать результат за проверку настоящей конфигурации. Класс ошибки на строке 510
подтверждён отдельным самодостаточным примером.

## Самодостаточные контрольные примеры

Примеры ниже созданы для диагностики; это не скопированные AXI модули.

Макроаргумент с property implication, до preprocessing — ровно `ERROR >`:

```systemverilog
`define ASSUME(name, expression) name: assume property (@(posedge clk) expression);
module top(input clk, input Support, input valid, input [5:0] atop);
  `ASSUME(no_error, !Support && valid |-> atop == '0)
endmodule
```

Альтернативные ANSI-порты, до preprocessing — два `ERROR`:

```systemverilog
module top(
`ifdef VCS
  input logic [3:0] port_i
`else
  input logic [7:0] port_i
`endif
);
endmodule
```

Условный параметр с разделяющей запятой, до preprocessing — два `ERROR`:

```systemverilog
module top #(
  parameter int A = 2
`ifdef VCS
  , localparam int Width = (A == 1) ? 1 : unsigned'($clog2(A))
`endif
)(input logic clk);
endmodule
```

Для каждого из трёх примеров выполнены обе конфигурации, без define и с
`+define+VCS`: `verilator -E -P` — exit 0;
`verilator --lint-only --assert -Wno-fatal` — exit 0, stderr пустой;
повторный tree-sitter parse раскрытого текста — 0 ERROR / 0 MISSING.
Итого шесть успешных compile/lint controls. Симуляция не выполнялась.

Воспроизведение на сохранённых диагностических файлах из корня checkout:

```bash
node --liftoff-only .scratch/hdl-parse-gaps/check.cjs
python3 .scratch/hdl-parse-gaps/full-preprocess.py
```

Основные локальные доказательства: `.scratch/hdl-parse-gaps/results.json`,
`full-preprocess.json`, `expanded-parse.json`, три `.sv` и раскрытые `.expanded.sv`.
Они исключены из Git; исходники минимальных примеров приведены в этом документе.

## Безопасные следующие шаги

1. Для макровызовов — исправление upstream grammar, которое воспринимает аргументы
   как сбалансированный непрозрачный текст, включая property operators, строки,
   комментарии и вложенные скобки. Нельзя интерпретировать макроаргумент как обычное
   expression и терять часть `|->`.
2. Для условных header lists — поддержка conditional directive nodes в грамматике
   либо явный preprocessing profile с include paths и defines. Пока ветка не выбрана,
   порядок и состав портов неопределённы; named/positional/wildcard связывание не должно
   превращать несовместимые ветки в один достоверный интерфейс.
3. Если добавлять внешний препроцессор, сохранить mapping раскрытого текста к исходным
   файлам, fingerprint профиля и зависимостей include/define для incremental invalidation.
   Без этого улучшенный parse будет показывать неверные строки и устаревшие связи.
4. Отдельно отображать parser recovery и отсутствие preprocessing context, не называть
   `ERROR` доказательством дефекта RTL. Простое удаление строк `ifdef/else/endif`
   объединит взаимоисключающие ветки; такой обход здесь не применялся.

Правки грамматики, parser/extractor и постоянные regression tests в этом аудите
не выполнялись. Установлен воспроизводимый preprocessing/grammar gap, а не новый
дефект обработки уже корректного AST экстрактором.
