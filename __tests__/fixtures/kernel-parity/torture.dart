/// File-level doc for torture (glued to import? no — imports precede nothing).
import 'dart:async';
import 'package:torture/other.dart' as other show OtherClass;
export 'src/reexported.dart' hide Hidden;
part 'torture_part.dart';

/// Doc line one.
/// Doc line two.
void topLevel(int count, String label) {
  helper(count);
}

/** Block dartdoc kept. */
int blockDoc() => 1;

// Plain comment doc.
String plainDoc() => 'x';

/// Broken by annotation.
@deprecated
void annotated() {}

@Deprecated('with args')
@pragma('vm:entry-point')
void doubleAnno() {}

const SHARED_MAX = 10;
final DERIVED_VAL = SHARED_MAX + 1;
const lowercase_const = 1;
final typedTop = compute();
var topVar = 5;
int topTyped = 6;
final multiA = 1, multiB = 2;

int get topGetter => 7;
set topSetter(int v) {}

Future<String> asyncFn() async => 'a';
Stream<int> genStar() async* {
  yield 1;
}
Iterable<int> syncStar() sync* {
  yield 2;
}

num numback(num n) => n;
dynamic dyn(dynamic d) => d;
Object obj(Object o) => o;
List<WidgetT> listRet(Map<String, WidgetT> m) => [];
WidgetT? nullableRet() => null;
other.OtherClass prefixedRet() => other.OtherClass();
T generic<T>(T v) => v;

external void externalFn();

void params({int? named, required WidgetT child, String note = 'x'}) {}
void optionals([int pos = 0, WidgetT? w]) {}
void fnTyped(void cb(int x), int Function(String) modern) {}

void bodyShapes(List<int> xs, Object o) {
  var local = 1;
  int typed = 2;
  final con = 3;
  int uninit;
  uninit = 4;
  local = uninit;
  helper(local);
  obj.method(local);
  this_like.deep.call3(local);
  ConfigT.load();
  ConfigT.setting;
  w?.render();
  y2..add(1)..add(2);
  final w1 = WidgetT(1);
  final w2 = new WidgetT(2);
  pad(const EdgeInsetsT.all(8.0));
  FactoryT.create().run();
  lower().chain();
  WidgetT.named(3).chainTail();
  xs.map((e) => e * 2).toList();
  xs.forEach((e) => use(e));
  final lam = (int a) {
    helper(a);
  };
  lam(5);
  void localFn(int n) {
    inner(n);
  }
  localFn(6);
  if (o is WidgetT) {
    use(o);
  }
  final cast = o as WidgetT;
  final tl = <WidgetT>[];
  throw StateError('bad');
}

void interpolation(int count) {
  log('count $count and ${SHARED_MAX} via ${refresh()}');
}

void refTaker() {
  register(topLevel);
  obj.cb = topLevel;
  final table = [topLevel, blockDoc];
  final m = {'k': topLevel, 'x': undefinedName};
  reg2(cb: topLevel);
  forward(topLevel: topLevel);
  final alias = topLevel;
}

/// Class doc.
@immutable
class WidgetT extends BaseT with MixA, MixB implements DrawT {
  static const int K_MAX = 9;
  static final sharedInst = WidgetT(0);
  static var mutableStatic = 1;
  final int size;
  final untyped = 5;
  int counter = 0;
  late String title;
  WidgetT(this.size);
  WidgetT.named(this.size) {
    init();
  }
  WidgetT.bodilessNamed() : size = seed();
  factory WidgetT.create() => WidgetT(1);
  const factory WidgetT.redir() = WidgetT2;
  @override
  void render(CanvasT c) {
    c.draw();
  }
  static WidgetT make() => WidgetT(3);
  int get area => size * size;
  set area(int v) {
    counter = v;
  }
  bool get privado => _check();
  bool _check() => true;
  Future<void> load() async {
    await fetch();
  }
  WidgetT operator +(WidgetT o) => WidgetT(size + o.size);
  void useLocalNew() {
    final h = new HolderT(2);
    use(h);
  }
  void readsConst() {
    use(K_MAX);
  }
}

class WidgetT2 extends WidgetT {
  WidgetT2() : super(0);
  void _privateMethod() {}
}

class BaseT {}

class DrawT {}

class OnlyMix with MixA {}

abstract class AbstractT {
  void mustImpl(WidgetT w);
  int get abstractGetter;
}

sealed class ShapeT {}

class CircleT extends ShapeT {}

mixin MixA on BaseT {
  void mixMethod() {
    helper(1);
  }
}

mixin MixB implements DrawT {
  int get mixGetter => 2;
}

extension WidgetTExt on WidgetT {
  void extMethod() {
    render(CanvasT());
  }

  int get extGetter => 4;
}

extension on String {
  void anonExt() {}
}

enum ColorT { red, green, blue }

/// Enum doc.
enum StatusT with MixB implements DrawT {
  ok(200),
  err(500);

  final int code;
  const StatusT(this.code);
  bool get good => code < 400;
  static StatusT parse(int c) => ok;
}

typedef IntFn = int Function(int);
typedef void LegacyCb(int x);
typedef MapAlias = Map<String, WidgetT>;

extension type MetersT(double value) {
  double get km => value / 1000;
}

void patternUser(Object o) {
  final v = ColorT.red;
  switch (o) {
    case ColorT.blue:
      use(v);
    default:
      break;
  }
  final (a, b) = (1, 2);
  use(a);
}

// π unicode: “smart quotes” précède — column check ☕
void afterUnicode(String seance) {
  emit('café ☕ done');
}
