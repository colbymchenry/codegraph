---
name: add-agent-target
description: Добавление нового coding-агента в инсталлер CodeGraph (src/installer/targets/)
metadata:
  type: project
---

# Добавление нового coding-агента в CodeGraph

Этот скилл описывает end-to-end процесс добавления поддержки нового MCP-совместимого coding-агента в инсталлер CodeGraph. Результат: агент появляется в `codegraph install --target=all`, получает свой MCP-конфиг, и проходит параметризованный контрактный тест в `__tests__/installer-targets.test.ts`.

**Почему это важно:** инсталлер — критичная поверхность. Регрессия здесь ломает установку для всех новых пользователей молча. Каждое изменение в `src/installer/` требует тестов и CHANGELOG-записи (house rules про `0.7.x`).

## Архитектура инсталлера (кратко)

- `src/installer/targets/types.ts` — `AgentTarget` interface + `TargetId` union.
- `src/installer/targets/<id>.ts` — реализация одного агента.
- `src/installer/targets/registry.ts` — реестр; новый агент = 1 файл + 1 entry в массиве `ALL_TARGETS`.
- `src/installer/targets/shared.ts` — хелперы (чтение/запись JSON, atomic write, TOML, markdown-секции, MCP-конфиг, permissions).
- `src/installer/instructions-template.ts` — маркеры `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->`.
- `__tests__/installer-targets.test.ts` — параметризованные контрактные тесты **для всех** агентов.
- `CHANGELOG.md` — записывать под `## [Unreleased]` (не создавать новый блок версии заранее).

---

## Пошаговый процесс

### Шаг 1 — Понять формат конфига агента

Прежде чем писать код, найти документацию агента по MCP и определить:

1. **Где лежит конфиг:** `~/.agent/mcp.json`, `~/.config/agent/config.toml`, `./.agent.jsonc`, env-переменная (`$AGENT_HOME`) и т.д.
2. **Формат:** JSON, TOML, YAML, JSONC, plain text/markdown.
3. **Скоуп:** есть ли project-local конфиг или только global? Если только global — `supportsLocation('local')` возвращает `false`.
4. **Shape MCP-сервера:** `mcpServers.<name>`, `mcp.<name>`, `mcp_servers.<name>`, массив, и т.д.
5. **Есть ли permissions / auto-allow?** Если нет — `autoAllow` в `install()` игнорируется.
6. **Есть ли instructions-файл?** Какой формат и где он лежит.

> **Принцип #529 (жёсткий):** инсталлер **не пишет** usage-гайд в instructions-файл агента. Единый источник правды — ответ `initialize` MCP-сервера (`src/mcp/server-instructions.ts`). Инсталлер только **удаляет** legacy-блок, который старые версии записали, чтобы self-heal при апгрейде. Никогда не пиши новый `## CodeGraph` блок в `CLAUDE.md` / `AGENTS.md` / `.mdc` / etc.

### Шаг 2 — Добавить TargetId в types.ts

В `src/installer/targets/types.ts`:

```typescript
export type TargetId = 'claude' | 'cursor' | 'codex' | 'opencode' | 'hermes' | 'gemini' | 'antigravity' | 'kiro' | 'novoagent';
```

### Шаг 3 — Создать `src/installer/targets/<id>.ts`

Класс должен имплементировать `AgentTarget`. Ниже — контракт каждого метода и паттерны.

#### `readonly id`

Строка, точно совпадает с `TargetId` в types.ts. Например: `readonly id = 'novoagent' as const;`

#### `readonly displayName`

Human-readable название для clack-промптов и логов. Например: `'Novo Agent'`.

#### `readonly docsUrl`

Опционально — ссылка на документацию агента по MCP.

#### `supportsLocation(loc: Location): boolean`

Вернуть `true` только для поддерживаемых локаций. Если агент не имеет project-local конфига (как Codex и Hermes), вернуть `false` для `'local'`. Оркестратор тогда skip-ает с понятным сообщением.

#### `detect(loc: Location): DetectionResult`

```typescript
interface DetectionResult {
  installed: boolean;          // heuristic: есть ли директория / конфиг агента
  alreadyConfigured: boolean;  // уже ли наш MCP-сервер записан в его конфиге
  configPath?: string;         // путь, который проверяли (для диагностики)
}
```

- `installed` — best-effort heuristic. Ложные срабатывания допустимы (пользователь просто выберет вручную), ложные пропуски — нет.
- `alreadyConfigured` — проверить, что в конфиге агента уже есть ключ `codegraph` / `mcp_servers.codegraph` / и т.д.

#### `install(loc: Location, opts: InstallOptions): WriteResult`

```typescript
interface WriteResult {
  files: Array<{ path: string; action: 'created' | 'updated' | 'unchanged' | 'removed' | 'not-found' | 'kept' }>;
  notes?: string[]; // однострочные подсказки, например "Restart Cursor to apply."
}
```

**Правила:**

