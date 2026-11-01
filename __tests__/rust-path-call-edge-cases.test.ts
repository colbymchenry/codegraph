/**
 * A Rust call through a type a path names — `crate::a::Cache::open()` — is to
 * the associated function of the type that path walks to, and no other's:
 * - not a namesake type's, in another inline module of the same file or one a
 *   function declares in its own body;
 * - not an `impl` for a reference to the type (`impl Open for &Cache`), which
 *   is the reference type's.
 * A path whose head a `use` in the function's body binds (`use crate::b as
 * a;`) is the path that `use` names, not the module `a` beside it; a `mod a {
 * … }` the function declares is no module of the file, so neither its call
 * nor a later `pub mod a` takes the other's items.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-path-edge-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub mod inline;\npub mod local;\npub mod shadow;\npub mod order;\npub mod refimpl;\npub mod traits;\npub mod shapes;\npub mod store;\npub mod split;\n',
    // a's Cache has only a trait's provided `open`; b's has an inherent one.
    'src/inline.rs': `pub mod a {
    pub struct Cache;
    pub trait Open {
        fn open() -> usize {
            1
        }
    }
    impl Open for Cache {}
}

pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
}

pub fn through_a() -> usize {
    crate::inline::a::Cache::open()
}

pub fn through_b() -> usize {
    crate::inline::b::Cache::open()
}
`,
    // The root's Cache has only the trait's provided `open`; a function
    // declares a Cache of its own, whose inherent `open` is not the root's.
    'src/local.rs': `pub struct Cache;

pub trait Open {
    fn open() -> usize {
        1
    }
}

impl Open for Cache {}

pub fn build_local() -> usize {
    struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
    0
}

pub fn through_root() -> usize {
    crate::local::Cache::open()
}
`,
    'src/shadow.rs': `pub mod a {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            1
        }
    }
    pub fn make() -> usize {
        1
    }
}

pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
    pub fn make() -> usize {
        2
    }
}

pub fn through_module() -> usize {
    a::Cache::open()
}

pub fn through_use() -> usize {
    use crate::shadow::b as a;
    a::Cache::open()
}

pub fn through_use_fn() -> usize {
    use crate::shadow::b as a;
    a::make()
}

pub fn through_local_mod() -> usize {
    mod a {
        pub use crate::shadow::b::Cache;
    }
    a::Cache::open()
}

pub fn through_local_mod_fn() -> usize {
    mod a {
        pub fn make() -> usize {
            3
        }
    }
    a::make()
}
`,
    // b comes first in the file, and a function before `pub mod a` declares a
    // `mod a` of its own: the module's own `a` is still the one after it.
    'src/order.rs': `pub mod b {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            2
        }
    }
}

pub fn decoy() {
    mod a {
        pub use crate::order::b::Cache;
    }
}

pub mod a {
    pub struct Cache;
    impl Cache {
        pub fn open() -> usize {
            1
        }
    }
}

pub fn via_order() -> usize {
    a::Cache::open()
}
`,
    // Cache takes the trait's provided `open`; the impl for `&Cache` writes its own.
    'src/refimpl.rs': `pub struct Cache;

pub trait Open {
    fn open() -> usize {
        1
    }
}

impl Open for Cache {}

impl Open for &crate::refimpl::Cache {
    fn open() -> usize {
        3
    }
}

pub fn through_cache() -> usize {
    crate::refimpl::Cache::open()
}
`,
    // A trait, and a struct of the same name in another module with an inherent method of the trait's method's name.
    'src/traits.rs': `pub trait Region {
    fn size() -> usize;
}
`,
    'src/shapes.rs': `pub struct Region;

impl Region {
    pub fn size() -> usize {
        0
    }
}

pub fn through_trait() -> usize {
    crate::traits::Region::size()
}
`,
    // An impl written in another file than its type: by path, and by a bare name a `use` brings in.
    'src/store.rs': `pub struct Store;
pub struct Vault;
`,
    'src/split.rs': `use crate::store::Vault;

impl crate::store::Store {
    pub fn drop_all() -> usize {
        1
    }
}

impl Vault {
    pub fn seal() -> usize {
        2
    }
}

pub fn through_path() -> usize {
    crate::store::Store::drop_all()
}

pub fn through_use() -> usize {
    crate::store::Vault::seal()
}
`,
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

/** What the function `name` in `file` calls, as `kind qualifiedName file:line`. */
const calls = (file: string, name: string): string[] => {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'function');
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg.getOutgoingEdgesFrom([fn!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`).sort();
};

describe('Rust calls through a type a path names', () => {
  it('never reach a namesake type\'s function in another inline module of the file', () => {
    expect(calls('src/inline.rs', 'through_a')).toEqual([]);
    expect(calls('src/inline.rs', 'through_b')).toEqual(['method Cache::open src/inline.rs:14']);
    // Controls: an impl written in another file than its type is still the
    // type's, by its path or by a name a `use` brings in; and a trait's own
    // declaration is still reached through the trait, not a namesake struct's.
    expect(calls('src/split.rs', 'through_path')).toEqual(['method Store::drop_all src/split.rs:4']);
    expect(calls('src/split.rs', 'through_use')).toEqual(['method Vault::seal src/split.rs:10']);
    expect(calls('src/shapes.rs', 'through_trait')).toEqual(['method Region::size src/traits.rs:2']);
  });

  it('never reach the function of a namesake type a function declares in its own body', () => {
    expect(calls('src/local.rs', 'through_root')).toEqual([]);
  });

  it('never reach the function of an impl for a reference to the type', () => {
    expect(calls('src/refimpl.rs', 'through_cache')).toEqual([]);
  });

  it('read a head a `use` in the function\'s body binds as the path that `use` names', () => {
    expect(calls('src/shadow.rs', 'through_use')).toEqual(['method Cache::open src/shadow.rs:16']);
    expect(calls('src/shadow.rs', 'through_use_fn')).toEqual(['function make src/shadow.rs:20']);
    // Where no `use` in the body binds `a`, it is the module `a` (control).
    expect(calls('src/shadow.rs', 'through_module')).toEqual(['method Cache::open src/shadow.rs:4']);
  });

  it('never reach module a\'s item through a module `a` the function declares in its own body', () => {
    expect(calls('src/shadow.rs', 'through_local_mod')).not.toContain('method Cache::open src/shadow.rs:4');
    expect(calls('src/shadow.rs', 'through_local_mod_fn')).not.toContain('function make src/shadow.rs:8');
  });

  it('keep the module\'s own `mod a` when a function before it declares a `mod a` of its own', () => {
    expect(calls('src/order.rs', 'via_order')).toEqual(['method Cache::open src/order.rs:19']);
  });
});
