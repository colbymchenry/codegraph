pub mod models;

use models::{helper, map_all, Invoice, Order, Pricer};

pub fn total(invoices: &[Invoice]) -> i64 {
    let mut items: Vec<i64> = Vec::new();
    items.push(1);
    invoices.iter().map(|inv| inv.total_price()).sum::<i64>() + helper(2)
}

pub fn make() -> Invoice {
    let inv = Invoice::new(3);
    inv
}

pub fn literal() -> Invoice {
    Invoice { amount: 4 }
}

pub fn dyn_call(p: &dyn Pricer) -> i64 {
    p.total_price()
}

pub fn generic() -> Vec<i64> {
    map_all(&[make()], |i| i.total_price()) 
}

pub struct Service;

impl Service {
    pub fn run(&self) -> i64 {
        println!("run");
        self.step() + total(&[make(), literal()]) + Order.total_price()
    }

    fn step(&self) -> i64 {
        helper(1)
    }
}

pub enum Shape {
    Circle(i64),
    Square { side: i64 },
}

pub fn shapes() -> Shape {
    let _square = Shape::Square { side: 2 };
    Shape::Circle(1)
}

pub fn wrapped() -> Option<i64> {
    Some(helper(1))
}

pub fn chained() -> i64 {
    Invoice::new(5)
        .total_price()
}
