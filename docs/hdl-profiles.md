# Профили HDL-сборки

Профиль выбирает HDL-источники и контекст условной компиляции. В одном индексе
хранится один активный профиль; остальные языки проекта сохраняют обычный scope.

## Конфигурация

```json
{
  "hdl": {
    "activeProfile": "synth",
    "profiles": {
      "synth": {
        "filelists": ["profiles/synth.f"],
        "includeDirs": ["rtl/include"],
        "defines": {"SYNTHESIS": "1"},
        "topModules": ["top"],
        "languageMode": "systemverilog"
      },
      "sim": {
        "files": ["rtl/top.sv", "tb/top_tb.sv"],
        "includeDirs": ["rtl/include"],
        "defines": {},
        "topModules": ["top_tb"]
      }
    }
  }
}
```

Файл — codegraph.json в корне проекта. files и filelists складываются;
пустые/отсутствующие оба списка означают пустую HDL-выборку, а не все файлы.
Явные HDL sources могут находиться в gitignored/generated каталогах. Пути
должны оставаться внутри проекта; VCS и хранилища CodeGraph исключены.

Filelist поддерживает пути, quotes/comments, +incdir+ и +define+, вложенные
-f/-F. Для .f/-f относительные пути считаются от корня проекта; для .F/-F —
от каталога содержащего списка. Неизвестные флаги, циклы и конфликтующие
значения defines отклоняются, а не интерпретируются предположительно.
Значения defines задаются строками. В текущем препроцессоре используется
определённость макроса; значение "0" тоже означает defined.

## Работа с индексом

Для уже инициализированного проекта после добавления профиля:

```sh
codegraph index
codegraph status --json
```

Сменить hdl.activeProfile, затем выполнить codegraph sync. Работающий watcher
наблюдает конфигурацию, filelists и include dependencies, включая неизвестные
расширения заголовков и явно выбранные ignored paths. Смена контекста требует
пересчёта всей HDL-выборки даже при scoped sync; частичный indexFiles не
разрешает сменить контекст без полного sync/index.

CLI/MCP отдельно показывают configured и indexed profile, fingerprint,
диагностику и ограничения. Изменение include учитывается по содержимому,
включая сохранённые размер/mtime. В fingerprint входят selected config,
filelists, include snapshots и extraction version. При некорректном профиле
индексация прекращается до изменения графа.

Единицы разбираются из подготовленного snapshot; stored hashes относятся к
исходным байтам, не к замаскированному тексту. Правки во время прохода остаются
pending для следующего sync. Частичные операции обновляют диагностику только
действительно обработанных единиц.

## Поддержанный препроцессинг и ограничения

- ifdef/ifndef/elsif/else/endif и define/undef/undefineall.
- Include вносит macro state и зависимость. Он не вставляет содержимое header
  в source unit; header можно явно перечислить как отдельный источник.
- Неактивный текст заменяется пробелами с сохранением UTF-16 offsets и CR/LF.
  Показанные snippets остаются оригинальным исходником и могут содержать
  неактивные ветки; граф учитывает выбранный профиль.
- Полного macro expansion нет. Непрозрачный макровызов может изменить defines:
  дальнейшая неизвестная условная ветка не выбирается, а диагностируется.
  Неподдержанные конструкции и incomplete state явно видны в status.
- Каждая listed source unit начинает с defines профиля; порядок файлов не
  используется как неявный общий macro environment нескольких compilation units.
- languageMode записывает intended dialect; parser остаётся SystemVerilog и не
  доказывает соответствие только Verilog. topModules — записанные roots;
  reachability pruning/elaboration не выполняются.
- Пределы текущего snapshot режима: 1 MiB на source/header, 64 MiB суммарно;
  loader ограничивает размер и глубину filelists. Диагностика ограничена по
  объёму без прекращения обработки macro state.

Полное раскрытие include/macro с compiler source mapping и semantic frontend
остаётся следующим отдельным этапом. Профиль не доказывает synthesis, simulation,
width compatibility, timing или CDC.
