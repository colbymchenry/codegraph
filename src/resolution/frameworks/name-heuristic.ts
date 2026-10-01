/**
 * The shared pick behind the framework resolvers' name heuristics — "a
 * `…Service` is a class under `/services/`", "a PascalCase name is a model
 * under `/models/`", "`router` is a FastAPI router under `/routers/`".
 *
 * Each resolver used to take the FIRST same-named node of the right kind,
 * preferring a conventional folder, and that heuristic outranks name matching
 * on a tie. So every MyBatis `XExample`'s `new Criteria()` in mall went to the
 * first `Example`'s nested `Criteria`, and axum's examples' `Uri` to a struct a
 * routing test declares inside itself. The pick now considers only what the
 * reference can see, and starts from its own scope.
 */
import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext } from '../types';
import { isLexicallyReachable, isVisibleAcrossFiles } from '../name-matcher';

/** Node kinds a nested type can be declared in. */
const TYPE_OWNER_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'trait', 'protocol', 'record']);

export interface NamePickOptions {
  /**
   * Whether a file in the reference's directory comes before the conventional
   * folders — its package (JVM, Go, C#, Python). Not for Rust, where a sibling
   * file is another module, reached only through a `use`.
   */
  sameDirectory?: boolean;
  /** A language's own scope rule over the candidates (Rust's `use` / module paths). */
  accept?: (n: Node) => boolean;
}

/**
 * The id of the node named `ref.referenceName`, of one of `kinds`, that the
 * reference can see: never a declaration inside some function body, never a
 * type nested in another file's type (a nested type is reached by its bare
 * name only from inside its owner), never one the language keeps out of the
 * reference's file (a `private` member, an unexported Go name, a C# namespace
 * the file does not use, a test suite from production code). Its own file's
 * first, then (by default) its directory's, then a conventional folder's.
 */
export function pickByNameAndKind(
  ref: UnresolvedRef,
  kinds: ReadonlySet<string>,
  inPreferredDir: (filePath: string) => boolean,
  context: ResolutionContext,
  options: NamePickOptions = {},
): string | null {
  const candidates = context.getNodesByName(ref.referenceName).filter((n) =>
    kinds.has(n.kind) &&
    isLexicallyReachable(n, ref, context) &&
    (n.filePath === ref.filePath || (!isNestedType(n, context) && isVisibleAcrossFiles(n, ref, context))) &&
    (!options.accept || options.accept(n)));
  if (candidates.length === 0) return null;

  const sameFile = candidates.find((n) => n.filePath === ref.filePath);
  if (sameFile) return sameFile.id;
  if (options.sameDirectory !== false) {
    const dir = ref.filePath.slice(0, ref.filePath.lastIndexOf('/') + 1);
    const sameDir = candidates.find((n) => n.filePath.startsWith(dir) && !n.filePath.slice(dir.length).includes('/'));
    if (sameDir) return sameDir.id;
  }
  return (candidates.find((n) => inPreferredDir(n.filePath)) ?? candidates[0]!).id;
}

/** Whether a node is declared inside a type of its own file. */
function isNestedType(n: Node, context: ResolutionContext): boolean {
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const owner = n.qualifiedName.slice(0, cut);
  return context.getNodesInFile(n.filePath).some((p) => p.qualifiedName === owner && TYPE_OWNER_KINDS.has(p.kind));
}
