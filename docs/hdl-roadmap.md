# План развития Verilog/SystemVerilog

Актуальная очередь, критерии готовности и журнал выполнения: [VERILOG_TRACKER.md](../VERILOG_TRACKER.md). Ниже сохранена история исходных этапов.

## Реализованный пакет после ce13487b

1. Ссылки на основания и индексы LHS bit/part selects и concatenations.
   Приёмка: crc[15], bus[i +: W], {a,b} сохраняют сигналы; hierarchical access,
   package qualifiers и shadowing не создают ложных локальных целей.
2. Именованные подключения instance → formal port целевого модуля.
   Приёмка: .rx(rx1) даёт проверяемый переход к rx нужного uart_rx;
   отсутствующий/чужой порт и неоднозначный module не угадываются.
   Source signature и прежние instance→local references сохраняются.
3. Regression tests, реальные Dual UART/eMMC/AXI, повторная индексация,
   build, проверки backend, push трёх remote и обновление draft PR #1845.

## Реализованный пакет после 7d0321ae

- Позиционные подключения: source-order ports, включая non-ANSI headers,
  пустые позиции и проверку числа формальных портов.
- Wildcard .*: раскрытие только при известном module и доступном локальном
  сигнале; explicit connections имеют приоритет, unknown остаётся unknown.
- tree-sitter-systemverilog 0.4.0: проверка ABI, реальных корпусов и современных конструкций.

## План после 4d97bb29

База: grammar 0.4.0, extraction stamp 35, named/positional/wildcard bindings.
Статус этапов отмечен ниже. Очерёдность учитывает
зависимости: scopes нужны до read/write, build context — до elaboration.

### 1. Уточнить текущие ограничения и закрыть локальные scopes — реализовано

Польза: имя i/x ведёт к правильному объявлению; локальная переменная во
вложенном блоке не скрывает одноимённый сигнал во всём always.

- Разобрать 7 оставшихся ERROR на 137 HDL-файлах: синтаксическая ошибка,
  отсутствие preprocessing context или пробел grammar/extractor. Сохранить
  минимальные воспроизведения; исправлять только подтверждённые дефекты.
- Отдельные scopes для begin/end, fork/join, for/foreach и function/task;
  различать объявления в соседних блоках и время их видимости.
- Genvar и соответствующее имя внутри generate-body представить как
  декларации шаблона, без подстановки выдуманных iteration values.
- Убрать подавление имени на весь process там, где доступна точная область.

Приёмка: nested/sibling scopes, shadow внутри/снаружи цикла, escaped names,
same-line declarations и stable IDs; sync после перемещения объявления даёт
те же связи, что clean rebuild. Реальные UART/CRC/AXI-control examples.

### 2. Разделить синтаксические reads, writes и control dependencies — реализовано

Польза: ответить, какой блок читает сигнал и где код присваивает ему значение.

- LHS/RHS blocking и nonblocking assignments; assign, compound assignments,
  increment/decrement, concatenations и bit/part selects.
- В x[i] = y запись относится к x; чтения — к i и y. Условия if/case/loops,
  RHS и event controls сохраняются раздельно.
- Function/task аргументы классифицировать по известным направлениям;
  при неизвестной сигнатуре сохранять обычную reference.
- Добавить фильтры/объяснения в существующий query/MCP путь и синхронизировать
  server instructions. Форма хранения (edge metadata или новые kinds)
  выбирается после проверки API/wire/schema совместимости.

Приёмка: ручная таблица ожидаемых доступов для небольших настоящих блоков
UART и eMMC CRC; отрицательные controls для package/member/индексов; запросы
по сигналам показывают исходные строки и тип использования. Не называть это
доказательством электрического драйвера, latch или race.

### 3. Явный контекст HDL-сборки — реализован ограниченный source-режим

Польза: различать synthesis/testbench и условные варианты без выбора по имени
директории там, где проект предоставляет точный состав сборки.

