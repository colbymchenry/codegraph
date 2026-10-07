import { Invoice, Order, Registry, helper } from './models';

export function sum(invoices: Invoice[]): number {
  const list: number[] = [];
  list.push(1);
  return invoices.reduce((acc, inv) => acc + inv.totalPrice(), 0) + helper(2);
}

export const arrow = (o: Order) => o.totalPrice();

export function make(): Invoice {
  const i = new Invoice(3);
  return i;
}

export function dyn(o: any): number {
  return o.soloMethod();
}

class Service {
  run(): number {
    return this.step() + sum([make()]);
  }
  private step(): number {
    return helper(1);
  }
}

export function usesOverloads(r: Registry): number {
  r.lookup('a');
  return r.lookup(1);
}

// A call keyed where its expression starts: totalPrice sits on the next line.
export function chained(): number {
  return new Invoice(4)
    .totalPrice();
}
