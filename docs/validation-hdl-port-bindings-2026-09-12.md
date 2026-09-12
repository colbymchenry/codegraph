# HDL: именованные порты и выбранные биты

База ce13487b; extraction stamp 34. Linux x64 / Node 24.15.0.

## Изменения

- Отдельный property node для каждого named connection: top::u_rx1::rx.
  Его signature сохраняет .rx(rx1), а references показывают локальный rx1 и
  formal uart_rx::rx. Formal edge имеет metadata binding=hdl-named-port.
- Shorthand .rx поддерживается, explicit empty .rx() имеет только formal
  endpoint. Массив экземпляров остаётся одной source declaration.
- Module selection согласован с прежним instantiates (synthesis/testbench),
  но formal port binding строже: равнозначные definitions, duplicate module
  в одном файле и отсутствующий порт остаются unresolved. Чужой одноимённый
  порт не подставляется. Повторная индексация удаляет исчезнувшую цель. Обычный sync также
  удаляет и восстанавливает formal endpoint при неизменном top; failed refs
  повторно ищутся по имени порта из структурированного reference token.
- LHS bit/part selects и concatenations дают references на основания,
  индексы и границы AST. Package/hierarchical members не превращаются в
  одноимённые local signals. For/foreach locals подавляются при shadowing.

Это source correspondence. Нет bit-level netlist, drive direction, evaluation
диапазонов или выбора generate branch. Wildcard/positional connections пока
сохраняются исходным текстом. Дальнейшие этапы описаны в hdl-roadmap.md.

## Проверки

Постоянные regressions: 7 port binding tests и 12 signal tests прошли.
Независимое ревью воспроизвело и затем подтвердило исправление p::x слева
от procedural assignment и справа с индексом; корректные a/n/y сохранены.
Два исходных квалифицированных примера проходят Verilator lint-only.

На неизменённых копиях Dual UART/eMMC reader/AXI выполнены настоящие
codegraph_explore queries: top.u_rx1.rx top.u_rx2.rx, emmc_crc16.crc,
axi_atop_filter_intf.mst. SQLite показывает две стороны подключений UART:
top::u_rx1::rx → uart_rx::rx и top::rx1; аналогично u_rx2/rx2.
Для реального emmc_crc16 AST подтверждает crc на LHS выбранного бита
(позиция строки/колонки), а SQLite — сохранённую ссылку на crc на этой строке.

| Корпус | Файлы | Named connections | Связи от connections | Index + query |
|---|---:|---:|---:|---:|
| Dual UART | 11 | 86 | 172 | 0.683 с |
| eMMC reader | 33 | 560 | 1070 | 1.261 с |
| AXI | 104 | 3411 | 4023 | 1.958 с |

Количество связей не обязано равняться удвоенному числу подключений:
пустые порты, сложные выражения и отсутствующие внешние модули различаются.

Выполнено source review с отрицательными controls swap .a(b)/.b(a),
package constants/casts, missing/fuzzy/duplicate module, scope shadows.
Полный native: 284 test files passed, 4756 passed, 9 skipped, 0 failed.
Полный WASM: 283 test files passed, 1 skipped; 4746 passed, 19 skipped, 0 failed.
TypeScript и сборка с viewer/30 grammar assets прошли.
Все 10 активных индексов пересобраны до stamp 34; readback complete, 0 pending.

Артефакты: .scratch/hdl-ports-real-results.json, hdl-ports-explore-*.txt,
hdl-port-binding-sync-final-tests.log, hdl-review-fixed.log,
hdl-ports-final-*.log. Копии реальных RTL вне Git в ~/storage.
