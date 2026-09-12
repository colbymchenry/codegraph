# Выбор HDL frontend: slang для первого semantic adapter

Дата: 2026-09-12. Пакет A3–A6 трекера. База CodeGraph: `ced3a063`, extraction
stamp 38. Это решение о следующей реализации; compiler semantics ещё не
подключена к production graph.

## Решение

Первый адаптер строить поверх **slang**, как необязательного отдельного процесса.
Начальная вертикаль: один profile/top, evaluated parameters и тип/ширина порта
со ссылкой на исходное объявление. Verilator сохранить как независимый compiler
control. Второй production adapter пока не писать.

Основание — реальные UART, eMMC CRC и восстановленный AXI, одинаковые явные
source lists/defines/top/parameter overrides для сравниваемых инструментов.
Slang экспортирует Parameter.value, структурированные types и elaborated Instance/
GenerateBlockArray; из них проверяемо восстанавливаются instance paths. На этих
локальных controls slang использовал меньше CPU wall time и peak RSS, но его
подробный JSON больше. Это аргумент для ограниченного прототипа, не обещание
скорости/охвата на любом проекте.

[Проверка официальных версий, лицензий и платформ](hdl-frontend-source-review.md)
содержит первичные ссылки. Измерены установленные slang `11.0.448+e222e7dc0` и
Verilator `5.051 devel v5.050-260-g1c9a9e0cc (mod)` из OSS CAD Suite 20260825.
Они не равны опубликованным releases; в частности, актуальный Verilator 5.052
в этом benchmark не запускался. Перед поддержкой release artifact повторить
contract tests на его точной версии.

Surelog/UHDM изучен по официальной модели/API: потребует отдельной установки,
согласованных writer/reader versions и адаптации elaborated topModules/VPI.
В проверенной среде binary отсутствует, runtime сравнение не проводилось.
Первый адаптер не требует его для подтверждённых задач. Yosys отдельно не
измерялся: текущая цель — source semantics SystemVerilog, синтез будет другой задачей.

## Метод и результаты

Скрипт `scripts/hdl-frontend-compare.py`: шесть controls × два frontend × два
последовательных запуска = **24**. GNU time измеряет время процесса и peak RSS;
таблица показывает медиану времени и максимальный RSS двух запусков. Это
локальный warm-cache smoke benchmark, без очистки filesystem cache, не статистический
вывод для всех проектов. Время имеет точность GNU time 0.01 с. AST sizes — полные
JSON dumps с разными schema/настройками, не нормализованные semantic payloads.

| Контроль | slang exit / время / RSS | Verilator exit / время / RSS |
| --- | --- | --- |
| UART top, strict | 1 / 0.02 с / 14 300 KiB | 0 / 0.07 с / 15 596 KiB |
| UART top, explicit compatible | 0 / 0.02 с / 14 300 KiB | 0 / 0.075 с / 15 504 KiB |
| eMMC CRC16 | 0 / 0.01 с / 10 888 KiB | 0 / 0.07 с / 14 508 KiB |
| AXI xbar, NoSlvMst=2 | 0 / 0.145 с / 58 716 KiB | 0 / 0.60 с / 91 748 KiB |
| AXI xbar, NoSlvMst=4 | 0 / 0.16 с / 67 664 KiB | 0 / 0.62 с / 93 172 KiB |
| Card-reader board, missing rPLL | 1 / 0.075 с / 38 008 KiB | 1 / 0.085 с / 19 280 KiB |

UART strict: slang сообщает 9 use-before-declaration errors. В отдельном
compatible control только slang получает явно записанный `--allow-use-before-declare`;
RTL не исправляется и strict failure не скрывается. Это отличается от автоматического
ослабления всех проверок. Board control намеренно неполон: нет vendor primitive rPLL;
оба frontend отвергают его. Slang дополнительно сообщает другие исходные ошибки.

На AXI оба получают один filelist Bender из A2, включая TARGET_SYNTHESIS,
TARGET_SYNTH_TEST, TARGET_VERILATOR. Их встроенные predefines остаются различными.
Дополнительный probe slang с VERILATOR=1 меняет macro branch и предупреждения;
в основной таблице это послабление не добавлялось. Нельзя считать одинаковые
явные arguments доказательством одинакового compiler environment.

Все expected outcomes совпали. На AXI slang оставляет 1 warning, Verilator 10;
UART compatible Verilator оставляет 7. Использован Verilator `-Wno-fatal`.
Это JSON export/elaboration controls; результаты не означают simulation, synthesis,
отсутствие RTL warnings или работоспособность FPGA.

## Проверенные данные для адаптера

- У обоих tools автоматические assertions подтвердили UART CLK_FREQ=50000000,
  наличие u_rx1/u_rx2, CRC crc_out `[15:0]`, AXI NoSlvMst=2/4. Source locations
  сверены с реальной строкой объявления, а не только наличием поля в JSON.
