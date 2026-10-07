export class Invoice {
  constructor(public amount: number) {}
  totalPrice(): number {
    return this.amount * 2;
  }
}

export class Order {
  totalPrice(): number {
    return 1;
  }
}

export class Stack {
  push(n: number): number {
    return n;
  }
}

export class Solo {
  soloMethod(): number {
    return 0;
  }
}

export function helper(x: number): number {
  return x + 1;
}

export class Registry {
  lookup(key: number): number;
  lookup(key: string): string;
  lookup(key: number | string): number | string {
    return key;
  }
}
