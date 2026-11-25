// Typedefs reference the types they alias (#2327): every new-style and legacy
// shape, type parameters (the typedef's own and a generic function type's),
// import prefixes, annotations, comments and wrapped declarations.
import 'package:meta/meta.dart';
import 'model.dart' as m;
import 'model.dart' as M;

class Report {
  final int score;
  const Report(this.score);
}

class T {}

void tag(Object o) {}

// New style.
typedef ReportCallback = void Function(Report r);
typedef ReportMaker = Report Function();
typedef Reports = List<Report>;
typedef ReportsByName = Map<String, Report>;
typedef Results = Future<List<Report>?> Function(int page);
typedef Opt = Report?;
typedef MaybeMaker = Report Function()?;
typedef Pair = (Report, int);
typedef NamedPair = ({Report first, m.Report second});
typedef Named = void Function({required Report report, int? n});
typedef Positional = void Function([Report? report]);
typedef Unnamed = void Function(Report, m.Report);
typedef Nested = void Function(void Function(Report) inner);
typedef Maker = void Function(Report Function() make);
typedef Dynamic = dynamic Function(Object? o);
typedef Void = void;
typedef Fn = Function;
typedef Prefixed = m.Report;
typedef UpperPrefixed = M.Report;
typedef PrefixedGeneric = m.Box<m.Report>;

// Type parameters: the typedef's own, a bound, a generic function type's.
typedef Mapper<T> = T Function(Report r);
typedef Bounded<X extends Report> = List<X>;
typedef SelfBounded<C extends Comparable<C>> = int Function(C a, C b);
typedef Picker = T Function<T>(T a, Report r);
typedef Outer<S> = S Function<U>(U u, S s, T t);
typedef Shadow<T> = m.T Function(T t);
typedef TwoParams<K, V extends Report> = Map<K, List<V>>;

// Legacy.
typedef void LegacyCallback(Report r);
typedef Report LegacyMaker(int n);
typedef List<Report> LegacyLoader([Report? seed]);
typedef m.Report PrefixedLegacy(m.Report r);
typedef Report? LegacyOptional({Report? fallback});
typedef void Function(Report) LegacyFnReturn(int n);
typedef T LegacyPicker<T>(T a, Report r);
typedef void LegacyFnParam(Report make(int n));
typedef void LegacyGenericFnParam(S make<S>(S s, Report r));
typedef void LegacyCovariant(covariant Report r, final Report s);

// Annotated, documented, commented, wrapped.
/// Documented.
@Deprecated('Use ReportCallback')
typedef OldCallback = void Function(Report r);
@visibleForTesting
@Tag(tag)
typedef Tagged = Report Function(/* the report */ Report r);
typedef Commented = // why
    Report Function(Report r);
typedef Wrapped =
    Map<String, Report> Function(
      Report first,
      Report second,
    );

class Tag {
  const Tag(this.f);
  final Object f;
}
