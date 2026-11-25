import 'package:foo/util.dart' as util;

const SHARED_MAX = 10;
const kLimit = 20;
final DERIVED = SHARED_MAX + 1;
const low = 30;

class Table {
  static const COL_LIMIT = 5;
  static const plain = 6;
  void reads() {
    use(SHARED_MAX);
    use(Table.COL_LIMIT);
    log('cap $kLimit and ${SHARED_MAX}');
  }
  void shadowed() {
    final SHARED_MAX = 1;
    use(SHARED_MAX);
  }
}

void freeReader() {
  use(kLimit);
}

void uninitShadow() {
  int DERIVED;
  DERIVED = 2;
  use(DERIVED);
}

void assignOnly() {
  low = 5;
}

void prefixedCalls() {
  util.helper(1);
  util.Config.load();
  Widget.named(2);
}

/// Doc on classy.
class Classy {}

/// Doc on num const?
const DOCED = 1;

/// Doc on enum.
enum E2 { a }

/// Doc broken.
@override
void afterAnno() {}

/// Kept doc.
void unicodeNext() {}

// π and émoji 🎯 in a comment
void afterUnicode(String s) {
  emit('café ☕ done');
}
