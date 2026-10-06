// Members with no body are a `declaration` wrapping their signature; their
// dartdoc and annotations sit before the wrapper.

abstract class Store {
  /// Abstract method doc.
  Future<void> save(Object value);

  /// Doc above an annotation.
  @protected
  void flush();

  @mustCallSuper
  @Deprecated('use flush')
  void sync();

  /// Abstract getter doc (no node).
  int get size;

  /// Abstract setter doc (no node).
  set size(int v);

  /// Abstract operator doc (no node).
  Store operator +(Store other);

  /** Block dartdoc on an external member. */
  external int nativeCount();

  /// Static external doc.
  external static Store open();

  // Plain comment on an abstract member.
  bool isEmpty();
}

class Point {
  /// Unnamed constructor doc (no node).
  Point(this.x, this.y);

  /// Named constructor doc.
  /// Second line.
  Point.origin() : x = 0, y = 0;

  /// Redirecting constructor doc.
  Point.onX(int x) : this(x, 0);

  @visibleForTesting
  Point.test(this.x, this.y);

  /// Before annotation.
  @Deprecated('use origin')
  /// After annotation.
  Point.zero() : x = 0, y = 0;

  /* é */ @visibleForTesting Point.inline(this.x) : y = 0;

  /// Field doc.
  @observable
  final int x;
  Point.afterField(this.x, this.y);

  @first
  Point.prev(this.x, this.y);
  Point.next(this.x, this.y);

  final int y;

  /// Const constructor doc.
  @literal
  const Point.c(this.x, this.y);

  /// Redirecting factory doc.
  const factory Point.r(int x, int y) = Point;

  /// Bodied named constructor doc.
  @visibleForTesting
  Point.bodied(this.x, this.y) {
    validate();
  }

  void validate() {}
}

mixin Walker {
  /// Mixin abstract doc.

  void walk();
}

extension Ext on String {
  /// Extension external doc.
  @pragma('vm:prefer-inline')
  external String shout();
}

extension type Meters(double value) {
  /// Extension type external doc.
  external double km();
}

enum Mode {
  on,
  off;

  /// Enum const constructor doc (no node).
  const Mode();

  /// Enum external doc.
  external bool get isOn;

  /// Enum external method doc.
  external void toggle();
}
