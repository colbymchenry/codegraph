// A member's annotations sit between it and the dartdoc written above them;
// the docstring walk steps over them. A class-like declaration opens with its
// annotations, so the dartdoc above them precedes its node.

import 'package:meta/meta.dart';

@visibleForTesting
void afterImport() {}

/// Top function doc.
@pragma('vm:entry-point')
void top() {}

/// External top doc.
@pragma('vm:external-name', 'f')
external int extTop();

/// Stacked, prefixed and generic annotations.
@meta.immutable
@JsonSerializable<Foo>(explicitToJson: true)
@Deprecated('x')
void stacked() {}

/// Top getter doc (no node).
@x
int get topGetter => 1;

/** Block dartdoc above an annotation. */
@x
void blockDoc() {}

// Plain comment above an annotation.
@x
void plainAbove() {}

/* Inline block */ @x void inlineBlock() {}

/// a
@x
// b
@y
/* c */
void interleaved() {}

/// Doc, then blank lines.

@x

void blanks() {}

/// A variable's doc.
final answer = 42;
@x
void afterVariable() {}

const kLimit = 3;
@x
void afterConst() {}

class C {
  /// Operator doc.
  @override
  bool operator ==(Object other) => true;

  /// Factory doc.
  @x
  factory C.make() => C._();

  /// Bodied constructor doc.
  @x
  C.named() {}

  /// Static method doc.
  @x
  static void s() {}

  /// External member doc.
  @x
  external void extMember();

  /// Bodiless member doc.
  @override
  void bodiless();

  /// Const constructor doc.
  @literal
  const C.c();

  /// Redirecting factory doc.
  @x
  const factory C.r() = C.c;

  /// Static field doc.
  @x
  static const int k = 1;
  @x
  void afterStaticField() {}

  /// Multi-line annotation.
  @Deprecated(
    'Use other. '
    'Removed in 3.0',
  )
  void multi() {}

  @override // ignore: must_call_super
  void trailingComment() {}

  /// Doc above, ignore below.
  @override
  // ignore: invalid_use_of_protected_member
  void ignoreBelow() {}

  @x
  /// Doc below an annotation.
  void docBelow() {}

  /// Field doc.
  @JsonKey(name: 'x')
  final int field = 0;
  @override
  void afterField() {}

  void before() {} // trailing comment
  @override
  void afterBody() {}

  /// Getter doc.
  @override
  int get value => 1;

  /// Setter doc.
  @override
  set value(int v) {}

  C._();
}

/// Class doc above a comment.
@immutable
// ignore: something
class D {}

@immutable
/// Class doc below an annotation.
class E {}

/// Mixin doc.
@internal
mixin M on C {
  /// Mixin member doc.
  @mustCallSuper
  void m() {}
}

/// Extension doc.
@internal
extension X on C {
  /// Extension member doc.
  @pragma('vm:prefer-inline')
  void e() {}
}

/// Extension type doc.
@internal
extension type Meters(double value) {
  /// Extension type member doc.
  @redeclare
  double km() => value / 1000;
}

/// Enum doc.
@JsonEnum()
enum Mode {
  @JsonValue('on')
  on,
  off;

  /// Enum member doc.
  @override
  String toString() => name;
}

/// Typedef doc.
@internal
typedef Cb = void Function();

void outer() {
  /// Local function doc.
  @pragma('vm:prefer-inline')
  void local() {}
  local();
}
