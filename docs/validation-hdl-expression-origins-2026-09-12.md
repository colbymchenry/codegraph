# Проверка macro origins выражений HDL

Дата: 2026-09-12. База перед пакетом: `13df92be`. Source extraction stamp
остаётся 38; обновлён optional pyslang exporter, нормализация ответа и проверки.

## Новое поведение

`expressionOrigins` хранит уникальные compiler macro-token origins с ролями
initializer, declared-initializer и type. Имя объявления сохраняет собственный
sourceOrigin: прямое имя с macro initializer может иметь корректный sourceNodeId.
Type origins включают доступный declared type syntax и dimensions.

`expressionOriginCoverage` различает checked/not-applicable/unavailable и
command-line для effective initializer. Default после override не выдаётся за
использованное выражение. В частности, pyslang isOverridden недостаточен для -G:
сравниваются нативные syntax ranges и подтверждается synthetic command-line buffer.

Внутренние collapsed macro ranges остаются incomplete. Лимит — 32 origins на
факт, общий budget frames и syntax visits; truncated сообщает ограничение.
Кэш syntax сохраняет wrapper, чтобы повторное использование Python id не
подменило origins. Нормализованные дубликаты удаляются даже после исчерпания
frame budget. Это прямые syntax tokens, не транзитивный анализ всех констант.

## Реальный AXI и отдельный diagnostic wrapper

Исходный `axi_from_mem.sv` revision `da8793b0e3f14c9186c94fac9ed6ec06375c254e`
не изменялся. Для его допустимой elaboration создан отдельный wrapper с корректными
request/response struct types; это новый control, а не исходный AXI test.
Использованы 244 исходные единицы из восстановленного A2 filelist плюс wrapper.
Compilation завершилась без ошибок, с предупреждениями о неподключённых портах.

Через **CodeGraph.getHdlSemantics** проверены:

| Query внутри cg_axi_from_mem_control.dut | Width | Macro range expression spelling в src/axi_from_mem.sv |
| --- | ---: | --- |
| axi_lite_aw_chan_t | 35 | AxiAddrWidth-1, строка 81, колонка 42 |
| axi_lite_w_chan_t | 36 | DataWidth-1 и DataWidth/8-1, 81:68 и 81:91 |
| axi_lite_r_chan_t | 34 | DataWidth-1, 81:68 |

Все три имеют coverage.type=checked, без truncation: 19/26/19 expression origins.
На compiled CLI повторён axi_lite_w_chan_t: width36 и type origins подтверждены.
Compiler frames связывают аргументы с `include/axi/typedef.svh` и внешним вызовом
AXI_LITE_TYPEDEF_ALL на строке 81. В обычных UART/CRC tops нет соответствующих
macro range expressions; они не выдавались за положительные случаи.

Wrapper для воспроизведения в независимой копии A2 (добавить его в profile files,
задать top cg_axi_from_mem_control):

```systemverilog
`include "axi/typedef.svh"
module cg_axi_from_mem_control;
  typedef logic [31:0] addr_t;
  typedef logic [31:0] data_t;
  typedef logic [3:0] strb_t;
  typedef logic [0:0] id_t;
  typedef logic [0:0] user_t;
  `AXI_TYPEDEF_ALL(bus, addr_t, id_t, data_t, strb_t, user_t)
  axi_from_mem #(.MemAddrWidth(32), .AxiAddrWidth(32), .DataWidth(32),
    .MaxRequests(2), .axi_req_t(bus_req_t), .axi_rsp_t(bus_resp_t)) dut();
endmodule
```

## Override, изменение header и восстановление графа

Дополнительный небольшой RTL control: leaf с P=`DEF, экземпляр a переопределяет
P через `OVR, экземпляр b оставляет default.

- Сначала значения 11/7; у a initializer указывает OVR, declared-initializer — DEF.
- После смены header значения 13/9; старые source node links не выдаются до sync.
- После scoped sync и затем recreate+indexAll совпадают facts, sourceNodeId,
  expression origins и semantic fingerprint.

В отдельных реальных helper tests проверен -G: effective initializer имеет
coverage command-line, исходный macro default отдельно declaredInitializer.
Необнаруживаемые compiler syntax данные остаются unavailable.

## Проверки и границы

Целевые TypeScript tests: 40 passed, включая 9 новых expression-origin regressions,
оба CLI selectors, coordinate validation и доставку Python asset. Review нашло
и помогло исправить coercion coverage: JSON array не принимается как enum string.
Неполное/противоречивое покрытие, ложные paths/offsets, duplicate origins и budgets
проверены отрицательными controls.

Реальные Python tests запускать установленным pyslang 11.0.0:

```sh
/path/to/venv/bin/python -I scripts/verify-hdl-source-map-export.py --work-root /path/to/storage
```

Дополнительная проверка non-ANSI портов выявила отдельный случай: dimensions
находятся в internalSymbol.syntax, а не в header PortReference. Это исправлено
и проверено отдельным regression: ANSI и non-ANSI дают один и тот же macro origin
без дубликатов; при неизвестном declarator coverage не объявляется checked.

15/15 проверок с настоящим pyslang прошли после исправления non-ANSI.
Финальный native: 310 test files, 4956 passed, 9 skipped, 0 failed.
Финальный WASM: 309 test files passed, 1 skipped; 4946 passed, 19 skipped, 0 failed.
Матрица выполнена последовательно с двумя workers.
Production build и real API controls прошли; originals не изменялись.
Persistent cache, полная C3 type model, simulation/synthesis/timing и аппаратная
корректность не заявляются. Windows runner остаётся отключён.
