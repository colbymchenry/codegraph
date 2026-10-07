class Invoice:
    def __init__(self, amount: int) -> None:
        self.amount = amount

    def total_price(self) -> int:
        return self.amount * 2


class Order:
    def total_price(self) -> int:
        return 1


class Stack:
    def push(self, n: int) -> int:
        return n

    def append(self, n: int) -> int:
        return n


class Base:
    def step(self) -> int:
        return 0


class Child(Base):
    def step(self) -> int:
        return super().step() + 1


def helper(x: int) -> int:
    return x + 1
