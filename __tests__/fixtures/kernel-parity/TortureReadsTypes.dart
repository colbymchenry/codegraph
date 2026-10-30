// Getter reads (#2338) and type positions outside signatures (#2327).
import 'package:app/model.dart' as m;
import 'package:app/model.dart';

// The type an extension is `on`: plain, generic, prefixed, nullable.
extension ReportX on Report {
  bool get high => score > 5;
}

extension ListX<T extends Report> on List<T> {
  int get total => length;
}

extension PrefixedX on m.Report? {
  bool get present => this != null;
}

extension on Map<String, Report> {
  int get size2 => length;
}

mixin Scored on Report {
  int bump() => score + 1;
}

// Field declarations: instance, nullable, generic, static, late, prefixed,
// function-typed, record-typed, untyped with a generic initializer.
class Holder {
  final Report report;
  Report? maybe;
  final List<Report> all = [];
  static final Report fallback = Report(0);
  static const List<Report> none = <Report>[];
  late final m.Report prefixed;
  final void Function(Report r)? onTap = null;
  (Report, int)? pair;
  var untyped = Family<Report?, String>();
  final Map<String, List<Report>> byKey = {};
  int count = 0, other = 1;

  Holder(this.report);

  Report get first => all.first;

  int read(Holder h, Report r) {
    final local = Holder(r);
    return h.report.score + local.all.length + r.score + h.maybe!.score;
  }
}

enum Grade {
  a(null),
  b(null);

  const Grade(this.best);
  final Report? best;
  static const Grade top = Grade.a;
  String get label => name;
}

// Top-level variables: typed, generic, function-typed, record-typed,
// untyped with generic initializers, constants.
Report? current;
List<Report> history = [];
void Function(Report)? listener;
(Report, String) tagged = (Report(1), 'x');
var plain = <Report>[];
var counts = Map<String, Report>();
final reportProvider = Family<Report?, String>();
const empty = <Report>[];
final handler = (Report r) => r.score;

class Family<T, A> {
  const Family();
}

class Config {
  static Config get instance => Config();
  String get name => 'cfg';
  void load() {}
}

int reads(Holder h, Grade g, Report? r) {
  // Plain and conditional reads, a static getter, an enum value.
  final a = h.first;
  final b = r?.score;
  final c = Config.instance;
  final d = Grade.top;
  final e = g.label;
  // Calls are not reads; the head of a chain is.
  h.read(h, h.report);
  Config.instance.load();
  final f = h.report.score;
  // Cascades, assignments and compound assignments are not reads.
  h..maybe;
  h.maybe = null;
  h.count += 1;
  // Reads inside interpolation, arguments, closures and nested functions.
  print('${h.count} ${g.label}');
  final cb = (Holder x) => x.first;
  int nested(Holder y) {
    final List<Report> rs = y.all;
    return y.count + rs.length;
  }
  return nested(h) + cb(h).score + (a.score) + (b ?? 0) + c.name.length + d.index + e.length + f;
}

Object types(Object o) {
  // Local types, generic arguments, casts, type tests, catch types,
  // collection literals; constructor calls stay calls.
  final Report local = o as Report;
  List<Report> xs = <Report>[local];
  final Map<String, Report> byName = {'a': local};
  final ys = <Report>{};
  if (o is Report) {}
  if (o is! Holder) {}
  final f = Future<Report?>.value(null);
  final g = Family<Report, m.Report>();
  final made = Report(1);
  final built = const Report(2);
  final old = new Holder(local);
  final generic = Family<Report, int>();
  // Positions after multi-byte text are UTF-16 columns on both arms.
  final label = 'é😀'; final Report? again = local; final n = again?.score;
  try {
    throw StateError('x');
  } on StateError catch (_) {
  } on FormatException {
  }
  return [xs, byName, ys, f, g, made, built, old, generic, label, n];
}
