/// Parity fixture for #1838 / #1839: function-like macros as `constant`
/// nodes (file scope, inside a namespace, inside a body), constructor
/// signatures, and the per-declarator constructor refs of local object
/// initialization — default, direct, brace, multi-declarator, qualified and
/// template types — beside the declarators that construct nothing (pointer,
/// reference, array, most-vexing-parse, extern). Must parse ERROR-FREE.
#define TRACE_POINT(value) ((void)(value))
#define VERSION 7

namespace app {
#define APP_LOG(fmt, ...) log_impl(fmt, __VA_ARGS__)

struct Aggregate {
  int value;
};

class Widget {
public:
  Widget();
  explicit Widget(int value);
  Widget(int a, int b = 2) : first(a), second(b) {}

private:
  int first;
  int second;
};

Widget::Widget() : first(0), second(0) {}
Widget::Widget(int value) : first(value), second(0) {}

template <typename T>
struct Box {
  Box(T inner) : value(inner) {}
  T value;
};

void constructions() {
  Aggregate item{};
  Widget by_default;
  Widget braced{};
  Widget direct(1);
  Widget two(1, 2);
  Widget a, b(1), c{1, 2};
  app::Widget qualified(3);
  Box<int> boxed(4);
  Widget();
  TRACE_POINT(VERSION);
  APP_LOG("x", 1);
#define LOCAL_TRACE(v) ((void)(v))
  LOCAL_TRACE(1);
}

void non_constructions(Widget &other) {
  Widget *pointer{};
  Widget *null_pointer(nullptr);
  Widget &reference{other};
  Widget &bound(other);
  Widget most_vexing();
  Widget items[2]{};
  Widget *table[2]{};
  Widget (*callback)(){};
  extern Widget external;
  int primitive(5);
  int braced_primitive{6};
}
}  // namespace app
