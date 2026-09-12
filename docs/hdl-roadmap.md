# План развития Verilog/SystemVerilog

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

## Последующие пакеты

- Позиционные подключения: source-order ports, включая non-ANSI headers,
  пустые позиции и проверку числа формальных портов.
- Wildcard .*: раскрытие только при известном module и доступном локальном
  сигнале; explicit connections имеют приоритет, unknown остаётся unknown.
- Procedural block scope и generate bindings как отдельные объявления;
  затем классификация syntactic read/write с отрицательными controls.
- Filelists/include paths/defines как явная конфигурация проекта, чтобы
  различать synthesis/testbench варианты по доказательству сборки.
- Полная elaboration/width evaluation и интеграция с HDL-компилятором —
  отдельный дизайн; не смешивать синтаксический граф с timing/CDC анализом.

Для каждого пакета: сначала воспроизводимый пропуск/ложная связь, затем fix,
проверка на реальном RTL, обновление extraction stamp при изменении графа.
