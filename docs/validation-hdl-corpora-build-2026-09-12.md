# HDL: manifest корпусов и восстановленный AXI build context

Дата: 2026-09-12. Пакет A1/A2 из `VERILOG_TRACKER.md`.
CodeGraph до этого пакета: `d8921aa7`, extraction stamp 38.
Runtime extractor и формат индекса этим пакетом не меняются.

## A1. Manifest корпусов

`hdl-corpus-manifest.json` фиксирует UART, eMMC/CRC и AXI: происхождение,
revision, состав источников, SHA256, evidence build profiles и ограничения.
Скрипт `scripts/hdl-corpus-manifest.py` позволяет проверить копию корпуса;
проверено 137 HDL-файлов: UART 11, eMMC/CRC 33, AXI 93.
Проверка всех трёх корпусов и build/license evidence дала 0 расхождений.
Отрицательные controls change/add/remove и возврат к исходному состоянию прошли.
Сами RTL-корпуса в CodeGraph Git не добавлены.

UART и AXI целиком совпадают с указанными Git revisions. У card-reader 32 из
33 файлов совпадают с revision; `sim/tb_uart_bridge_debug.v` взят из локального
working tree и закреплён отдельным SHA256. Одной Git revision недостаточно,
чтобы восстановить этот дополнительный файл; frozen corpus сохранён отдельно.
Лицензия UART/card-reader не установлена по файлам репозиториев. Для AXI
зафиксированы LICENSE Solderpad 0.51 и исходные SPDX markers.

Пример проверки сохранённого corpus (без исполнения его build recipes):

```sh
python3 scripts/hdl-corpus-manifest.py check \
  --corpus-root /absolute/path/to/corpora \
  --manifest docs/hdl-corpus-manifest.json
```

Для проверки оригинальных build/license files добавить `--origin dual-uart=PATH`,
`--origin card-reader=PATH`, `--origin axi=PATH`. При generate те же arguments
фиксируют provenance. Профили manifest предназначены для source-graph validation;
они не объявлены полной compiler closure. Literal dependencies собраны отдельно
от результатов preprocessing/elaboration.

## A2. Восстановление AXI

Использован upstream AXI `da8793b0e3f14c9186c94fac9ed6ec06375c254e`.
В отдельной копии `bender checkout` восстановил зависимости из существующего
`Bender.lock`; команда `bender update` не применялась.

| Dependency | Точная revision |
| --- | --- |
| common_cells | `03d98106aa19952a10360d2230def85144a0008b` |
| common_verification | `fb1885f48ea46164a10568aeff51884389f67ae3` |
| tech_cells_generic | `3a3de73632a06826b1bd9c65a0a2e92b32016845` |

Bender **0.32.1**, release binary x86_64 Linux проверен по SHA256 asset.
Verilator **5.051 devel, v5.050-260-g1c9a9e0cc (mod)** из установленного
OSS CAD Suite 20260825. Это точная локальная версия, не утверждение о latest.

[Официальный workflow Bender](https://github.com/pulp-platform/bender): checkout
использует lockfile, script генерирует входные файлы для инструмента.
[Использованный release Bender](https://github.com/pulp-platform/bender/releases/tag/v0.32.1).

### Воспроизведение

Понадобятся Git, Python >=3.9, Bender и Verilator. Корпус и generated output размещать
в каталоге данных, например `~/storage`. Использовать новый isolated checkout:

```sh
git clone https://github.com/pulp-platform/axi.git "$HOME/storage/axi-hdl-control"
git -C "$HOME/storage/axi-hdl-control" checkout --detach da8793b0e3f14c9186c94fac9ed6ec06375c254e
python3 scripts/hdl-axi-build-check.py \
  --axi "$HOME/storage/axi-hdl-control" \
  --bender /absolute/path/to/bender \
  --verilator /absolute/path/to/verilator \
  --output "$HOME/storage/axi-hdl-control/build/controls"
```

Скрипт отклоняет другую revision, правки tracked sources и `Bender.local`
overrides, проверяет dependency revisions и tracked cleanliness. Bender получает явный
`--dir`; generated source/include paths должны оставаться внутри checkout.
Контроль с `BENDER_DIR=/no/such/project` прошёл все шесть сценариев. Сохраняет
команды, tool versions, нормализованный filelist/hash, stdout/stderr каждого
прохода и JSON-отчёт. Снимок всех 152 tracked AXI inputs до/после должен совпасть.
Содержимое locks и исходников script не исправляет.

### Compiler controls

Filelist сгенерирован `bender script verilator -t synth_test`; он включает
upstream sources и transitive dependencies. Defines от Bender фиксируются
в отчёте. Это compiler control, не подмена CodeGraph profile и не выбор
production semantic adapter.

| Контроль | Результат |
| --- | --- |
| `axi_demux_simple` preprocessing без common_cells include path | Ожидаемый exit 1, отсутствуют common_cells headers |
| Тот же файл с восстановленным include path, default | Exit 0, исходный module присутствует, register macros раскрыты |
| Тот же файл, define VCS | Exit 0, macro/include preprocessing выполнен |
| Upstream `synth_axi_lite_xbar`, `NoSlvMst=1` | Lint/elaboration exit 0, 9 warnings |
| Тот же top, `NoSlvMst=2` | Lint/elaboration exit 0, 14 warnings |
| Тот же top, `NoSlvMst=4` | Lint/elaboration exit 0, 12 warnings |

Предупреждения сохранены: PINMISSING, WIDTHEXPAND, WIDTHTRUNC, а в отдельных
конфигурациях SPLITVAR/UNOPTFLAT. Использован `-Wno-fatal`, поэтому exit 0
не означает отсутствие предупреждений или доказанную корректность RTL.
Включён `--assert`; simulation, synthesis, весь `axi_synth_bench` и аппаратная
проверка FPGA не выполнялись. RTL upstream не исправлялся.

Полный машиночитаемый результат: `hdl-axi-build-validation.json`.
Следующий этап A3–A6: сравнение frontends на общей manifest-базе. Наличие
успешного Verilator control не закрывает выбор frontend или интеграцию semantics.

## Проверки пакета

Manifest generate повторён с byte-identical результатом; check всех трёх
корпусов и original build/license evidence — exit 0. В независимой копии
clean/change/add/remove/restore дали ожидаемые exits 0/1/1/1/0.
Python syntax, JSON parsing и whitespace проверены. Независимое review нашло
и помогло исправить перенаправление Bender через окружение; повторный control
подтвердил исправление. Полные native/WASM suites не повторялись: этот пакет
добавляет внешние validation scripts, manifest и docs, без изменений engine.
