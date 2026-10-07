package shop

import "strings"

type Pricer interface {
	TotalPrice() int
}

type Invoice struct {
	Amount int
}

func NewInvoice(amount int) *Invoice {
	return &Invoice{Amount: amount}
}

func (i *Invoice) TotalPrice() int {
	return i.Amount * 2
}

type Order struct{}

func (Order) TotalPrice() int {
	return 1
}

type Base struct{}

func (Base) Step() int {
	return 0
}

type Child struct {
	Base
}

func Helper(x int) int {
	return x + len(strings.TrimSpace(" a "))
}

func Map[T any](xs []T, f func(T) int) []int {
	out := make([]int, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}
