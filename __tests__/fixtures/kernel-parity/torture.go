// Go torture fixture — receivers, embedding, interfaces, composite literals.
package torture

import (
	"fmt"
	pkga "example.com/other/pkga"
)

const MAX_ITEMS = 128

var DefaultRegistry = NewRegistry()

var handlerTable = map[string]func(int){
	"recv": TargetCb,
}

type Widget struct {
	*Base
	Queryable
	name string
}

type Stack[T any] struct {
	items []T
}

type Core interface {
	Reader
	Marshal(v any) ([]byte, error)
	Unmarshal(data []byte) error
}

type Dur int

func NewRegistry() *Registry {
	w := Widget{name: "w"}
	q := pkga.Widget{}
	fmt.Println(w, q, MAX_ITEMS)
	cfg := loadConfig()
	cfg.conn.Exec("x")
	return New().Init()
}

func (s *Stack[T]) Push(item T) {
	s.items = append(s.items, item)
}

func (w Widget) Render() string {
	return w.name
}

func TargetCb(n int) {}

func shadowed() {
	MAX_ITEMS := 5
	fmt.Println(MAX_ITEMS)
}

func reads() int {
	return MAX_ITEMS
}
