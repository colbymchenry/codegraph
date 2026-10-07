// An annotation belongs to the declaration after it, whatever comments come
// between them; the decorator scan steps over `//`, `/* */`, `///` and
// `/** */` comments. Anything else before the annotations still ends it.

import 'package:meta/meta.dart';
// A comment after the import.
@visibleForTesting
// And one below the annotation.
void afterImport() {}

@x // A comment on the annotation's line.
void trailing() {}

@override
// ignore: must_call_super
void lineBelow() {}

@x
/// Doc below an annotation.
void docBelow() {}

@x
/** Block doc below an annotation. */
void blockDocBelow() {}

@x
/* A block comment. */
void blockBelow() {}

@a
// one
@b
/// two
/* three */
@c
// four
void interleaved() {}

@riverpod
// expect_lint: functional_ref
int counter(Ref ref) => 0;

@x
// A comment.

void blankLines() {}

@pragma('vm:external-name', 'f')
// A comment.
external int extTop();

@x
// A comment.
int get topGetter => 1;

@x
final answer = 42;
// A comment.
void afterVariable() {}

void before() {} // A trailing comment.
@x
void afterBody() {}

class C {
  @override
  // ignore: must_call_super
  void method() {}

  @x /* inline */ void inline() {}

  @override
  // A comment.
  void bodiless();

  @x
  // A comment.
  C.named() {}

  @literal
  // A comment.
  const C.c();

  @x
  /// Doc below.
  factory C.make() => C._();

  @x
  // A comment.
  const factory C.r() = C.c;

  @x
  // A comment.
  static void s() {}

  @override
  // A comment.
  bool operator ==(Object other) => true;

  @override
  // A comment.
  int get value => 1;

  @override
  // A comment.
  set value(int v) {}

  @x
  // A comment.
  external void ext();

  /// Doc above.
  @a
  // between
  @b
  void docAbove() {}

  @JsonKey(name: 'f')
  final int f = 0;
  // A comment after a field.
  @override
  void afterField() {}

  void prior() {} // A trailing comment.
  @override
  void afterMember() {}

  C._();
}

@immutable
// ignore: something
class D {}

@internal
// A comment.
mixin M on C {
  @mustCallSuper
  // A comment.
  void m() {}
}

@internal
// A comment.
extension X on C {
  @pragma('vm:prefer-inline')
  // A comment.
  void e() {}
}

@internal
/// Doc below.
extension type Meters(double value) {
  @redeclare
  // A comment.
  double km() => value / 1000;
}

enum Mode {
  @JsonValue('on')
  // A comment.
  on,
  off;

  @override
  // A comment.
  String toString() => name;
}

void outer() {
  @pragma('vm:prefer-inline')
  // A comment.
  void local() {}
  local();
}
