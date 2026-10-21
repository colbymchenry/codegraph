# CodeGraph Hermes wrapper apply notes

Use this reference when applying an OpenSpec change that modifies Hermes/CodeGraph integration behaviour.

## Single-change validation

OpenSpec v1.7 uses the item-name form for single-change validation:

```bash
openspec validate "<change-name>" --type change --strict --json
```

Do not use `openspec validate --change "<name>"`; that flag belongs to other OpenSpec commands such as `status` and `instructions`, not `validate`.

## Safe Hermes installer verification

When testing built installer code that writes Hermes config or skills, isolate with `HERMES_HOME`, not just `HOME`:

```bash
TMP=$(mktemp -d /tmp/codegraph-hermes-install-XXXXXX)
HERMES_HOME="$TMP/hermes" node - <<'JS'
const fs = require('fs');
const path = require('path');
const { getTarget } = require('./dist/installer/targets/registry');
const hermes = getTarget('hermes');
const result = hermes.install('global', { autoAllow: true });
console.log(JSON.stringify(result, null, 2));
console.log(fs.readFileSync(path.join(process.env.HERMES_HOME, 'config.yaml'), 'utf8'));
console.log(fs.readFileSync(path.join(process.env.HERMES_HOME, 'skills', 'codegraph-query', 'SKILL.md'), 'utf8'));
JS
rm -rf "$TMP"
```

If a test accidentally writes to the real profile, undo through the same target before continuing:

```bash
node - <<'JS'
const { getTarget } = require('./dist/installer/targets/registry');
console.log(JSON.stringify(getTarget('hermes').uninstall('global'), null, 2));
JS
```

Then verify the real `~/.hermes/config.yaml` and `~/.hermes/skills/<skill>/` no longer contain the temporary additions.
