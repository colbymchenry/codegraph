// Go torture fixture — receivers, embedding, interfaces, composite literals.
package torture

import (
	"fmt"
	pkga "example.com/other/pkga"
)

const MAX_ITEMS = 128 // the line's own comment, not DefaultRegistry's doc

var DefaultRegistry = NewRegistry()

var handlerTable = map[string]func(int){
	"recv": TargetCb,
}

// Widget is documented above its own type declaration.
type Widget struct {
	*Base
	Queryable
	pkga.Embedded
	*pkga.Pointer `json:"-"`
	Stack[int]
	error
	name string
}

type Stack[T any] struct {
	items []T
}

// Units of time: the group's comment, no member's doc.
type (
	Seconds int
	// Minutes is documented inside its group.
	Minutes int
)

type Core interface {
	Reader
	pkga.Closer // qualified
	Lister[int]
	error
	Marshal(v any) ([]byte, error)
	Unmarshal(data []byte) error
}

type Number interface {
	~int | ~float64
}

type Exact interface{ int64 }

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
