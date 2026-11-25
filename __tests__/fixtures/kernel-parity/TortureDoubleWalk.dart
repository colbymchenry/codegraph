final topFinal = seedValue();
const topConst = 42;
var topVar = 7;
int topTyped = 8;
final multiA = 1, multiB = 2;

int seedValue() => 9;

void hostFn() {
  void localFn(int n) {
    inner(n);
  }
  localFn(3);
  int localWithNew() {
    final w = new Holder(1);
    return w.n;
  }
  localWithNew();
}

class Holder {
  final int n;
  final untypedInit = 5;
  static var mutable = 3;
  Holder(this.n);
  Holder.other() : n = compute();
  void useNew() {
    final h = new Holder(2);
    void methodLocal() {
      h.touch();
    }
    methodLocal();
  }
  int get computed => helperCall();
}

void takeConst() {
  pad(const EdgeInsets.all(8.0));
  make(const Holder(3));
}

Future<int> asyncFn() async => 1;
Stream<int> genFn() async* {
  yield 1;
}
Iterable<int> syncGen() sync* {
  yield 2;
}

/// Doc for annotated.
@deprecated
void annotated() {}

@Deprecated('use other')
class OldClass {}

@pragma('vm:entry-point')
void pragged() {}

class Cfg {
  static const retries = 3;
}

void reader() {
  use(Cfg.retries);
  final msg = 'retry $topConst times ${topFinal}';
  print(msg);
}

void shadower() {
  final topConst = 1;
  use(topConst);
}

void refTaker() {
  register(seedValue);
  obj.cb = seedValue;
  final table = [seedValue, hostFn];
  final map = {'k': seedValue, 'j': notDefinedHere};
  reg2(cb: seedValue);
  final alias = seedValue;
}
