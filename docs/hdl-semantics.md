# Вычисленные параметры и ширины HDL через slang

Команда `hdl-semantic` и API `CodeGraph.getHdlSemantics()` запускают установленный
slang по явному запросу. Нужны инициализированный проект и активный HDL build
profile в `codegraph.json`. Факты возвращаются отдельно от source graph; данные
графа не перезаписываются. Slang автоматически не устанавливается. Для compiler macro provenance доступен
[отдельный pyslang backend](hdl-macro-source-map.md) через --python; выбрать ровно
один frontend executable.

## CLI

```sh
codegraph hdl-semantic top.W --path /path/to/project --slang /path/to/slang
codegraph hdl-semantic crc_out --path /path/to/project --slang /path/to/slang
codegraph hdl-semantic NoSlvMst --path /path/to/project --slang /path/to/slang \
  --top synth_axi_lite_xbar --parameter NoSlvMst=4
```

Ответ — JSON с facts и provenance. Query выбирает точное имя, instance path или
`instancePath.name`; без query возвращается первая ограниченная выборка.
`--limit` задаёт 1..1000 фактов (по умолчанию 100), totalMatches/truncated
показывают обрезку. Для нескольких overrides перечислить NAME=VALUE после
`--parameter`. Имена/значения передаются отдельными arguments без shell.

Если slang отклоняет UART из-за use-before-declare, совместимость можно включить
явно через `--allow-use-before-declare`. Она входит в provenance/fingerprint и
не включается автоматически после compiler error.

## API

```ts
const result = await cg.getHdlSemantics({
  executable: '/path/to/slang',
  top: 'top',
  parameters: { W: '16' },
  query: 'top.data',
  limit: 20,
  signal: abortController.signal,
});
```

Параметры возвращаются как строки evaluated values, чтобы не терять большие
целые и неизвестные разряды. Port width возвращается только для типов,
которые importer умеет вычислить достоверно; отсутствие width не означает 0.
Instance-specific facts не сливаются между экземплярами одного module.

Каждый ответ фиксирует slang version, executable hash, active profile,
configuration и semantic fingerprints, top, overrides, language standard,
separate compilation-unit mode, runner version, compiler limits и compatibility mode.
`sourceNodeId` добавляется только при совпадении профиля, raw hash файла и
единственном совпадении имени/строки source declaration. При устаревшем или
другом source graph вычисленные facts доступны без предполагаемых node links.

Source location сохраняет frontend coordinates; это не обещание UTF16 offsets
CodeGraph. Column null означает неизвестную колонку, например у macro-generated
объявления. Macro invocation line не выдаётся за точный expanded token range.

## Границы первой реализации

- Вычисление по запросу, без persistent semantic cache и автоматического запуска
  при index/sync/explore. Следующий запрос использует новый snapshot.
- Поддержанный slang contract проверяется runner/importer; неизвестная версия
  или форма AST отвергается. AST, записанный при ошибке compiler, не принимается.
- Snapshot: 1 MiB на input, 64 MiB суммарно; AST максимум 64 MiB, stdout/stderr
  суммарно 1 MiB. Фиксированы compiler limits для hierarchy/generate/constant
  evaluation; это не жёсткий OS RSS limit. Временные данные хранятся в
  `~/storage/codegraph-semantic-runs` (override `CODEGRAPH_SEMANTIC_TMPDIR` вне
  project root) и удаляются после запроса.
- Snapshot включает выбранные inputs и literal include dependencies.
  Некорректные/выходящие за project root пути и неподдержанные формы include
  отклоняются. Это не sandbox для запуска недоверенного compiler executable.
- Full macro expansion выполняет compiler в допустимом snapshot context;
  точная цепочка expansion/spelling locations ещё не экспортируется.
- Ошибка, отсутствие slang или отмена не изменяют source graph. Windows runner
  пока не включён; процессная отмена требует отдельной проверки на этой ОС.
- Это параметры/порты и их compiler context, не simulation, synthesis, timing,
  CDC или доказательство аппаратной корректности. Semantics не добавлена в
  обычный MCP explore; для явного запроса использовать CLI/API выше.

Проверенные версии, реальные корпуса и результаты — в
`validation-hdl-semantics-2026-09-12.md`. План дальнейшей интеграции —
`../VERILOG_TRACKER.md`.