- Slang probe восстановил 7 UART instances, including top, параметры обоих
  UART receivers и CLKS_PER_BIT=54. Для AXI — 92/182 reachable instances и
  generate indices 0..1 / 0..3. Instance body может быть ссылкой на ранее
  сериализованный addr; нужна общая таблица объектов, а не только рекурсивный
  обход inline body.
- GenerateBlockArray содержит и genvar, и анонимные blocks. Нужно учитывать
  implicit iteration parameter и исключать isUninstantiated blocks.
- Slang JSON source info даёт declaration coordinates и ranges выражений;
  в проверенном statement control конец диапазона exclusive, coordinates 1-based.
  Это не доказательство полного macro expansion source map. Byte/UTF16 conversion
  и цепочки macro/include provenance требуют отдельных contract fixtures в B2.
  Реальные macro-generated AXI typedefs указывают invocation line 415–421, но
  column=0: это unknown column, не первая колонка. JSON не дал точную expansion/
  spelling chain; для B2 оценить небольшой exporter через slang SourceManager,
  если CLI metadata недостаточно. До этого не заявлять полный source mapping.
- Verilator JSON требует `.meta.json` для расшифровки loc file IDs, dtypep/modp
  references — отдельной адресной таблицы. Адреса обоих AST не являются stable IDs.
- Slang создаёт JSON даже при exit 1: failed/partial artifact не публиковать как
  актуальный semantic graph. В benchmark поля такого AST не считаются успешными.
- AXI2 detailed slang AST ≈12.5 MB, Verilator ≈1.6 MB; AXI4 ≈15.2/1.9 MB.
  Подробный dump нельзя без ограничений включать в MCP-ответ или source Git.

## Контракт следующего адаптера

1. Вход: canonical project root, source snapshot hashes, явный ordered filelist,
   includeDirs, defines, dialect, top и overrides. Default строгий; compatibility
   flags только явно и входят в fingerprint. Не исполнять произвольные флаги из
   чужого build script и не менять конфигурацию при compiler errors.
2. Запуск: отдельный process, разрешённый executable/version, timeout/cancel,
   пределы stdout/JSON/RSS. При отсутствии tool остаётся source graph. Никаких
   обязательных native/npm dependencies и автоматического скачивания frontend.
3. Импорт: validate schema/version, exit status и diagnostics; разрешить object
   references, сохранить declaration и instance identity отдельно. Store только
   необходимые нормализованные facts, raw dump — вне Git/индекса.
4. Координаты: source bytes и revision должны совпасть с snapshot. Проверить
   CRLF/Unicode, macro definitions/invocations и generated ranges; unresolved
   mapping показывать явно. Не назначать строку expansion другому source file.
5. Provenance: exact executable version/hash, semantic schema version, profile,
   implicit/explicit compiler flags, sources/dependency digest и top/overrides.
   Unsupported tool/schema → понятный отказ semantic layer, source API работает.
6. Публикация: новый semantic context становится видимым целиком после успешного
   импорта. Failure/cancel сохраняет source graph; старый semantic context stale.
7. Приёмка минимальной вертикали: params/width query на UART/CRC/AXI, два instances
   с разными values, profile/parameter/include change и sync/clean parity,
   missing frontend и invalid compiler output controls.

## Воспроизведение

Сначала A1 manifest check и A2 restoration из
`validation-hdl-corpora-build-2026-09-12.md`. Использовать новый пустой output:

```sh
python3 scripts/hdl-frontend-compare.py \
  --corpus-root /absolute/path/to/corpora \
  --axi /absolute/path/to/axi-isolated \
  --filelist /absolute/path/to/axi-isolated/build/controls/verilator.f \
  --slang /absolute/path/to/slang \
  --verilator /absolute/path/to/verilator \
  --output /absolute/path/to/new-empty-output --runs 2
```

Runner проверяет pinned revisions, A2 filelist hash, tracked inputs и отсутствие
untracked/include shadow files. Перед/после snapshot должен совпасть. Output
каталог должен быть пуст, чтобы не принять старый JSON. При timeout/interrupt
убивается собственная process group. Raw AST/logs сохраняются в output;
машиночитаемый итог этой проверки — `hdl-frontend-comparison.json`, дополнительный
semantic probe — `hdl-slang-semantic-probe.json`.

Проверка выполнена на Linux; Windows/macOS availability изучена по официальным
источникам, реальные запуски этих ОС не выполнялись. GNU time runner — Linux
validation helper, не production cross-platform subprocess layer.

Следующее действие: B1/B2 + C1/C2 минимальная вертикаль slang. Полный preprocessing,
source mapping macros, API integration и автоматическая semantic invalidation
этим сравнением не объявлены реализованными.

Независимое review выявило и помогло исправить cleanup при прерывании и
untracked include shadowing. Повторные controls подтвердили завершение child
process и отклонение untracked/symlink headers. Engine не изменялся; полные
native/WASM suites не повторялись. Python syntax/JSON/diff проверены.
