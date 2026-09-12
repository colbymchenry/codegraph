# Исправления findings ревью 1a11de26 — 12 сентября 2026

База: 1a11de26, Linux x64 / Node 24.15.0. Extraction stamp 32.

## Закрытые случаи

1. C++ pointer/reference/function-pointer initialization не считается созданием
   объекта. Проверяется вложенный declarator, а не только initializer list.
2. Constructor refs локальных объектов имеют формат Type::Type/N. Resolver
   сначала ищет тип в лексическом namespace, затем выбирает единственный
   constructor с совместимой арностью. Global/explicit namespace сохранены.
   Same-arity overloads и initializer_list не угадываются; полного overload
   resolution по типам аргументов нет.
3. C++ IDs учитывают UTF-16 колонку: constructors одной строки не перезаписывают
   друг друга; тела и useDefault/useInt ссылаются на разные правильные IDs.
   C и остальные ранее неизменённые языки сохраняют прежний формат IDs.
4. Macro recovery использует AST настоящего предшествующего #define; текст
   комментария и noexcept(name()) не становятся доказательством имени функции.
   Constructor не переименовывается как macro-generated function, включая
   сценарий define/undef. Аргументы макроса не выдаются за параметры функции:
   неподтверждённая signature у get_version отсутствует.
5. Macro visibility различает отсутствующий entry и existing unknown:
   условный undef больше не превращает possible macro в definite absence.
6. Default/cache/lifecycle/catch-up используют canonical root. Symlink и real
   path разделяют экземпляр, watcher и gate; позднее назначение default не
   закрывает ранее открытый explicit-проект и его pending catch-up.

## Подтверждение результатов

Исходные review-примеры сохранены отдельно от результатов исправления.

- 7 C++ fixtures компилируются как C++17; fixed native/WASM JSON совпадают.
  Pointer/reference дают 0 ctor calls; default/int выбирают правильные defs;
  namespace second не связывается с first; same-line constructors имеют разные
  IDs; macro-comment сохраняет NATIVE_FN и настоящий invoke → NATIVE_FN.
- ADRC recreate: 2021файл, 0 проверенных ложных macro calls, 15/15 настоящих
  контрольных calls сохранены. 32811nodes,70888edges,22663calls; 9.185с.
  0filesErrored, 7 прежних parse warnings. Это проверка графа, не firmware runtime.
- Alias probe: ровно1watcher; второй запрос не выходит до снятия barrier первого
  catch-up; оба ответа содержат added.ts. Сохраняется общий timeout gate,
  настройка бесконечного ожидания — CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0.
- Реальный stdio MCP на копиях CSQTT (54файла) и bot (30файлов): source hashes
  совпадают с SQLite после catch-up и live updates; exit0 и cleanup PASS.
- Repro unknown define/undef: possible macro=true, persisted calls=[];
  cc -E с ENABLE_TRACE=1,CLEAR_TRACE=0 подтверждает отсутствие вызова TRACE.

## Финальная матрица

- Native: 280 test files passed; 4729 passed, 9 skipped, 0 failed.
- WASM: 279 test files passed, 1 skipped; 4719 passed, 19 skipped, 0 failed.
- TypeScript и полная сборка с viewer и 30 grammar assets прошли.
- Прогоны выполнены последовательно с двумя workers и --liftoff-only.

## Границы

Полный C/C++ preprocessor и произвольные macro replacements не реализованы.
Выбор local constructors намеренно консервативен при неоднозначности. Полный
HDL elaboration/timing не добавлен. Windows/macOS не проверялись.

## Артефакты

.scratch/cpp-review-fixed-native.json, cpp-review-fixed-wasm.json,
cpp-real-adrc-results.json, fixed-lifecycle-alias-gate.cjs,
fixed-lifecycle-alias.cjs, real-project-lifecycle-mcp-results.json,
review-uncertain-undef.cjs, review-final-matrix.json и review-final-*.log.
