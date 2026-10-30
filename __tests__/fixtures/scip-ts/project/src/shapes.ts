export interface Shape {
  area(): number;
}

export class Square implements Shape {
  constructor(private side: number) {}
  area(): number {
    return this.side * this.side;
  }
}

export class Cube extends Square {
  volume(): number {
    return this.area() * 2;
  }
}

export function total(shapes: Shape[]): number {
  return shapes.reduce((n, s) => n + s.area(), 0);
}

// Implements an interface from the standard library: `it.next()` resolves to Iterator#next, which has no node.
export class Countdown implements Iterator<number> {
  constructor(private n: number) {}
  next(): IteratorResult<number> {
    return this.n > 0 ? { value: this.n--, done: false } : { value: 0, done: true };
  }
}

export function first(it: Iterator<number>): number {
  return it.next().value;
}
