from shop.models import Invoice, Order, Child, helper


def total(invoices: list[Invoice]) -> int:
    items: list[int] = []
    items.append(1)
    return sum(inv.total_price() for inv in invoices) + helper(2)


def make() -> Invoice:
    inv = Invoice(3)
    return inv


def dyn(o):
    return o.total_price()


class Service:
    def run(self) -> int:
        return self.step() + total([make()]) + Child().step()

    def step(self) -> int:
        return helper(1)
