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
 * nor a later `pub mod a` takes the other's items. Chained local imports
 * resolve at their import sites, not where the call is written. An impl's
 * callback bounds, including `->` and nested return types, keep its methods.
 * A `mod` a block declares nearer the call than a `use` of the same name is
 * the module the head names, not that `use`'s path. An impl whose type takes
 * a const-generic block argument, in the type or in the impl's generics list,
 * keeps its associated functions, whatever operator the block uses.
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
    'src/lib.rs': 'pub mod inline;\npub mod local;\npub mod shadow;\npub mod order;\npub mod refimpl;\npub mod traits;\npub mod shapes;\npub mod store;\npub mod split;\npub mod callback;\npub mod near;\npub mod constarg;\n',
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

pub fn through_chained_use() -> usize {
    use crate::shadow::a as b;
    {
        use b as a;
        a::make()
    }
}

pub fn through_import_scope() -> usize {
    use crate::shadow::a as b;
    {
        use b as a;
        {
            use crate::shadow::b as b;
            a::make()
        }
    }
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
    'src/callback.rs': `pub struct Cache<F>(F);

impl<F: Fn() -> usize> Cache<F> {
    pub fn open(f: F) -> Self { Self(f) }
}

pub fn through_callback() {
    crate::callback::Cache::open(|| 1);
}

pub struct Nested<F>(F);

impl<F: Fn() -> Option<Result<usize, ()>>> Nested<F> {
    pub fn open(f: F) -> Self { Self(f) }
}

pub fn through_nested_callback() {
    crate::callback::Nested::open(|| Some(Ok(1)));
}
`,
    // `near`'s block declares a `mod b` nearer the call than the `use` that binds `b`, so
    // `b::make` is that module's. `far` has no such block: its `b` is `a`.
    'src/near.rs': `pub mod a {
    pub fn make() -> usize {
        1
    }
}

pub fn near() -> usize {
    use crate::near::a as b;
    {
        mod b {
            pub fn make() -> usize {
                2
            }
        }
        b::make()
    }
}

pub fn far() -> usize {
    use crate::near::a as b;
    {
        b::make()
    }
}
`,
    // Module `a`: the impl's type takes a const-generic block argument, `Cache<{ 1 + 1 }>`;
    // its `open` is still `Cache`'s, reached as `Cache::<2>::open` and as `Cache::open`.
    // Module `b`: the block sits in the impl's own generics list, `impl<T: Bound<{ 1 + 1 }>>`;
    // its `open` is still `Cache`'s, reached as `Cache::<()>::open`, which satisfies the bound.
    // Modules `c` to `f`: the const-generic block holds `<<`, `>>` or `>`, or is the first of two
    // type arguments (`Pair<{ 1 << 1 }, u8>`); each impl's `open` is still its own type's.
    'src/constarg.rs': `pub mod a {
    pub struct Cache<const N: usize>;
    impl Cache<{ 1 + 1 }> {
        pub fn open() -> usize {
            2
        }
    }
}

pub fn through_turbofish() -> usize {
    crate::constarg::a::Cache::<2>::open()
}

pub fn through_path() -> usize {
    crate::constarg::a::Cache::open()
}

pub mod b {
    pub trait Bound<const N: usize> {}
    pub struct Cache<T>(T);
    impl<T: Bound<{ 1 + 1 }>> Cache<T> {
        pub fn open() -> usize {
            3
        }
    }
    impl Bound<{ 1 + 1 }> for () {}
}

pub fn through_bound() -> usize {
    crate::constarg::b::Cache::<()>::open()
}

pub mod c {
    pub struct Cache<const N: usize>;
    impl Cache<{ 1 << 1 }> {
        pub fn open() -> usize {
            5
        }
    }
}

pub fn through_shl() -> usize {
    crate::constarg::c::Cache::open()
}

pub mod d {
    pub struct Cache<const N: usize>;
    impl Cache<{ 4 >> 1 }> {
        pub fn open() -> usize {
            6
        }
    }
}

pub fn through_shr() -> usize {
    crate::constarg::d::Cache::open()
}

pub mod e {
    pub struct Flag<const B: bool>;
    impl Flag<{ 2 > 1 }> {
        pub fn open() -> usize {
            7
        }
    }
}

pub fn through_flag() -> usize {
    crate::constarg::e::Flag::open()
}

pub mod f {
    pub struct Pair<const N: usize, T>(T);
    impl Pair<{ 1 << 1 }, u8> {
        pub fn open() -> usize {
            8
        }
    }
}

pub fn through_pair() -> usize {
    crate::constarg::f::Pair::open()
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

  it('follow a block import through an outer local alias before walking modules', () => {
    expect(calls('src/shadow.rs', 'through_chained_use')).toEqual(['function make src/shadow.rs:8']);
  });

  it('expand an imported alias in its import scope, not the call scope', () => {
    expect(calls('src/shadow.rs', 'through_import_scope')).toEqual(['function make src/shadow.rs:8']);
  });

  it('keep associated functions on impls with callback bounds and nested return types', () => {
    expect(calls('src/callback.rs', 'through_callback')).toEqual(['method Cache::open src/callback.rs:4']);
    expect(calls('src/callback.rs', 'through_nested_callback')).toEqual(['method Nested::open src/callback.rs:14']);
  });

  it('read a head a `mod` declared in a nearer block as that module, not as the `use` binding the same name', () => {
    expect(calls('src/near.rs', 'near')).not.toContain('function make src/near.rs:2');
  });

  it('expand a head a `use` binds when no nearer block declares a `mod` of that name', () => {
    expect(calls('src/near.rs', 'far')).toEqual(['function make src/near.rs:2']);
  });

  it('keep associated functions on an impl whose type takes a const-generic block argument', () => {
    expect(calls('src/constarg.rs', 'through_turbofish')).toEqual(['method Cache::open src/constarg.rs:4']);
    expect(calls('src/constarg.rs', 'through_path')).toEqual(['method Cache::open src/constarg.rs:4']);
  });

  it('keep associated functions on an impl whose generics list takes a const-generic block argument', () => {
    expect(calls('src/constarg.rs', 'through_bound')).toEqual(['method Cache::open src/constarg.rs:22']);
  });

  it('keep associated functions when a const-generic block in an impl header shifts left', () => {
    expect(calls('src/constarg.rs', 'through_shl')).toEqual(['method Cache::open src/constarg.rs:36']);
  });

  it('keep associated functions when a const-generic block in an impl header shifts right', () => {
    expect(calls('src/constarg.rs', 'through_shr')).toEqual(['method Cache::open src/constarg.rs:49']);
  });

  it('keep associated functions when a const-generic block in an impl header compares with >', () => {
    expect(calls('src/constarg.rs', 'through_flag')).toEqual(['method Flag::open src/constarg.rs:62']);
  });

  it('keep associated functions when a const-generic block is the first of two type arguments in an impl header', () => {
    expect(calls('src/constarg.rs', 'through_pair')).toEqual(['method Pair::open src/constarg.rs:75']);
  });
});
