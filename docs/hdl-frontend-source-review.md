# HDL frontend: проверка первичных источников

Дата проверки: **2026-09-12**. Это входные данные для A3/A5, а не выбор победителя:
качество и стоимость на наших проектах определяет отдельный benchmark.

## Версии и платформы

| Frontend | Официальный релиз на дату проверки | Локальное наблюдение Linux |
| --- | --- | --- |
| slang | [v11.0, 2026-05-15](https://github.com/MikePopoloski/slang/releases/tag/v11.0) | `slang version 11.0.448+e222e7dc0`: development build, не чистый release artifact v11.0 |
| Verilator | [v5.052, 2026-09-05](https://verilator.org/guide/latest/changes.html#verilator-5-052-2026-09-05) | `Verilator 5.051 devel rev v5.050-260-g1c9a9e0cc (mod)`: другая, более ранняя development/vendor build |
| Surelog + UHDM | [Surelog v1.87](https://github.com/chipsalliance/Surelog/releases/tag/v1.87) и [UHDM v1.87](https://github.com/chipsalliance/UHDM/releases/tag/v1.87), оба опубликованы 2026-08-24 | Исполняемые `surelog`/`uhdm-dump` не найдены в PATH и проверенном OSS CAD Suite; runtime не проверен |

Версии и help двух установленных инструментов повторно прочитаны из
`/home/danik/storage/toolchains/oss-cad-suite-20260825/bin/`.
Локальный help подтверждает slang `--ast-json`, `--ast-json-source-info`, `--cst-json`
и Verilator `--json-only` с отдельным meta-output. Эта проверка **не** подтверждает
совместимость всего API или результаты elaboration. Новые сборки, установки,
Windows/macOS и симуляция в рамках этого обзора не запускались.

Официальный релиз slang v11.0 содержит ровно три бинарных assets:
`slang-linux-x86_64.tar.gz`, `slang-macos-arm64.tar.gz`,
`slang-windows-x86_64.zip`. Linux ARM64/macOS x86_64 в этом перечне отсутствуют.
[Release assets](https://github.com/MikePopoloski/slang/releases/tag/v11.0).
Текущие build docs описывают GCC/Clang/Xcode/MSVC и C++20; это документация текущего
дерева, её требования нельзя автоматически переносить на установленный snapshot.
[Сборка slang](https://sv-lang.com/building.html).

Verilator документирует основной Linux workflow и дополнительные платформы
macOS/Windows MSVC; FAQ отдельно рекомендует WSL2 и слабее обещает проверку других
Windows-вариантов. Это поддержка проекта, а не проверенный нами Windows package.
[Installation](https://verilator.org/guide/latest/install.html#os-requirements),
[Windows FAQ](https://verilator.org/guide/latest/faq.html#does-verilator-run-under-windows).
Surelog/UHDM заявляют Linux, Windows MSYS2/MSVC и macOS; в проверенных releases v1.87
нет загруженных авторами бинарных assets, только стандартные source archives.
[Surelog](https://github.com/chipsalliance/Surelog),
[UHDM](https://github.com/chipsalliance/UHDM).

## Контракт данных и координаты

**slang.** CLI предлагает compiled AST JSON, выбор scope, source-info, detailed types
и CST JSON с токенами/trivia. Source-info обещает файл и строку; это не обещание
полной macro-provenance в каждом JSON node.
[CLI JSON output](https://sv-lang.com/command-line-ref.html#json-output).
Библиотечный `SourceManager` хранит отдельные source/macro buffers, origin и место
раскрытия; `SourceLocation` содержит BufferID и **byte offset**. SourceManager должен
жить дольше объектов, использующих его память. Для CodeGraph потребуется проверенная
конвертация byte→UTF-16 и явное различение spelling/expansion locations.
[Source Management](https://sv-lang.com/sourcemanagement.html).

Стабильная межверсионная JSON schema/ABI в просмотренной документации slang не
обещана. У v11.0 есть перечисленные breaking changes C++/Python API, включая
ASTVisitor и организацию pyslang imports. Вывод для адаптера: зафиксировать
бинарную версию/хеш и golden fixtures; не объявлять любой `11.x` совместимым без
проверки. [Release notes v11.0](https://github.com/MikePopoloski/slang/releases/tag/v11.0).

**Verilator.** Официально предназначенный для downstream инструментов `--json-only`
отключает часть агрессивных преобразований, но отдаёт конечную стадию AST; это не
обещание неизменённого CST. Документация прямо предупреждает, что JSON формат
эволюционирует. [CLI contract](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-json-only).
Нужно читать **оба** файла: `.tree.json` и `.tree.meta.json`; `loc` кодирует file-id,
начальную/конечную строку и колонку с исключённой правой границей. Meta разрешает
file-id в filename/realpath и содержит pointer metadata. Отсутствующий boolean
не следует путать с отсутствующим обязательным объектом: false-поля не печатаются.
Поля узлов описаны исходниками `V3AstNodes.cpp`, а не независимой неизменяемой schema.
[Официальный internals.rst](https://github.com/verilator/verilator/blob/master/docs/internals.rst#treejson-output).

**Surelog/UHDM.** Основной interchange — сериализованный `surelog.uhdm` и VPI/C++ API;
`uhdm-dump` — человекочитаемый dump, не документированный стабильный JSON protocol.
Нельзя просмотреть только `allModules` и заявить полную схему: folded model разделяет
definitions и elaborated `topModules`; generate logic и окончательные типы находятся
в elaborated view. Есть дополнительная full elaboration/uniquification.
[Модель и навигация UHDM](https://github.com/chipsalliance/UHDM#model-concepts).
Surelog Python AST API не является post-elaboration API; для последнего используется
UHDM/VPI, включая отдельные UHDM Python bindings.
[Surelog API](https://github.com/chipsalliance/Surelog#python-api).

UHDM `BaseClass` имеет file/start/end line и column поля; columns в просмотренном
шаблоне — `uint16_t`. Гарантию всех macro expansion цепочек из этих полей вывести
нельзя; длинные строки и generated/include provenance требуют отдельных fixtures.
[BaseClass](https://github.com/chipsalliance/UHDM/blob/master/templates/BaseClass.h).
Surelog v1.87 явно согласует номер UHDM и pkg-config dependency; совместимость
произвольных writer/reader snapshots этим не гарантируется. Адаптер должен
фиксировать **пару** Surelog/UHDM и проверять restore на своих fixtures.
[Связанные версии](https://github.com/chipsalliance/Surelog/releases/tag/v1.87).

## Лицензии и упаковка

| Компонент | Документированная лицензия | Практическое ограничение redistribution |
| --- | --- | --- |
| slang | [MIT](https://github.com/MikePopoloski/slang/blob/v11.0/LICENSE) | Сохранять copyright и текст разрешения; MIT самого проекта не заменяет notices всех включённых зависимостей. |
| Verilator | [LGPL-3.0-only OR Artistic-2.0](https://github.com/verilator/verilator/blob/v5.052/README.rst#open-license) | Выбрать и выполнить условия одной лицензии; нельзя перелицензировать сам frontend в MIT. Для распространяемых модификаций upstream FAQ требует открытый исходный код. [FAQ](https://verilator.org/guide/latest/faq.html#will-verilator-output-remain-under-my-own-license-copyright). |
| Surelog и UHDM | [Surelog Apache-2.0](https://github.com/chipsalliance/Surelog/blob/master/LICENSE), [UHDM Apache-2.0](https://github.com/chipsalliance/UHDM/blob/master/LICENSE) | Передавать LICENSE, сохранять применимые notices, отмечать изменённые файлы и передавать NOTICE, если он есть в распространяемой работе; условия третьих сторон проверяются отдельно. |

У Verilator верхний `LICENSE` содержит LGPL; альтернативная Artistic-лицензия
подтверждается README/SPDX и отдельным
[LICENSES/Artistic-2.0.txt](https://github.com/verilator/verilator/blob/v5.052/LICENSES/Artistic-2.0.txt).
Локальная пометка `(mod)` не раскрывает перечень vendor patches. Обзор не является
аудитом полного redistribution комплекта OSS CAD Suite; текущий suite целиком
не выбран для включения в CodeGraph.

## Ограничения будущего адаптера

Это инженерные выводы из проверенных контрактов, не обещания готовой интеграции:

- Нормализовать в собственный versioned graph contract, сохраняя frontend version,
  hash/profile, diagnostics и evidence level; не хранить compiler memory addresses
  как устойчивые CodeGraph IDs.
- Проверять каждый frontend на одинаковом профиле: порядок источников, compilation
  units, defines, includes, tops, language mode и неизвестные модули. У slang по
  умолчанию отдельные compilation units; `--single-unit` меняет семантику.
  [Compilation flags](https://sv-lang.com/command-line-ref.html).
- Передавать сформированный разрешённый argv, а не произвольный исходный command
  file. Например, Surelog документирует `-exe` и Python evaluation/listener hooks;
  это исполняемые действия. Для ограниченного runner учитывать `-nopython` и запрет
  таких опций. [Surelog CLI](https://github.com/chipsalliance/Surelog#surelog-commands).
- Отдельно измерить wall time, peak RSS, объём AST, startup, source-location fidelity,
  точность hierarchy/port bindings и deterministic повтор. В этом документе нет
  сравнительных измерений и нет решения, какой frontend станет основным.

Сохранённые локальные справочные результаты: `.scratch/hdl-frontend-sources/`
(release REST readbacks и local versions), `.scratch/hdl-source-slang-help.txt`,
`.scratch/hdl-source-verilator-help.txt`. Проверенные ссылки выше — первичные
репозитории и документация авторов; страницы `/latest`/`master` могут измениться.
