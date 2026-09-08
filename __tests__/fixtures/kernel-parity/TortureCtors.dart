/** Block dartdoc for blockDoc. */
void blockDoc() {}

/// Line doc kept.
// Plain comment also kept?
void mixedDoc() {}

// Only plain.
void plainDoc() {}

extension type Meters(double value) {
  double get km => value / 1000;
  void report() {
    print(km);
  }
}

class Action {
  @override
  (int, String) reduce() => (1, 'a');
  void caller() {
    this.own();
    super.parent();
    generic<int>(5);
    final t = reduce();
  }
}

enum Flag { on, off }

void flagUse(Flag f) {
  final v = Flag.on;
  switch (f) {
    case Flag.off:
      use(v);
    default:
      break;
  }
}
