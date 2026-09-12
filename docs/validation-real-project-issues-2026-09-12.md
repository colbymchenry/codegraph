# Исправления по тестам на реальных проектах — 12 сентября 2026

База: `97de99bc`, Linux x64 / Node 24.15.0. Extraction stamp: 29.

## Исправлено

- Name matching для calls ограничен семейством языка. Межъязыковые связи
  требуют отдельного bridge-resolver, а не совпадения имени. Method fallback
  применяет ту же проверку. C/C++ enum_member не является целью вызова;
  Rust enum constructors и Kotlin SAM-construction этим фильтром не запрещены.
- SyncResult сообщает skippedReason=locked при занятой блокировке. Watcher
  сохраняет прежнюю возможность повторить sync; CLI возвращает exit 1 и
  объяснение, включая одну строку stderr в quiet-режиме.
- QueryPool удаляет worker с ready(ok:false), ограниченно пытается заменить
  его и завершает ожидающие запросы при исчерпании crash budget. Запрос к
  неисправному pool больше не остаётся ждать worker бесконечно.
- Числовой legacy daemon.pid распознаётся. Живой PID без socket identity
  нельзя удалить даже через allowLivePid; обычные структурированные записи
  сохраняют механизм проверки PID reuse.

## Тесты

- Полный native-suite: **4655 passed, 4 failed, 9 skipped**, 270 файлов.
  Все 4 отказа — kernel-dart-parity (torture.dart / TortureCtors.dart,
  LF и CRLF), ранее воспроизведённые на upstream. Полный suite не зелёный;
  новых отказов в этой редакции нет.
- Профильный WASM: **307 passed**, 7 файлов: resolution, query-pool,
  real-project-regressions, sync, CLI stale/locked sync, awaited receiver,
  sync-rebuild-convergence.
- TypeScript, build (viewer + 29 WASM-грамматик), diff whitespace: успешно.
- Windows/macOS не запускались.

## Реальные проекты: контролируемый A/B

Копии размещены в `/home/danik/storage/codegraph-real-issues-20260912`.
ADRC: 2069 исходных индексируемых файлов; CSQTT desktop: 51.
SQLite-копии получены backup API, исходные базы не использовались для fault
injection. A/B каждый раз создаёт БД заново на одном наборе исходников.
Baseline — name-matcher из 97de99bc, после — текущая реализация; остальные
модули одинаковы. Baseline выполняется без параллельного resolver, чтобы
worker не подменил проверяемую реализацию. Это resolver A/B, не полный
benchmark двух исторических сборок.

| Проект | Уникальных calls до | После | Удалено | Добавлено |
|---|---:|---:|---:|---:|
| ADRC | 13923 | 13794 | 129 | 0 |
| CSQTT desktop | 381 | 380 | 1 | 0 |

Все 129 удалённых ADRC-связей в сравнении — цели enum_member (MIN/MAX).
В прежнем аудите было 167 строк edges: здесь сравниваются уникальные
(source file/name, target file/name/kind), а не строки или call sites.
Другие callable-связи в контролируемом A/B не исчезли.
CSQTT потерял только ложную связь Go verifyUpdateCleanup → TS interface Size.

На копии CSQTT:

- Занятая блокировка, одна неиндексированная правка: exit 1, сообщение busy/lock,
  pending.modified=1 сохраняется. Ложного Already up to date нет.
- QueryPool control: три успешных explore-запроса.
- Fault «БД не открывается»: healthy=false, ready=false, liveWorkers=0,
  ожидающие запросы завершаются; все созданные worker threads остановлены.
- Legacy PID: тестовый живой PID декодируется и lockfile сохраняется.

## Артефакты воспроизведения

Локальные `.scratch/real-fix-compare.py`, `real-ab-index.cjs`,
`real-fix-compare.json`, `real-lock-probe.cjs`, `real-lock-results.json`,
`real-pool-probe.cjs`, `real-pool-results.json`, `real-fix-full-native.log`,
`real-fix-wasm-final.log`. Регрессионные тесты включены в исходники.

Ограничение: это закрывает подтверждённые сценарии, а не все открытые issues
CodeGraph. В частности, отдельные macro-to-function коллизии, MCP projectPath
watch lifecycle и произвольная межъязыковая инференция здесь не реализованы.
