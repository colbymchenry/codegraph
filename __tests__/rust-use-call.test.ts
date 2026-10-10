import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-use-call-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nexternal = "1"\n',
    'src/lib.rs': 'pub mod a;\npub mod util;\npub mod caller;\npub mod child;\npub mod method_only;\npub fn root_take() {}\npub enum Root { RootGood(i32) }\n',
    'src/a.rs': 'pub fn take() {}\npub fn consume() {}\npub fn selected() {}\npub enum Noise { take }\n',
    'src/util.rs': `pub struct Buf;
impl Buf { pub fn take(&self) {} }
pub fn outer() {
    fn take() {}
    take();
}
pub fn take() {}
`,
    'src/method_only.rs': 'pub struct Buf;\nimpl Buf { pub fn take(&self) {} }\n',
    'src/caller.rs': `use crate::util::take;
pub fn imported() { take(); }
pub fn shadowed() {
    fn take() {}
    take();
}
pub fn parameter(take: fn()) { take(); }
pub fn destructured((take, _): (fn(), i32)) { take(); }
pub fn type_label(callback: fn(take: i32)) { take(); }
pub fn generic<T: Fn(i32)>(callback: T) { take(); }
pub fn after_binding() {
    take();
    let take = || {};
    take();
}
`,
    'src/alias.rs': `use crate::util::take as consume;
pub fn aliased() { consume(); }
`,
    'src/group.rs': `use crate::{util::{take as selected}, a::{take as other}};
pub fn grouped() { selected(); }
pub fn second() { other(); }
`,
    'src/child/mod.rs': `use super::util::take;
use self::util::take as local_take;
pub fn parent() { take(); }
pub fn child() { local_take(); }
`,
    'src/child/util.rs': 'pub fn take() {}\n',
    'src/scoped.rs': `pub fn first() {
    use crate::util::take;
    take();
}
pub fn second() {
    use crate::a::take;
    take();
}
`,
    'src/outer_shadow.rs': `fn take() {}
pub fn imported_in_block() {
    use crate::util::take;
    take();
}
pub fn inner_import(take: fn()) {
    {
        use crate::util::take;
        take();
    }
}
pub fn before_binding() {
    use crate::util::take;
    take();
    let take = || {};
}
`,
    'src/tests_mod.rs': 'pub fn tested_helper() {}\n#[cfg(test)]\nmod tests {\n    use super::tested_helper;\n    fn uses() { tested_helper(); }\n}\n',
    'src/external.rs': 'use external::take as consume;\npub fn external_call() { consume(); }\n',
    'src/models.rs': 'pub enum E { Good(i32) }\n',
    'src/model_decoy.rs': 'pub enum E { Real(i32) }\nmod hidden { pub enum E { Good(i32) } }\n',
    'src/model_decoy_call.rs': 'use crate::model_decoy::E::Good;\npub fn model_decoy() { Good(1); }\n',
    'src/variant.rs': 'use crate::models::E::Good;\npub fn variant() { Good(1); }\n',
    'src/variant_alias.rs': 'use crate::models::E::Good as Build;\npub fn alias_variant() { Build(1); }\n',
    'src/root_call.rs': 'use crate::root_take as consume;\npub fn root_call() { consume(); }\n',
    'src/root_variant.rs': 'use crate::Root::RootGood;\npub fn root_variant() { RootGood(1); }\n',
    'src/same_file.rs': 'fn same_take() {}\nuse self::same_take as consume;\npub fn same_file() { consume(); }\n',
    'src/inline_reexport.rs': '#[cfg(unix)]\nmod imp { pub fn lone() {} }\npub use imp::*;\nuse self::lone as aliased;\npub fn via_alias() { aliased(); }\npub fn via_path() { crate::inline_reexport::lone(); }\n',
    'src/duplicate.rs': '#[cfg(unix)]\npub fn take() {}\n#[cfg(windows)]\npub fn take() {}\n',
    'src/duplicate_call.rs': 'use crate::duplicate::take;\npub fn duplicate_call() { take(); }\n',
    'tests/bad_inline.rs': 'mod hidden { mod support { pub mod panic; } }\nuse support::panic::test_panic;\npub fn bad_inline() { test_panic(); }\n',
    'tests/support/panic.rs': 'pub fn test_panic() {}\n',
    'src/sync.rs': 'use crate::a::take;\npub fn synced() { take(); }\n',
    'src/unicode.rs': 'use crate::util::take;\npub fn unicode() { let crab = "🦀Я"; take(); }\n',
    'src/unicode_scoped.rs': 'pub fn unicode_scoped() { let crab = "🦀Я"; { use crate::util::take as consume; consume(); } }\n',
    'crates/one/Cargo.toml': '[package]\nname = "one"\nversion = "0.1.0"\n',
    'crates/one/src/lib.rs': 'pub mod util;\n',
    'crates/one/src/util.rs': 'pub fn take() {}\npub fn only_in_one() {}\n',
    'crates/two/Cargo.toml': '[package]\nname = "two"\nversion = "0.1.0"\n',
    'crates/two/src/lib.rs': 'pub mod util;\npub mod caller;\n',
    'crates/two/src/util.rs': 'pub fn take() {}\n',
    'crates/two/src/caller.rs': 'use crate::util::take;\nuse one::util::only_in_one;\npub fn workspace_call() { take(); }\npub fn cross_crate() { only_in_one(); }\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const calls = (file: string, name: string) => {
  const caller = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'function');
  expect(caller).toBeDefined();
  return cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.kind} ${n.qualifiedName} ${n.filePath}:${n.startLine}`);
};

const take = 'function take src/util.rs:7';

describe('Rust bare calls bound by use', () => {
  it('chooses the imported free function among same-name methods and functions', () => {
    expect(calls('src/caller.rs', 'imported')).toEqual([take]);
  });

  it('follows an alias even when no declaration carries its local name', () => {
    expect(calls('src/alias.rs', 'aliased')).toEqual([take]);
    expect(calls('src/group.rs', 'grouped')).toEqual([take]);
    expect(calls('src/group.rs', 'second')).toEqual(['function take src/a.rs:1']);
  });

  it('anchors self and super imports on the current module', () => {
    expect(calls('src/child/mod.rs', 'parent')).toEqual([take]);
    expect(calls('src/child/mod.rs', 'child')).toEqual(['function take src/child/util.rs:1']);
  });

  it('keeps block-local imports in their own scopes', () => {
    expect(calls('src/scoped.rs', 'first')).toEqual([take]);
    expect(calls('src/scoped.rs', 'second')).toEqual(['function take src/a.rs:1']);
  });

  it('does not replace a local function or parameter with an imported function', () => {
    expect(calls('src/caller.rs', 'shadowed')).toEqual(['function shadowed::take src/caller.rs:4']);
    expect(calls('src/caller.rs', 'parameter')).toEqual([]);
    expect(calls('src/caller.rs', 'destructured')).toEqual([]);
    expect(calls('src/caller.rs', 'type_label')).toEqual([take]);
    expect(calls('src/caller.rs', 'generic')).toEqual([take]);
    expect(calls('src/caller.rs', 'after_binding')).toEqual([take]);
  });

  it('lets a closer use shadow an outer declaration, and ignores later let bindings', () => {
    expect(calls('src/outer_shadow.rs', 'imported_in_block')).toEqual([take]);
    expect(calls('src/outer_shadow.rs', 'inner_import')).toEqual([take]);
    expect(calls('src/outer_shadow.rs', 'before_binding')).toEqual([take]);
  });

  it('does not guess a target for an alias or an enum variant it cannot follow', () => {
    expect(calls('src/external.rs', 'external_call')).toEqual([]);
    expect(calls('src/model_decoy_call.rs', 'model_decoy')).toEqual([]);
  });

  it('leaves an import it cannot follow to the general resolution, as before', () => {
    // Another crate of the workspace, named by its package.
    expect(calls('crates/two/src/caller.rs', 'cross_crate')).toEqual(['function only_in_one crates/one/src/util.rs:2']);
    // A relative path inside an inline module, the usual `mod tests { use super::…; }`.
    expect(calls('src/tests_mod.rs', 'uses')).toEqual(['function tested_helper src/tests_mod.rs:1']);
    expect(calls('tests/bad_inline.rs', 'bad_inline')).toEqual(['function test_panic tests/support/panic.rs:1']);
  });

  it('reaches an inline module\'s function through the module\'s re-export', () => {
    expect(calls('src/inline_reexport.rs', 'via_alias')).toEqual(['function lone src/inline_reexport.rs:2']);
    expect(calls('src/inline_reexport.rs', 'via_path')).toEqual(['function lone src/inline_reexport.rs:2']);
  });

  it('takes the first of two #[cfg] variants of the imported function', () => {
    expect(calls('src/duplicate_call.rs', 'duplicate_call')).toEqual(['function take src/duplicate.rs:2']);
  });

  it('keeps a variant attached to its imported enum, including a renamed variant', () => {
    expect(calls('src/variant.rs', 'variant')).toEqual(['enum_member E::Good src/models.rs:1']);
    expect(calls('src/variant_alias.rs', 'alias_variant')).toEqual(['enum_member E::Good src/models.rs:1']);
    expect(calls('src/root_variant.rs', 'root_variant')).toEqual(['enum_member Root::RootGood src/lib.rs:7']);
  });

  it('binds crate-root functions and same-file aliases', () => {
    expect(calls('src/root_call.rs', 'root_call')).toEqual(['function root_take src/lib.rs:6']);
    expect(calls('src/same_file.rs', 'same_file')).toEqual(['function same_take src/same_file.rs:1']);
  });

  it('uses UTF-16 source columns after Cyrillic and emoji on the call line', () => {
    expect(calls('src/unicode.rs', 'unicode')).toEqual([take]);
    expect(calls('src/unicode_scoped.rs', 'unicode_scoped')).toEqual([take]);
  });

  it('resolves crate relative to the caller rather than another package', () => {
    expect(calls('crates/two/src/caller.rs', 'workspace_call'))
      .toEqual(['function take crates/two/src/util.rs:1']);
  });

  it('refreshes the exact binding after a source edit and sync', async () => {
    expect(calls('src/sync.rs', 'synced')).toEqual(['function take src/a.rs:1']);
    fs.writeFileSync(path.join(root, 'src/sync.rs'), 'use crate::util::take;\npub fn synced() { take(); }\n');
    await cg.sync();
    expect(calls('src/sync.rs', 'synced')).toEqual([take]);
  });
});
