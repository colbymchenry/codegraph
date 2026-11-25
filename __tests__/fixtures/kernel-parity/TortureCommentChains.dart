// Comments inside member chains. tree-sitter-dart keeps a comment as a named
// sibling between a chain's parts; every sibling step skips it, so each line
// emits what it would without the comment.
import 'package:flutter_test/flutter_test.dart';

class ConfigT {
  static final ConfigT instance = ConfigT();
  static ConfigT load() => ConfigT();
  int setting = 0;
}

class FactoryT {
  static FactoryT create() => FactoryT();
  void run() {}
}

class Box {
  int get area => 1;
  int grow(int by) => by;
}

// An initializer, walked for its constant.
final initialized = ConfigT //
    .instance;

class Chains extends Box {
  void calls(WidgetTester tester, Box box, List<int> xs) {
    // dart format's line-break idiom, a whole-line comment, dartdoc, a run of
    // block comments.
    tester //
        .state(find.byType(Box));
    tester
        // a whole-line comment
        .pump();
    tester /// doc
        .a();
    tester /** doc */ .b();
    tester /* c */ /* d */ .c();
    // A comment between the member and its arguments.
    tester.d // c
        ();
    box.grow /* by */ (3);
    // Chains: re-encoded off a capitalized call, bare off a lowercase one.
    FactoryT.create() //
        .run();
    FactoryT //
        .create() //
        .run();
    xs //
        .map((e) => e) //
        .toList();
    // `this` / `super` keep the bare name.
    this //
        .grow(1);
    super //
        .grow(2);
  }

  int reads(Box box, WidgetTester tester) {
    final v = box //
        .area;
    final w = box.area /* c */ .isEven;
    final s = ConfigT //
        .instance;
    ConfigT // static call: a call and a static reference
        .load();
    final t = ConfigT /* setting */ .instance.setting;
    // A generic call the grammar reads as two comparisons.
    final st = tester //
        .state<ProviderScopeState>(find.byType(Box));
    // A comment against the `<`: not laid out as a call, so a read and two
    // comparisons, as written.
    final cr = tester.read /* c */<Box>(box);
    final dr = tester.read /** doc */<Box>(box);
    return v + w.hashCode + s.setting + t + st.hashCode;
  }
}
