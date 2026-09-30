package shop

import "fmt"

func Total(invoices []*Invoice) int {
	sum := 0
	for _, inv := range invoices {
		sum += inv.TotalPrice()
	}
	return sum + Helper(2)
}

func Make() *Invoice {
	inv := NewInvoice(3)
	return inv
}

func Dyn(p Pricer) int {
	return p.TotalPrice()
}

func Promoted() int {
	c := Child{}
	return c.Step()
}

func Generic() []int {
	return Map([]*Invoice{Make()}, func(i *Invoice) int { return i.TotalPrice() })
}

type Service struct{}

func (s Service) Run() int {
	fmt.Println("run")
	return s.step() + Total([]*Invoice{Make()})
}

func (s Service) step() int {
	return Helper(1)
}
