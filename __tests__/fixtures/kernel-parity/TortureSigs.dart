library my.lib;

part of 'other.dart';

void params({int? a, required Widget child, String note = 'x'}) {}
void optional([int b = 0, Widget? w]) {}
void fnTypedParam(void cb(int x), int Function(String) modern) {}
num numRet(num n) => n;
dynamic dynRet(dynamic d) => d;
Object objRet(Object o) => o;
double dblRet(double d) => d;

external void externalFn();

class Redir {
  Redir();
  Redir.a() : this();
  const factory Redir.b() = RedirImpl;
}

void lambdas(List<int> xs) {
  xs.forEach((e) => use(e));
  final f = (int a) {
    helper(a);
  };
  f(1);
  xs.map((e) => e * 2).toList();
}

void bodyTypes(Object x) {
  if (x is Widget) {
    use(x);
  }
  final y = x as Widget;
  final list = <Widget>[];
  final map = <String, Widget>{};
  throw StateError('bad');
}

@override
@protected
void doubleAnno() {}
