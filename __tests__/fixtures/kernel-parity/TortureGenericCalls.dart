// Generic calls tree-sitter-dart parses as two comparisons — `ref.read<Repo>(p)`
// comes out as `(ref.read < Repo) > (p)` — recovered as calls, and the
// comparisons that look like them.
import 'package:app/app.dart' as p;

// Initializers: a constant's, a top-level variable's, a field's.
final counterProvider = Provider<int>((ref) => ref.watch<int>(seedProvider));
final repoProvider = Provider<Repo>((ref) {
  final dio = ref.read<Dio>(dioProvider);
  return Repo(dio);
});
var cache = Cache<String>(capacity: 10);
final routes = [MaterialPageRoute<void>(builder: (_) => const Home())];

int g(Ref ref) => ref.read<int>(1);

class Screen {
  final notifier = ValueNotifier<int>(0);
  static final route = MaterialPageRoute<void>(builder: (_) => const Screen());
  static var shared = Notifier<Repo>(repoProvider);

  const Screen();

  Future<void> load(Ref ref, BuildContext context) async {
    ref.read<Repo>(repoProvider);
    final user = await ref.read<UserRepository>(userRepoProvider).fetch<User>(id);
    final map = ref.read<Map<String, Repo>>(mapProvider);
    final prefixed = ref.read<p.Repo>(repoProvider);
    final generic = ref.read<p.Box<Repo>>(boxProvider);
    BlocProvider.of<CounterCubit>(context).increment();
    final state = BlocProvider.of<CounterCubit>(context).state;
    final neg = -ref.read<int>(countProvider);
    final not = !ref.read<bool>(flagProvider);
    final nested = Wrapper<A>(Inner<B>(seed));
    final bare = build<Repo>(seed);
    final dyn = await box.openBox<dynamic>('box');
    final chained = Factory.create<Repo>(seed).build();
    final lower = repo.items.where<Item>(isDone).toList();
    final self = this.read<Repo>(repoProvider);
    final cascade = Builder<Repo>(seed)..name = 'x';
    final templ = '${ref.read<Repo>(repoProvider)}';
    final sum = ref.watch<int>(countProvider) + 1;
    return show<void>(context: context, builder: (_) => const Screen());
  }

  void outer(Ref ref) {
    int inner() => ref.watch<int>(innerProvider);
    final cb = () => navigator.push<void>(any());
    inner();
  }

  bool compare(int a, int b, int c, int d) {
    // Comparisons, not calls.
    final spaced = a < B > (c);
    final lower = a<b>(c);
    final left = a <B>(c);
    final right = a<B> (c);
    final expr = a < b + 1 > (c);
    final record = a<(B, C)>(d);
    return a < b && c > d;
  }
}
