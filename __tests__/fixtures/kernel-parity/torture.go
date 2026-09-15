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

// Markdown path references: code -> documentation edges. Every shape the
// normalizer branches on, so the two arms have to agree about the rejections
// (URL, escape above the root) as well as the emissions.
var mdGuide = "../docs/guide.md#install"
var mdBare = "README.md"
var mdRooted = "/docs/rooted.md"
var mdEscapes = "../../../../outside.md"
var mdRemote = "https://example.com/remote.md"
var mdQueried = "./notes.md?raw=1#top"
var mdTwoInOne = "see a.md and also sub/b.mdx"

func mdLoad() {
	loadDoc("docs/deep/nested.markdown")
}
