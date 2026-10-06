import 'package:meta/meta.dart';
import 'package:other/other.dart' as p;

const kDepth = 3;

/// A provider with const constructors and redirecting factories.
class ProviderT<T> {
  /// The unnamed const constructor: no node.
  const ProviderT({required this.create, this.lazy = true}) : _value = null;

  /// A named const constructor that redirects.
  const ProviderT.value({required T value, int depth = kDepth})
      : this._(value: value);

  @visibleForTesting
  const ProviderT._({T? value})
      : create = null,
        lazy = false,
        _value = value;

  const factory ProviderT.redirect({int a}) = _ImplT<T>;

  factory ProviderT.plain() = _ImplT<T>.named;

  const factory ProviderT.json(Map<String, Object?> json) = _ImplT.fromJson;

  const factory ProviderT.prefixed() = p.OtherT;

  const factory ProviderT.prefixedNamed() = p.OtherT.named;

  const factory ProviderT.unnamedTarget() = _ImplT;

  const factory ProviderT() = _ImplT.named;

  final Object? create;
  final bool lazy;
  final T? _value;

  void handle(Object value) => accept(value);

  static ProviderT<int> make() => ProviderT<int>.value(value: 1);

  static Object typed(dynamic box) {
    ProviderT<int>.value(value: 2);
    final made = ProviderT<int>.value(value: 3);
    accept(ProviderT<int>.value(value: 4));
    wrap(child: ProviderT<int>.value(value: 5));
    box.inner.value(6);
    return p.OtherT<int>.named(made);
  }
}

class _ImplT<T> extends ProviderT<T> {
  const _ImplT({int a = 0}) : super._();

  const _ImplT.named() : super._();

  const _ImplT.fromJson(Map<String, Object?> json) : super._();
}

class _$GeneratedT {
  const _$GeneratedT.create();
}

enum StatusT {
  ok(200),
  gone.named(410);

  const StatusT(this.code);

  const StatusT.named(this.code);

  final int code;
}

extension type const MetersT(int value) {
  const MetersT.zero() : this(0);
}

final topProvider = ProviderT<int>.value(value: 7);

Object build() => ProviderT.value(value: 8);

void accept(Object o) {}

void wrap({required Object child}) {}