1. **Idempotency:** повторный `install` с идентичным конфигом должен вернуть `action: 'unchanged'` и **не перезаписывать** файл на диске. Это проверяется тестом.
2. **Соседи:** если в конфиге агента уже есть другие MCP-серверы, они должны сохраниться. Никогда не перезаписывать весь файл целиком — только вставить/заменить свой блок.
3. **Legacy cleanup:** если в прошлом инсталлер писал instructions (`CLAUDE.md`, `AGENTS.md`, `.mdc`) — вызвать `removeMarkedSection(..., CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END)` в `install`, чтобы self-heal при апгрейде. Действие `removed` добавить в `files`.
4. **Atomic write:** использовать `atomicWriteFileSync()` из `shared.ts` — пишет во `.tmp.<pid>`, затем `rename`.
5. **JSON targets:** использовать `readJsonFile`, `writeJsonFile`, `jsonDeepEqual` из `shared.ts` для проверки idempotency.
6. **TOML target (Codex):** использовать `buildTomlTable`, `upsertTomlTable`, `removeTomlTable` из `toml.ts`.
7. **JSONC target (opencode):** использовать `jsonc-parser` (`modify` + `applyEdits`) для surgical edit, сохраняющего комментарии.
8. **YAML target (Hermes):** пишем line-based парсер/сериализатор (см. `hermes.ts`), не тащим библиотеку. Сохраняем комментарии и соседние ключи.
9. **Permissions:** если агент поддерживает auto-allow, при `opts.autoAllow === true` записать permissions-список через `getCodeGraphPermissions()` из `shared.ts`.
10. **Cursor `--path` quirk:** если агент запускает MCP-сервер с неправильным cwd (как Cursor), в `args` MCP-конфига добавить `'--path'` с абсолютным путём (local) или `'${workspaceFolder}'` (global). См. `cursor.ts`.

#### `uninstall(loc: Location): WriteResult`

Должен **полностью** обратить `install`:
- Удалить MCP-запись из конфига (сохранить соседние серверы).
- Удалить permissions (если писались).
- Удалить legacy instructions-блок (`removeMarkedSection`), если он есть.
- Если файл стал пустым после удаления — удалить файл целиком (см. `codex.ts`, `cursor.ts`).
- Безопасно вызывать, когда ничего не было установлено: возвращать `not-found` / `kept`.

#### `printConfig(loc: Location): string`

Чистая функция (не трогает filesystem). Вернуть строку с пояснением "добавь это в X". Используется в `codegraph install --print-config <id>` и в README.

#### `describePaths(loc: Location): string[]`

Вернуть все пути, которые `install`/`uninstall` трогают при данной локации. Для оркестратора и dry-run.

### Шаг 4 — Зарегистрировать в `registry.ts`

В `src/installer/targets/registry.ts`:

1. Добавить `import { novoagentTarget } from './novoagent';`
2. Добавить `novoagentTarget` в массив `ALL_TARGETS` (порядок = порядок в мультиселекте).
3. Порядок в `ALL_TARGETS` должен быть стабильным — не вставлять в середину без причины.

### Шаг 5 — Тесты

Параметризованный тест в `__tests__/installer-targets.test.ts` автоматически запускается для **всех** `ALL_TARGETS`. Но для нового агента, особенно если формат нестандартный (YAML, JSONC, TOML), нужно добавить **дополнительные** тест-кейсы в тот же файл или в отдельный focused describe.

**Обязательные сценарии:**

| Сценарий | Проверка |
|---|---|
| `install` пишет файлы | `detect.alreadyConfigured === true` после install |
| Idempotency | повторный `install` → все `action === 'unchanged'` |
| Sibling preservation | другой MCP-сервер в том же конфиге остаётся после install |
| Uninstall reverse | `uninstall` после `install` → `detect.alreadyConfigured === false` |
| `printConfig` | возвращает непустую строку |
| `describePaths` | возвращает пути, которые реально пишутся |
| `supportsLocation` | `local` skip-ается корректно для global-only агентов |
| Legacy instructions cleanup | если файл содержит `<!-- CODEGRAPH_START -->...<!-- CODEGRAPH_END -->`, install удаляет его |

Тестовая инфраструктура:
- `setHome(tmpDir)` — перенаправляет `os.homedir()` через env-переменные (`$HOME`, `$USERPROFILE`, `$APPDATA`, `$XDG_CONFIG_HOME`, `$HERMES_HOME`).
- `process.chdir(tmpCwd)` — для локальных тестов.
- `afterEach` — удаляет `tmpHome` и `tmpCwd` через `fs.rmSync(..., { recursive: true, force: true })`.

**Пример focused-теста для нового агента:**

```typescript
describe('novoagent — specific', () => {
  // ... setup setHome / chdir ...

  it('preserves sibling mcp server in json config', () => {
    const target = getTarget('novoagent')!;
    // ... write pre-existing config with another MCP server ...
    target.install('global', { autoAllow: false });
    // ... assert other server still present ...
  });
});
```

### Шаг 6 — CHANGELOG

