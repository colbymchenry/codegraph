// Go torture fixture — receivers, embedding, interfaces, composite literals.
package torture

import (
	"fmt"
	pkga "example.com/other/pkga"
)

const MAX_ITEMS = 128 // the line's own comment, not DefaultRegistry's doc

// Limits: the group's comment, for a member without its own.
const (
	// MinItems is documented inside its group.
	MinItems = 1
	MaxSlots = 64
)

var DefaultRegistry = NewRegistry()

var handlerTable = map[string]func(int){
	"recv": TargetCb,
}

// Registries: the group's comment, for a member without its own.
var (
	// handlersByName is documented inside its group.
	handlersByName = map[string]func(int){"recv": TargetCb}
	DefaultWidget  = NewRegistry()
)

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

// Containers: a banner a blank line separates from Stack, not its doc.

type Stack[T any] struct {
	items []T
}

// A struct references the types its fields are declared with, but the types
// it embeds (supertypes), its own type parameters, predeclared types and its
// own name written bare.
type Server struct {
	handlers HandlersChain
	byKey    map[Dur][]*Widget `json:"by_key"`
	events   <-chan pkga.Item
	grid     [MAX_ITEMS]Widget
	cb       func(ctx pkga.Context, w *Widget) (*Stack[int], error)
	a, b     Widget
	nested   struct {
		w Widget
		*Base
	}
	codec interface {
		Encode(pkga.Item) ([]byte, error)
	}
	*pkga.Lister[*Widget, pkga.Item]
	next *Server
	n    int
}

type Pool[T any] struct {
	items []T
	next  *Pool[T]
	Stack[T]
	extra Widget
}

type AnonFields = struct {
	w Widget
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

// An interface method references the types its signature names, but the
// interface's own type parameters and the predeclared types.
type Repo[T any] interface {
	Find(ctx pkga.Context, id Dur) (*Widget, error)
	Each(fn func(T, *Stack[int]) bool) []pkga.Item
	Self() Repo[T]
}

type Number interface {
	~int | ~float64
}

type Exact interface{ int64 }

type Dur int

// Aliases (`=`): the types they name are references; a literal makes a struct or interface.
type Alias = pkga.Widget

type (
	LocalAlias = Widget
	PtrAlias   = *Stack[int]
	FnAlias    = func(w Widget) error
	MapAlias   = map[string][]pkga.Item
	Defined    Widget
)

type AnonAlias = struct {
	*Base
	n int
}

type IfaceAlias = interface {
	Render() string
}

type WordAlias = uint

// Defined types reference what they are defined from, but their own type
// parameters, predeclared types and their own name written bare.
type HandlerFunc func(*Widget, pkga.Item) error

type HandlersChain []HandlerFunc

type WatchChan <-chan *Stack[int]

type (
	Lookup  map[Dur][]*pkga.Widget
	Grid    [MAX_ITEMS]Widget
	Wrapped (Widget)
	Item    pkga.Item
	Nested  map[string]struct {
		w Widget
		*Base
	}
)

type Tree[T any] []*Tree[T]

type stateFn func(*Widget) stateFn

func useAlias(a *Alias) LocalAlias {
	return LocalAlias{}
}

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

// Callbacks: a section comment above TargetCb's own doc.

// TargetCb is documented right above.
func TargetCb(n int) {}

func shadowed() {
	MAX_ITEMS := 5
	fmt.Println(MAX_ITEMS)
}

// reads is documented above a directive, which is no part of its doc.
//go:noinline
func reads() int {
	return MAX_ITEMS
}
