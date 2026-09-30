pub trait Pricer {
    fn total_price(&self) -> i64;
}

pub struct Invoice {
    pub amount: i64,
}

impl Invoice {
    pub fn new(amount: i64) -> Invoice {
        Invoice { amount }
    }
}

impl Pricer for Invoice {
    fn total_price(&self) -> i64 {
        self.amount * 2
    }
}

pub struct Order;

impl Pricer for Order {
    fn total_price(&self) -> i64 {
        1
    }
}

pub struct Stack {
    items: Vec<i64>,
}

impl Stack {
    pub fn push(&mut self, n: i64) -> i64 {
        self.items.push(n);
        n
    }
}

pub fn helper(x: i64) -> i64 {
    x + 1
}

pub fn map_all<T, F: Fn(&T) -> i64>(xs: &[T], f: F) -> Vec<i64> {
    xs.iter().map(|x| f(x)).collect()
}