Добавить запись в `CHANGELOG.md` под `## [Unreleased]`, секция `### New Features` (если это новая фича) или `### Fixes`.

Правила форматирования (см. CLAUDE.md > Releases > Writing changelog entries):
- **User-facing:** что изменилось и почему это важно пользователю.
- **Без internal путей:** не писать `src/installer/targets/novoagent.ts`, не писать имена функций/классов.
- **Можно:** название агента, команды (`codegraph install`), issue/PR-ссылки `(#NNN)`.
- **Пример:**

```markdown
### New Features

- Added support for Novo Agent as an install target. Run `codegraph install --target=novoagent` to wire the MCP server. (#NNN)
```

---

## Паттерны по форматам конфигов

### JSON (`claude`, `cursor`)

- Использовать `getMcpServerConfig()` из `shared.ts` для базового блока.
- JSON shape: `{ mcpServers: { codegraph: { type, command, args } } }`.
- Cursor: оборачивает `args` с `'--path', ...`.
- Idempotency: `jsonDeepEqual(before, after)` перед записью.

### TOML (`codex`)

- Использовать `buildTomlTable`, `upsertTomlTable`, `removeTomlTable` из `toml.ts`.
- Header: `mcp_servers.codegraph`.
- `printConfig` — строить строку через `buildTomlTable`.

### JSONC (`opencode`)

- Использовать `jsonc-parser` (`modify` + `applyEdits`), не `JSON.stringify`.
- Сохраняет комментарии и formatting при idempotent re-run.
- Добавить `$schema` если отсутствует при создании нового файла.

### YAML (`hermes`)

- Line-based парсер, не тянем YAML-библиотеку.
- `topLevelRange`, `childRange`, `listChildBlock` — ищем ключи по отступам.
- `platform_toolsets` может требовать отдельной записи (Hermes). Для других агентов YAML — возможно, только `mcp_servers`.

### Markdown / rules file (`cursor`, `gemini`, `kiro`)

- **Не пишем новые instructions.**
- Если файл был создан старым инсталлером (наш frontmatter + маркеры) — `removeRulesEntry()` удаляет весь файл, если в нём только наш контент; иначе удаляет только маркированный блок.
- Cursor `.mdc`: frontmatter YAML (`---\ndescription: ...\nalwaysApply: true\n---`).

---

## Типичные ошибки и как их избежать

| Ошибка | Почему плохо | Правильно |
|---|---|---|
| Перезаписать весь конфиг-файл целиком | Удаляет соседние MCP-серверы и пользовательские настройки | Surgical edit: только свой ключ |
| Писать `## CodeGraph` в instructions (#529) | Дублирует guidance из MCP initialize; агент читает дважды | Только `removeMarkedSection` для legacy cleanup |
| Забыть `jsonDeepEqual` / `arrayEqual` | Re-run выглядит как "updated", сбивает с толку | Проверять idempotency перед atomic write |
| Не atomic write | Процесс может упасть mid-write и оставить битый файл | `atomicWriteFileSync` из `shared.ts` |
| `uninstall` не удаляет legacy hooks/instructions | Пользователь после `uninstall` всё ещё видит codegraph | Удалять всё, что `install` писал, включая legacy |
| `supportsLocation('local') === true` для global-only агента | Локальный install создаёт файл, который агент никогда не прочитает | Вернуть `false` и честное сообщение в `notes` |
| Забыть `TargetId` в `types.ts` | TypeScript error в registry; CI не собирается | Добавить **до** создания target-файла |
| Нет тестов на sibling preservation | Регрессия может удалить другие MCP серверы | Добавить focused test с pre-existing конфигом |
| Не обновить `CHANGELOG.md` | Релизные ноты не отражают новую фичу | Запись в `## [Unreleased]` |

---

## Чеклист перед тем, как считать задачу готовой

- [ ] `TargetId` обновлён в `types.ts`
- [ ] `src/installer/targets/<id>.ts` создан, имплементирует `AgentTarget`
- [ ] Используются хелперы из `shared.ts` (atomic write, JSON/TOML helpers, permissions, MCP config)
- [ ] Нет записи новых instructions — только `removeMarkedSection` для legacy cleanup (#529)
- [ ] `id` в target-файле совпадает с `TargetId` в types.ts
- [ ] `registry.ts` импортирует и включает новый target в `ALL_TARGETS`
- [ ] `install` idempotent: повторный вызов → `unchanged`
- [ ] `install` не затирает соседние MCP-серверы
- [ ] `uninstall` полностью откатывает `install` (включая permissions, legacy hooks, instructions)
- [ ] `printConfig` — чистая функция, возвращает непустую строку
- [ ] `describePaths` возвращает все пути, которые target трогает
- [ ] `supportsLocation` корректно ограничивает global-only агентов
- [ ] Тесты в `__tests__/installer-targets.test.ts` проходят (`npm test` или `npx vitest run __tests__/installer-targets.test.ts`)
- [ ] Добавлен focused test на sibling preservation / специфику формата агента
- [ ] `CHANGELOG.md` обновлён под `## [Unreleased]`
