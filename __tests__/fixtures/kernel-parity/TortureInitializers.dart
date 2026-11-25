// Calls, instantiations, reads and function values written in initializers:
// top-level variables and constants, and fields of every member body kind.
import 'package:app/model.dart';

int compute(int n) => n;
void onTap() {}
void register(Object o) {}
Widget build() => Widget(0);

// final / const: the constant owns its initializer.
final repoProvider = Provider((ref) => Repository(ref.watch(dioProvider)));
final counterProvider = StateNotifierProvider<Counter, int>((ref) => Counter(ref.read(apiProvider)));
final blockProvider = Provider((ref) {
  final dio = Dio.create(compute(1));
  void local(int x) {
    register(x);
  }
  local(2);
  return Repository(dio)..init()..start();
});
const shared = Widget.named(3);
const made = const Pair<int, Widget>(1, Widget(2));
final created = new Widget(compute(4));
final chained = Widget.factory().configure().run();
final reads = Config.instance.name;
final label = 'total ${compute(5)} of $shared';
final cb = onTap;
final wired = register(onTap);
final table = [onTap, build];
final byName = {'tap': onTap, 'build': build};
final first = compute(6), second = Widget(7);
final Provider<Widget> typed = Provider((ref) => build());
final asyncProvider = FutureProvider((ref) async => await load(ref));
final viaTypedParam = Provider((Ref ref) => ref.watch(dioProvider).value);

// var / typed / late: the file owns the initializer.
var counter = compute(8);
Widget top = build();
late final lazy = Widget(compute(9));
var list = <Widget>[Widget(10), build()], other = compute(11);
int plain = 0;

class Holder {
  static final instance = Holder._(compute(12));
  static const empty = Holder._(0);
  static var cache = Widget(compute(13));
  static Widget typedStatic = build();
  final made = Widget(14);
  late final lazyField = compute(size);
  var callbacks = [onTap];
  final Widget other = Widget.named(15), more = build();
  final int size;
  Holder._(this.size);

  int run() {
    var total = 0;
    for (var i = 0, j = compute(16); i < j; i++) {
      total += i;
    }
    final local = Widget(17), again = compute(18);
    return total;
  }
}

mixin Tracking {
  static var tracker = Tracker.start();
  final events = <Event>[Event('init')];
}

extension Formatting on String {
  static final formatter = Formatter(compute(19));
  static var counter = compute(20);
}

enum Mode {
  fast,
  slow;

  static final byName = {for (final m in Mode.values) m.name: m};
  static const fallback = Mode.fast;
  final weight = 1;
}

extension type Meters(int value) {
  static var unit = Unit.create('m');
}

// Positions after multi-byte text are UTF-16 columns on both arms.
final emoji = 'é😀'; final afterEmoji = compute(21); var alsoAfter = Widget(22);
