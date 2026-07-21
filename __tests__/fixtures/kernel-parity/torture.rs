//! Torture fixture for the rust kernel walker (R7b) — every quirk in
//! docs/design/rust-lang-kernel-port-checklist.md, parse-clean.

use std::fmt;
use crate::mod_a::Item;
use crate::mod_b::{A, B as C, sub::D};
use a::{b::{c, d}};
use foo_single;
use std::collections::*;

/// Widget docs.
pub struct Widget {
    pub n: u32,
    name: String,
    field: Deep,
}

pub struct Unit;

pub struct Pair(u32, u32);

/// Doc broken by the attribute below — must yield NO docstring.
#[derive(Debug)]
pub struct Doc {
    x: u32,
}

pub struct Deep {
    z: u32,
}

pub enum Shape {
    Circle(f32),
    Rect { w: f32, h: f32 },
    Empty,
}

pub type Alias = Vec<Widget>;

/// Render trait docs.
pub trait Render: Base + fmt::Debug {
    fn render(&self);
    fn hint(&self) -> Size {
        Size::default()
    }
    const CAP: usize = init_cap();
    type Output;
}

pub trait Base {}

pub trait Super2: Producer<u32> {}

pub trait Owned: for<'de> Deserialize<'de> {}

impl Render for Widget {
    fn render(&self) {
        draw(self);
    }
}

impl fmt::Display for Widget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "w{}", self.n)
    }
}

impl Widget {
    const SCALE: usize = 3;

    fn area(&self) -> u32 {
        self.n * mul()
    }

    fn clone_self(&self) -> Self {
        Self::assoc();
        Widget {
            n: self.n,
            name: String::new(),
            field: Deep { z: 0 },
        }
    }

    fn borrow_widget(&self) -> &Widget {
        self
    }

    fn outer(&self) -> u32 {
        fn inner_helper(v: u32) -> u32 {
            v
        }
        inner_helper(self.n)
    }
}

pub struct Container<T> {
    item: T,
}

impl<T> Container<T> {
    fn unwrap(self) -> T {
        self.item
    }
}

impl Render for Container<u32> {
    fn render(&self) {}
}

impl Later {
    fn touch(&self) {}
}

pub struct Later {
    z: u32,
}

/* Block-doc for an async fn — isAsync must stay FALSE (dead-code hook). */
pub async fn fetch_data(url: &str) -> Result<Response, Error> {
    let body = get(url).await;
    client.request().await.send();
    body
}

pub fn nested_ret() -> Result<Vec<Widget>, Error> {
    make_result()
}

pub fn vec_ret(w: &Widget) -> Vec<Widget> {
    build_list(w)
}

pub(crate) fn crate_fn() {}

fn caller() {
    let w = Widget {
        n: 1,
        name: make_name(),
        field: Deep { z: 1 },
    };
    let v = m::Widget { n: 2 };
    let r = Foo::new().bar();
    let x = w.method_a().chain_b();
    let y = w.field.deep_call();
    let s = "lit".len();
    let f = 5.0_f64.floor();
    helper();
    m::helper2();
    let t = helper::<u32>(3);
    (helper)(1);
    takes(Widget {
        n: 3,
        name: n2(),
        field: Deep { z: 2 },
    });
}

fn handler() {}
fn handler2() {}
fn cb_a() {}
fn cb_b() {}
fn invoke_all(fns: [fn(); 2]) {}

fn register(f: fn()) {
    f();
}

pub struct Holder {
    cb: fn(),
}

fn wiring(mut o: Holder) {
    register(handler);
    o.cb = handler2;
    let h = Holder { cb: cb_a };
    let arr = [cb_a, cb_b];
    let local = handler;
    let (t1, t2) = (cb_a, cb_b);
    invoke_all(arr);
    invoke(foo_single);
}

static CB: fn() = handler;

const MAX_LIMIT: u32 = OTHER_LIMIT;
const OTHER_LIMIT: u32 = 99;

fn reads_limits() -> u32 {
    MAX_LIMIT + OTHER_LIMIT
}

fn shadowed_read() {
    let MAX_LIMIT = 5;
    let _ = MAX_LIMIT;
}

mod inner {
    pub fn helper_pub() {}
    fn hidden() {}
    pub struct Item2 {
        pub v: u32,
    }
}

fn mount() {
    let r = routes![a::b::index_h, health_h];
    let c = catchers![not_found_h];
    let skipped = rocket::routes![a::x];
}

routes![top_level_h];
