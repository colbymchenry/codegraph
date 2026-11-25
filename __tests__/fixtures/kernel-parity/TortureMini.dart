import 'dart:async';
import 'package:foo/bar.dart' as bar show Baz hide Qux;
import 'pkg.dart' deferred as lazy;
export 'src/out.dart' show Pub;
part 'part1.dart';

/// Doc line one.
/// Doc line two.
void topFn(int a, String b) {
  var local = 5;
  int typed = 6;
  final con = 7;
  int uninit;
  uninit = 8;
  local = a;
  helper(a);
  obj.method(a);
  Config.setting;
  Config.load();
  w?.render();
  list..add(1)..add(2);
  final w2 = Widget(1);
  final w3 = new Widget(2);
  const e = EdgeInsets.all(8.0);
  Foo.create().run();
  lower().chain();
  print('sum ${a + compute()} $local');
}

// plain comment
int get topGetter => 42;
set topSetter(int v) {}

class Widget extends Base with Mix1, Mix2 implements Draw, Paint {
  static const int kMax = 10;
  static final shared = Widget(0);
  final int size;
  int count = 0;
  var loose;
  late String name;
  Widget(this.size);
  Widget.named(this.size) { init(); }
  factory Widget.create() => Widget(1);
  Widget._() : size = 0;
  @override
  void render(Canvas c) { c.draw(); }
  static Widget make() => Widget(3);
  int get area => size * size;
  set area(int v) { count = v; }
  Future<void> load() async { await fetch(); }
  operator +(Widget o) => Widget(size + o.size);
}

mixin Mix1 on Base {
  void mixMethod() { helper(0); }
}

extension WidgetExt on Widget {
  void extMethod() { render(null); }
}

enum Color { red, green, blue }

enum Status with Mix1 implements Draw {
  ok(200),
  err(500);
  final int code;
  const Status(this.code);
  bool get good => code < 400;
  static Status parse(int c) => ok;
}

typedef IntFn = int Function(int);
typedef void OldStyle(int x);

abstract class Base {}
class Draw {}