- Именованные profiles: source files/filelists, include directories, defines,
  top modules и language mode. Определить минимальный поддерживаемый формат.
- Отразить происхождение профиля и активный профиль в status/query.
- Учитывать include dependencies и условную компиляцию с mapping к исходным
  файлам; unsupported directives возвращают явную неизвестность.
- Изменение define/include/filelist инвалидирует зависимую часть графа.
  Зафиксировать профиль в fingerprint индекса, чтобы состояния не смешивались.

Приёмка: один RTL-корпус под двумя profiles с разными ветками и одинаковыми
именами модулей; смена профиля и изменение включаемого header сходятся с
clean rebuild. Измерить время/объём повторной индексации.

### 4. Семантический слой через HDL-компилятор

Польза: точные parameter overrides, widths/types и elaborated instances.

- Сначала сравнительный прототип доступных HDL frontends на наших корпусах:
  AST/semantic export, source mapping, охват конструкций, стоимость запуска.
- Выбрать адаптер по результатам; source graph сохраняется независимо от
  доступности и успешности компилятора.
- Начальный объём: parameters/localparams, packed/unpacked dimensions,
  typedef/struct/enum и generate conditions/iterations.
- Различать instance-specific значения и исходную декларацию. Результат
  должен содержать provenance: frontend/version/profile/source revision.

Приёмка: сверка типов, ширин и instance paths с выводом frontend на UART,
CRC и параметризованном AXI; отдельные случаи unknown/external definitions.
Изменение параметра через sync не оставляет старый elaborated result.
Не строить собственный полный HDL-компилятор внутри extractor.

### 5. Сквозные пути сигналов и полезные инженерные запросы

Зависит от этапов 2–4.

- Путь signal → expression/port → instance → formal signal с направлениями,
  подтверждёнными декларациями и профилем.
- Учитывать slices/concatenations, interface/modport и instance-specific
  параметры в пределах подтверждённой семантики.
- Показывать неизвестный участок пути и доказательства каждого перехода.
- Примеры приёмки: UART RX до FIFO, вход CRC до crc_out, AXI valid/ready
  через wrapper. Сравнить ответы с ручной трассировкой реальных исходников.

Timing, CDC/RDC, гонки и аппаратную корректность не выводить из такого графа:
для них нужен отдельный анализ и отдельные проверяемые требования.

### 6. Verification-конструкции SystemVerilog

После RTL-навигации: property/sequence/assert/cover, clocking blocks,
bind и связи DUT↔testbench. Затем оценить необходимость class/UVM dispatch
по реальным проектам, а не по общему списку возможностей стандарта.

Приёмка: находить assertion/coverage, относящиеся к выбранному RTL-сигналу,
со ссылками на исходные конструкции. Не заявлять formal proof по AST.

## Проверки и порядок поставки

- Этап 1 реализован; отчёты validation-hdl-scopes-2026-09-12.md и
  validation-hdl-parse-gaps-2026-09-12.md. Этап 2 реализован: validation-hdl-access-2026-09-12.md.
  Этап 3 реализован в ограниченном source-режиме: hdl-profiles.md и
  validation-hdl-profiles-2026-09-12.md. Следующий пакет — этап 4, compiler frontend.
- Для каждого пакета: failing regression → исправление → независимое review
  → focused tests → реальные corpus queries и sync/rebuild comparison.
- Полные native/WASM suites при изменениях общих extraction/resolution/storage
  путей; build и проверка доставки assets. Не повторять широкий прогон после
  успешного результата без новой причины.
- Обновлять extraction stamp и используемые индексы, когда меняется граф;
  фиксировать проверки и ограничения в отдельном validation report.
- Поставлять логическими коммитами; push/PR update — в рамках согласованной
  реализации. Проверять одинаковый SHA во всех запрошенных remote.
- Для новых возможностей стандарта вести таблицу: parse / extract / resolve /
  query / проверенный пример. Версия grammar не равна полному охвату стандарта.
