// Dart 3.13 primary and concise constructors (#3270), and the named
// constructors called with type arguments that tree-sitter-dart 0038280 reads
// as comparisons and a dot shorthand.
import 'box.dart' as p;

/// Was a class named `const`.
class const Foo({required final int a, super.key}) extends StatelessWidget {
  int get b => a;
}

class Point(final Offset origin, {required var Size size, Paint? paint}) {
  int sum() => origin.dx + size.width;
}

class const Bar.zero(final Report v) implements Baz {
  const Bar.one() : this.zero(1);
}

abstract final class _M() {
  static void f() {}
}

class Label(String text) extends Widget {
  final String upper;
  @override
  this : upper = text.toUpperCase() {
    log(upper);
  }
}

enum const Tone(final Color color) {
  light(Color(1)), dark(Color(0));
  this : assert(color != null);
}

extension type const Meters.of(final double value);

mixin Empty;

class Concise {
  const new();
  new named(this.x);
  new () {}
  const new _hidden();
  factory make() => Concise.named(1);
  factory() => Concise();
  const factory redirect() = Concise.new;
  final int x;
}

Widget arrow() => BlocProvider<CounterCubit>.value(value: c, child: w);

Future<Object> calls(Object c) async {
  final s = StreamController<Event>.broadcast();
  g(x: BlocProvider<CounterCubit>.value(value: c));
  await Future<void>.delayed(d);
  final l = [Box<Item>.named(1), Box<p.Item>.named(2), -Box<Item>.named(3)];
  final m = {'k': Pair<Item, Item>.of(x)};
  h(y: Pair<Item, p.Gem>.of(x), z: 2);
  final r = (Pair<Gem, Item>.of(x), 3);
  final q = p.Box<Item>.named(3);
  final t = _Box<Item>.named(4).value;
  final u = List<Map<String, Item>>.from(v);
  final $v = $Gen<Item>.make();
  BlocProvider<CounterCubit>.value(value: c);
  p.Box<Item>.named(5);
  p.Pair<Item, Gem>.of(6).first;
  _Box<Item>.named(7);
  final ok = items.any((i) => i.id == context.read<Cubit>().state.id);
  final off = list.where((e) => !context.watch<Bloc>().busy);
  final lt = a < b, gt = c > .zero;
  await p.Box<Item>.named(8);
  final aw = await p.Pair<Item, Gem>.of(9);
  return Future<int>.value(1).then((v) => v);
}
