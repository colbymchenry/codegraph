/**
 * Directory Management
 *
 * Manages the .codegraph/ directory structure for CodeGraph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The default per-project data directory name. */
const DEFAULT_CODEGRAPH_DIR = '.codegraph';

let warnedBadDirName = false;

/**
 * Resolve the per-project data directory name, honoring the `CODEGRAPH_DIR`
 * environment override (default `.codegraph`). The override is a single path
 * segment that lives in the project root.
 *
 * Why this exists: two environments that share one working tree must NOT share
 * one `.codegraph/` — most concretely Windows-native and WSL (issue #636). The
 * daemon lockfile (`.codegraph/daemon.pid`) records a platform-specific pid and
 * socket path (a Windows named pipe vs a WSL Unix socket), and SQLite file
 * locking across the WSL2 ↔ Windows filesystem boundary is unreliable, so two
 * daemons sharing one index risks corruption. Setting `CODEGRAPH_DIR=.codegraph-win`
 * on one side gives each environment its own index in the same tree.
 *
 * Read live (not captured at load) so it is both process-accurate and testable.
 * An override that isn't a plain directory name — empty, containing a path
 * separator, `.`, `..`/traversal, or absolute — is ignored (we keep the
 * default) rather than risk writing the index outside the project or into the
 * project root itself; we warn once to stderr so the misconfiguration is seen.
 */
export function codeGraphDirName(): string {
  const raw = process.env.CODEGRAPH_DIR?.trim();
  if (!raw) return DEFAULT_CODEGRAPH_DIR;
  const invalid =
    raw === '.' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    path.isAbsolute(raw);
  if (invalid) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // stderr only — stdout is the MCP protocol channel.
      console.warn(
        `[codegraph] Ignoring invalid CODEGRAPH_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_CODEGRAPH_DIR}".`
      );
    }
    return DEFAULT_CODEGRAPH_DIR;
  }
  return raw;
}

/**
 * CodeGraph directory name — a load-time snapshot of {@link codeGraphDirName}.
 * A running process's environment is fixed, so this equals the live value;
 * it's kept as a stable string export for backward compatibility. Internal code
 * resolves the name through {@link codeGraphDirName} / {@link getCodeGraphDir}
 * so the `CODEGRAPH_DIR` override always applies.
 */
export const CODEGRAPH_DIR = codeGraphDirName();

/**
 * Is `name` (a single path segment) a CodeGraph data directory? Matches the
 * default `.codegraph`, the active `CODEGRAPH_DIR` override, and any
 * `.codegraph-*` sibling. File-watching and the indexer skip ALL of these, so
 * when two environments share one working tree (Windows + WSL, issue #636)
 * neither indexes or watches the other's index directory.
 */
export function isCodeGraphDataDir(name: string): boolean {
  return (
    name === DEFAULT_CODEGRAPH_DIR ||
    name === codeGraphDirName() ||
    name.startsWith(DEFAULT_CODEGRAPH_DIR + '-')
  );
}

/**
 * Get the .codegraph directory path for a project
 */
export function getCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, codeGraphDirName());
}

/**
 * Check if a project has been initialized with CodeGraph
 * Requires both .codegraph/ directory AND codegraph.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const codegraphDir = getCodeGraphDir(projectRoot);
  if (!fs.existsSync(codegraphDir) || !fs.statSync(codegraphDir).isDirectory()) {
    return false;
  }
  // Must have codegraph.db, not just .codegraph folder
  const dbPath = path.join(codegraphDir, 'codegraph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .codegraph/
 *
 * Walks up from the given path to find a CodeGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .codegraph/, or null if not found
 */
/**
 * Reason a directory is unsafe to use as an index ROOT, or null when it's fine.
 *
 * Indexing your home directory or a filesystem root drags in caches, `Library`,
 * every other project, etc. — a multi-GB index, constant file-watcher churn, and
 * (pre-1.0 on macOS) a file-descriptor blowup that exhausted `kern.maxfiles` and
 * took unrelated apps / the whole machine down (#845). The classic trigger:
 * running the installer or `codegraph init` from `$HOME`, which auto-indexes the
 * current directory. These are never intended project roots, so the installer
 * and `init`/`index` refuse them (overridable with `--force`).
 *
 * Pure-ish (reads only `os.homedir()` + realpath) so it's easy to unit-test.
 * The returned string is a human phrase that slots into "… looks like {reason}".
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // Filesystem root: `/` on POSIX, a drive root like `C:\` on Windows.
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // Case-insensitive on macOS/Windows (case-preserving but case-insensitive FS).
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // An ancestor of home (e.g. `/Users`, `/home`) — even broader than home.
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

export function findNearestCodeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/** Heavy/irrelevant directory names the sub-project scan never descends into. */
const SUBPROJECT_SCAN_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.turbo', '.idea', '.vscode', 'tmp', 'temp',
]);

/** Manifests that mark a directory as a project/workspace root. The down-scan
 *  is gated on one of these so a non-project cwd (e.g. `$HOME`) is a cheap
 *  no-op instead of a deep filesystem crawl. */
const WORKSPACE_ROOT_MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
  'go.work', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'pyproject.toml', 'composer.json', 'Gemfile', 'rush.json',
  'WORKSPACE', 'WORKSPACE.bazel',
];

function looksLikeProjectRoot(dir: string): boolean {
  return WORKSPACE_ROOT_MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Indexed sub-project roots beneath `root` (bounded breadth-first scan). For
 * the monorepo case behind #964: the index lives in a CHILD
 * (`packages/x/.codegraph/`), not at the workspace root the agent's cwd points
 * at. Descent stops at the first indexed directory on a branch (a project's
 * own sub-dirs aren't separate projects) and is bounded by depth + count so it
 * never turns into a full-tree crawl on a large repo.
 */
export function findIndexedSubprojectRoots(
  root: string,
  opts: { maxDepth?: number; max?: number } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 4;
  const max = opts.max ?? 64;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SUBPROJECT_SCAN_SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (isInitialized(child)) { out.push(child); continue; } // don't descend into an indexed project
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/**
 * Unicode-aware word-boundary emulation for the keyword lists below. JS's `\b`
 * is ASCII-only — it fires only at `[A-Za-z0-9_]` edges — so it can never bound
 * a keyword whose first or last character is accented or non-Latin: `/\boù\b/`
 * NEVER matches "où est …" (ù isn't an ASCII word char, so no boundary exists
 * next to it). That is the #994 CJK mechanism resurfaced for Latin scripts and
 * Cyrillic (#1126). A lookaround — "not flanked by a letter, digit, or
 * underscore" — is the script-independent equivalent.
 */
const NOT_WORD_BEFORE = /(?<![\p{L}\p{N}_])/u.source;
const NOT_WORD_AFTER = /(?![\p{L}\p{N}_])/u.source;

/**
 * Structural keywords matched as EXACT words (boundary on both sides): short
 * or ambiguous tokens where prefix matching would false-positive ("flow" in
 * "flower", "path" in "pathological"). Grouped by language; a term appears once
 * even when several languages share it ("como" is Portuguese for how AND
 * unaccented-typed Spanish "cómo").
 */
const STRUCTURAL_WORDS = [
  // English — the pre-#1126 list minus what moved to STRUCTURAL_STEMS: the
  // bare-stem entries never matched their own derived forms (`\barchitect\b`
  // can't match "architecture"), and "what calls" is subsumed by the "call" stem.
  'how', 'where', 'tracing', 'flows?', 'paths?', 'reach(?:es|ed)?', 'wired?', 'breaks?', 'why does',
  // French (où=where, flux=flow, chemin=path, casse=breaks)
  'comment', 'où', 'flux', 'chemins?', 'casse',
  // Spanish (cómo/como=how, dónde/donde=where, flujo=flow, ruta/camino=path,
  // rompe=breaks, llaman / quién llama = call(s) — bare "llama" is excluded:
  // it's also the animal/model name in English prompts)
  'cómo', 'dónde', 'donde', 'flujos?', 'rutas?', 'caminos?', 'rompe', 'llaman', 'quién llama', 'quien llama',
  // Portuguese (como=how — also covers unaccented Spanish; onde=where,
  // fluxo=flow, caminho=path)
  'como', 'onde', 'fluxos?', 'caminhos?',
  // German (wie=how, wo/woher/wohin=where, Pfad=path, Fluss/Ablauf=flow,
  // bricht/kaputt=breaks, ruft=calls, hängt=depends — "hängt … von X ab"
  // splits the separable verb "abhängen", so the "abhäng" stem can't catch it)
  'wie', 'wo', 'woher', 'wohin', 'pfade?', 'fluss', 'ablauf', 'bricht', 'kaputt', 'ruft', 'hängt',
  // Italian (dove=where, flusso=flow, percorso/i=path)
  'dove', 'flusso', 'percors[oi]',
  // Russian (как=how, где=where, путь/пути=path, работает=works)
  'как', 'где', 'путь', 'пути', 'работает',
  // Ukrainian (як=how, де=where, потік=flow — обліque cases reuse the RU
  // "поток" stem; працює=works)
  'як', 'де', 'потік', 'працює',
  // Dutch (hoe=how, waar=where, roept=calls, werkt=works, aangeroepen=called —
  // the ge- participle escapes the "aanroep" stem)
  'hoe', 'waar', 'roept', 'werkt', 'aangeroepen',
  // Polish + Czech (jak=how — shared; gdzie/kde=where, cesta=path)
  'jak', 'gdzie', 'kde', 'cesta',
  // Romanian (cum=how, unde=where; flux is shared with French)
  'cum', 'unde',
  // Hungarian (hogyan=how, hol=where)
  'hogyan', 'hol',
  // Turkish (nasıl=how, mimari=architecture, takip=trace/follow)
  'nasıl', 'mimari', 'takip',
  // Indonesian/Malay (bagaimana=how, di mana/dimana=where, alur=flow, jalur=path)
  'bagaimana', 'di mana', 'dimana', 'alur', 'jalur',
  // Vietnamese — spaced Latin with heavy diacritics, the exact class ASCII `\b`
  // breaks (làm sao/thế nào=how, ở đâu=where, gọi=call, phụ thuộc=depend,
  // ảnh hưởng=affect, kiến trúc=architecture, cấu trúc=structure, luồng=flow,
  // đường dẫn=path, hoạt động=works, giải thích=explain, theo dõi=trace)
  'làm sao', 'thế nào', 'ở đâu', 'gọi', 'phụ thuộc', 'ảnh hưởng', 'kiến trúc',
  'cấu trúc', 'luồng', 'đường dẫn', 'hoạt động', 'giải thích', 'theo dõi',
  // Swedish / Danish / Norwegian (hur/hvordan=how, hvor=where, beror=depends,
  // flöde=flow)
  'hur', 'hvordan', 'hvor', 'beror', 'flöde',
  // Finnish (miten=how, missä=where, toimii=works)
  'miten', 'missä', 'toimii',
  // Greek (πώς=how, πού=where — accented forms only: unaccented πως/που are
  // ubiquitous conjunctions; καλεί=calls, δομή=structure, ροή=flow)
  'πώς', 'πού', 'καλεί', 'δομή', 'ροή',
  // Hindi (कैसे=how, कहाँ/कहां=where, कॉल=call, निर्भर=depends,
  // संरचना=structure, प्रवाह=flow)
  'कैसे', 'कहाँ', 'कहां', 'कॉल', 'निर्भर', 'संरचना', 'प्रवाह',
];

/**
 * Structural keyword STEMS matched as word PREFIXES (boundary on the left
 * only), so derived forms match without enumerating each: "architect" fires on
 * architecture/architectural, "depend" on depends/dependency/dependencies,
 * "вызыва" on вызывает/вызывается. Mid-word occurrences stay excluded —
 * "restructure"/"independent" don't fire — so precision stays close to the
 * exact-word class. Add a stem only when every plausible completion is still a
 * structural word; a stem with ordinary-English completions must instead
 * enumerate its structural suffixes and re-assert the right boundary (see the
 * four bounded English entries below, #1138).
 */
const STRUCTURAL_STEMS = [
  // English + the Latin-script languages that share the spelling (French
  // architecture/structure/trace/impact, Spanish depende/implementa/impacto, …).
  // call/trace/affect/connect are NOT safe as open prefixes — callus,
  // calligraphy, Connecticut, connective, affectionate, Tracey are ordinary
  // words that would false-fire the full-explore tier (#1138) — so they carry
  // an enumerated suffix set + right boundary. "tracing" lives in
  // STRUCTURAL_WORDS (the e is dropped, so no trace-prefix form matches it).
  'architect', 'structur', 'depend', 'implement', 'impact', 'explain',
  `call(?:s|ing|ed|ers?|backs?|able|sites?)?${NOT_WORD_AFTER}`,
  `trace(?:s|d|rs?)?${NOT_WORD_AFTER}`,
  `affect(?:s|ed|ing)?${NOT_WORD_AFTER}`,
  `connect(?:s|ed|ing|ions?|ors?|ivity)?${NOT_WORD_AFTER}`,
  // French (appel(le)=call, dépend=depends, implément(e)=implement,
  // connex(ion)=connection, expliqu(e)=explain, fonctionn(e/ement)=works)
  'appel', 'dépend', 'implément', 'connex', 'expliqu', 'fonctionn',
  // Spanish (llamad(a)=call, afect(a)=affect, conect(a)/conexi(ón)=connect,
  // arquitec(tura)=architecture, estructur(a)=structure, funcion(a)=works,
  // traza(r)=trace, explica=explain)
  'llamad', 'afect', 'conect', 'conexi', 'arquitec', 'estructur', 'funcion', 'traza', 'explica',
  // Portuguese (chama(da)=call, afeta=affect, arquitet(ura)=architecture,
  // estrutur(a)=structure, quebra(do)=breaks)
  'chama', 'afeta', 'arquitet', 'estrutur', 'quebra',
  // German (abhäng(t)=depend, Auswirkung=impact, beeinfluss(t)=affect,
  // verbind(et)=connect, Architektur, Struktur, funktionier(t)=works,
  // Aufruf/aufgerufen=call, erklär(t)=explain, verfolg(en)=trace)
  'abhäng', 'auswirkung', 'beeinfluss', 'verbind', 'architekt', 'struktur', 'funktionier', 'aufruf', 'aufgerufen', 'erklär', 'verfolg',
  // Italian (chiam(a/ata)=call, dipend(e/enza)=depend, impatt(o)=impact,
  // connett(e)/conness(ione)=connect, architett(ura), struttur(a),
  // funzion(a/amento)=works, tracci(a)=trace, spiega(mi)=explain)
  'chiam', 'dipend', 'impatt', 'connett', 'conness', 'architett', 'struttur', 'funzion', 'tracci', 'spiega',
  // Russian (вызыва(ет)=calls, завис(ит)=depends, влия(ет)=affects,
  // реализ(ация)=implementation, структур(а), архитектур(а),
  // трассир(овка)=trace, лома(ет)=breaks, объясн(и)=explain, поток=flow)
  'вызыва', 'завис', 'влия', 'реализ', 'структур', 'архитектур', 'трассир', 'лома', 'объясн', 'поток',
  // Ukrainian — і/и spellings diverge from Russian (виклика(є)=calls,
  // залеж(ить)=depends, вплива(є)=affects, архітектур(а), реаліз(ація),
  // поясн(и)=explain, шлях(у)=path; структур(а) is shared with Russian)
  'виклика', 'залеж', 'вплива', 'архітектур', 'реаліз', 'поясн', 'шлях',
  // Dutch (aanroep(en)=call, afhankelijk(heid)=depends, beïnvloed(t)=affects,
  // structuur — "structur" can't reach the uu; uitleg(gen)=explain)
  'aanroep', 'afhankelijk', 'beïnvloed', 'structuur', 'uitleg',
  // Polish (wywoł(uje)=calls, zależ(y)=depends, wpływ(a)=affects/impact,
  // przepływ=flow, ścieżk(a)=path, działa(nie)=works, wyjaśni(j)=explain,
  // śledz(enie)=trace; architektura/struktura fire via the German stems)
  'wywoł', 'zależ', 'wpływ', 'przepływ', 'ścieżk', 'działa', 'wyjaśni', 'śledz',
  // Czech (volá(ní)=calls, závis(í)=depends, ovlivň(uje)=affects,
  // funguj(e)=works, vysvětl(i)=explain)
  'volá', 'závis', 'ovlivň', 'funguj', 'vysvětl',
  // Romanian (apel(ează)=calls, depind(e)=depends — i not e, so "depend" misses
  // it; arhitectur(a) — no c; funcțion(ează)=works, explică=explain)
  'apel', 'depind', 'arhitectur', 'funcțion', 'explică',
  // Hungarian (hív(ja)=calls, függ(őség)=depends, működ(ik)=works,
  // struktúr(a) — ú escapes "struktur"; magyaráz(d)=explain;
  // architektúra fires via the German stem)
  'hív', 'függ', 'működ', 'struktúr', 'magyaráz',
  // Turkish — agglutinative, so stems beat exact words (nere(de/ye/den)=where,
  // çağır/çağrı=call, bağıml(ı)=depends, bağlant(ı)=connection, akış(ı)=flow,
  // etkile(r)/etkisi=affects/impact)
  'nere', 'çağır', 'çağrı', 'bağıml', 'bağlant', 'akış', 'etkile', 'etkisi',
  // Indonesian/Malay — me-/di-/ber- prefixes block a bare stem, so affixed
  // forms are listed too (panggil(an)/memanggil/dipanggil=call,
  // bergantung/tergantung=depends, pengaruh/mempengaruhi/memengaruhi=affect,
  // arsitektur=architecture, fungsi/berfungsi=works,
  // jelaskan/menjelaskan=explain)
  'panggil', 'memanggil', 'dipanggil', 'bergantung', 'tergantung', 'pengaruh',
  'mempengaruhi', 'memengaruhi', 'arsitektur', 'fungsi', 'berfungsi', 'jelaskan', 'menjelaskan',
  // Swedish / Danish / Norwegian (anrop(ar)=calls, påverk(ar)/påvirk(er)=affects,
  // afhæng(er)/avheng(er)=depends, förklar(a)/forklar=explain,
  // arkitektur — k not ch; funger(ar/er)=works)
  'anrop', 'påverk', 'påvirk', 'afhæng', 'avheng', 'förklar', 'forklar', 'arkitektur', 'funger',
  // Finnish (kutsu(u)=calls, riippu(u)=depends, arkkitehtuur(i),
  // rakente(en)=structure, selit(ä)=explain)
  'kutsu', 'riippu', 'arkkitehtuur', 'rakente', 'selit',
  // Greek — accented and unaccented stem spellings both occur
  // (εξαρτ(άται)=depends, επηρε(άζει)=affects, αρχιτεκτονικ(ή),
  // διαδρομ(ή)=path, εξηγ/εξήγ(ησε)=explain)
  'εξαρτ', 'επηρε', 'αρχιτεκτονικ', 'διαδρομ', 'εξηγ', 'εξήγ',
  // Hindi (समझा(ओ/इए)=explain, आर्किटेक्चर=architecture)
  'समझा', 'आर्किटेक्चर',
];

const STRUCTURAL_WORDS_RE = new RegExp(`${NOT_WORD_BEFORE}(?:${STRUCTURAL_WORDS.join('|')})${NOT_WORD_AFTER}`, 'iu');
const STRUCTURAL_STEMS_RE = new RegExp(`${NOT_WORD_BEFORE}(?:${STRUCTURAL_STEMS.join('|')})`, 'iu');

/**
 * Structural keywords matched as bare SUBSTRINGS, for languages where a
 * boundary can't be relied on: scripts with no word separators (Chinese —
 * simplified AND traditional; the original #994 set was simplified-only —
 * Japanese, Thai), Korean (spaced, but particles attach directly to the noun:
 * 구조가/구조를), and Arabic / Farsi / Hebrew (spaced, but proclitics attach to
 * the word: وكيف "and-how", והמבנה "and-the-structure"). JS's `\b` can never
 * fire between Han characters, which was issue #994: the English-only gate
 * silently no-op'd every Chinese prompt, so non-English users got no front-load
 * nudge and no error to explain why. The sets mirror the English intent
 * (如何/怎么/怎麼/どうやって/どのように/어떻게/كيف/چگونه/چطور/איך/อย่างไร/ยังไง=how,
 * 在哪/哪里/哪裡/어디/أين/كجا/איפה/ที่ไหน=where, 流程/流向/流れ/흐름/تدفق/זרימה=flow,
 * 路径/路徑/経路/경로/مسار/مسیر/נתיב/เส้นทาง=path,
 * 调用/調用/呼び出/호출/يستدعي/استدعاء/فراخوان/קורא/เรียกใช้=call,
 * 依赖/依賴/依存/의존/يعتمد/تعتمد/وابسته/תלוי/ขึ้นอยู่กับ=depend,
 * 影响/影響/영향/يؤثر/تأثير/تأثیر/משפיע/ผลกระทบ=impact/affect,
 * 实现/實現/実装/구현=implement,
 * 架构/架構/アーキテクチャ/아키텍처/معماري/معماری/ארכיטקטור/สถาปัตยกรรม=architecture,
 * 结构/結構/構造/구조/بنية/هيكل/ساختار/מבנה/โครงสร้าง=structure,
 * 追踪/跟踪/追蹤/追跡/トレース/추적/تتبع/ติดตาม=trace,
 * يعمل/تعمل/ทำงาน=works) plus structural-overview words with no single clean
 * English equivalent (介绍/介紹/解析/分析/原理/机制/機制/仕組み/説明/설명/動作/동작/작동/
 * اشرح/شرح/توضیح/הסבר/อธิบาย=explain).
 *
 * KNOWN, ACCEPTED false-positive class (#1140): substring matching cannot see
 * homograph compounds — Korean 구조 (structure) also fires inside 구조대
 * (rescue squad). Verified unfixable at this layer: ICU word segmentation
 * (Intl.Segmenter) returns 구조대 and the particle form 구조가 (which the gate
 * MUST keep matching) as equally opaque single segments, and a 구조대 denylist
 * would break 구조대로 ("according to the structure" — 구조 + the 대로
 * particle), a legitimate structural prompt. The miss rate this design avoids
 * (silently no-op'ing every prompt in these languages, #994) outweighs the
 * occasional off-domain fire.
 */
const STRUCTURAL_UNSEGMENTED = /如何|怎么|怎麼|在哪|哪里|哪裡|追踪|跟踪|追蹤|追跡|トレース|流程|流向|流れ|路径|路徑|経路|调用|調用|呼び出|依赖|依賴|依存|影响|影響|实现|實現|実装|架构|架構|アーキテクチャ|结构|結構|構造|介绍|介紹|解析|分析|原理|机制|機制|仕組み|説明|動作|どうやって|どのように|어떻게|어디|호출|흐름|경로|의존|영향|구현|구조|아키텍처|추적|동작|작동|설명|كيف|أين|اين|يستدعي|استدعاء|يعتمد|تعتمد|يؤثر|تأثير|معماري|بنية|هيكل|تدفق|مسار|تتبع|يعمل|تعمل|اشرح|شرح|چگونه|چطور|کجا|فراخوان|وابسته|تأثیر|معماری|ساختار|مسیر|توضیح|איך|איפה|קורא|תלוי|משפיע|ארכיטקטור|מבנה|זרימה|נתיב|הסבר|อย่างไร|ยังไง|ที่ไหน|เรียกใช้|ขึ้นอยู่กับ|ผลกระทบ|สถาปัตยกรรม|โครงสร้าง|เส้นทาง|ติดตาม|ทำงาน|อธิบาย/;

/** Doc/data/asset file extensions — a `name.ext` of this kind is a file
 *  reference, not a code symbol, so it must not trip the member-access signal. */
const DOC_DATA_EXT = /\.(md|markdown|txt|rst|json|ya?ml|toml|lock|csv|tsv|log|ini|cfg|conf|env|xml|html?|png|jpe?g|gif|svg|pdf)$/i;

/**
 * Does `prompt` contain an explicit structural keyword? A keyword is a strong,
 * self-contained signal, so the front-load hook fires on it directly — no graph
 * check needed. (A *code-token* match, by contrast, is only a candidate the
 * hook verifies against the graph first; see {@link extractCodeTokens}.)
 * Coverage is multilingual (#994, #1126): the ~29 languages with the largest
 * developer populations, across Latin, Cyrillic, Greek, CJK, Hangul, Arabic,
 * Hebrew, Thai, and Devanagari scripts. Languages beyond the keyword table
 * still fire through the language-agnostic code-token path.
 */
export function hasStructuralKeyword(prompt: string): boolean {
  return (
    !!prompt &&
    (STRUCTURAL_WORDS_RE.test(prompt) || STRUCTURAL_STEMS_RE.test(prompt) || STRUCTURAL_UNSEGMENTED.test(prompt))
  );
}

/**
 * Identifier-shaped tokens in `prompt` — camelCase / PascalCase-with-inner-cap,
 * snake_case, a `name(` call, or the two sides of an `a.b` member access. Naming
 * a symbol is a code question whatever the surrounding human language, and these
 * shapes almost never occur in ordinary prose, so they catch the common
 * "<symbol> 的调用链?" / "where is <symbol> 定義" prompts no keyword list would.
 *
 * These are *candidates*, not a verdict: a tech brand like `JavaScript` or
 * `GitHub` is identifier-shaped too, so the front-load hook checks each token
 * against the actual index ({@link getNodesByName}) and only fires when one is a
 * real symbol here — otherwise a brand-name prompt would inject ~16KB of
 * low-relevance context (issue #994 follow-up). A doc/data filename ("README.md")
 * is excluded from the member-access form since it's a file reference, not a symbol.
 */
export function extractCodeTokens(prompt: string): string[] {
  if (!prompt) return [];
  const out = new Set<string>();
  // camelCase / PascalCase-with-inner-cap (getUserId, parseToken, UserService) or
  // snake_case (article_publish, get_user) — a whole identifier run that has an
  // inner lower→upper transition or an underscore flanked by alphanumerics.
  for (const m of prompt.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    if (/[a-z][A-Z]/.test(w) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(w)) out.add(w);
  }
  // call form: an identifier directly before '(' — parseToken(, render(). No
  // whitespace before '(' so prose like "the function (entry point)" doesn't trip it.
  for (const m of prompt.matchAll(/([A-Za-z_$][\w$]*)\(/g)) out.add(m[1]!);
  // member access on identifiers (user.login) — but not a doc/data filename.
  for (const m of prompt.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (!DOC_DATA_EXT.test(m[0])) { out.add(m[1]!); out.add(m[2]!); }
  }
  return [...out];
}

/**
 * Cheap, graph-free candidate gate for the front-load hook: could `prompt` be a
 * structural / flow / impact / "where-how" question worth front-loading context
 * for? True on an explicit keyword in any covered language (#994, #1126) OR an
 * identifier-shaped token. A keyword is sufficient to fire on its own; a
 * token-only match is only a candidate the hook then verifies against the graph
 * (a brand name like `JavaScript` is token-shaped but isn't a symbol). Every
 * non-candidate prompt ("fix this typo", in any language) stays a zero-cost no-op.
 */
export function isStructuralPrompt(prompt: string): boolean {
  return hasStructuralKeyword(prompt) || extractCodeTokens(prompt).length > 0;
}

/**
 * What the front-load hook should do for a prompt issued from a directory.
 */
export interface FrontloadPlan {
  /** Open + explore this project and inject its source as context. `null` when
   *  there's no single project to front-load (none indexed, or several indexed
   *  sub-projects with no clear match — see {@link nudgeProjects}). */
  exploreRoot: string | null;
  /** Indexed sub-projects to surface in a "pass `projectPath`" nudge: the rest
   *  of a monorepo's indexed projects alongside `exploreRoot`, or — when no one
   *  project clearly matches — the full list (with `exploreRoot` null). */
  nudgeProjects: string[];
  /** True when the plan came from scanning DOWN into sub-projects (cwd itself
   *  is not under any index) — the monorepo case, where a follow-up
   *  `codegraph_explore` needs an explicit `projectPath`. */
  viaSubScan: boolean;
}

/**
 * Decide what the front-load hook injects for a `prompt` issued from `cwd`,
 * shaped by where the `.codegraph/` index(es) actually are:
 *   1. **cwd (or an ancestor) is indexed** → front-load that project. The
 *      normal single-project / nested-file case.
 *   2. **cwd isn't indexed but looks like a workspace root** → the indexes live
 *      in sub-projects (the monorepo case behind #964). One indexed
 *      sub-project → front-load it; several → front-load the one the prompt
 *      names (by relative path like `packages/api`, or package directory name)
 *      and nudge about the rest; several with no match → nudge the full list so
 *      the agent passes `projectPath`, rather than guessing wrong.
 *   3. **nothing indexed reachable** → do nothing (the agent's own tools apply).
 */
export function planFrontload(cwd: string, prompt: string): FrontloadPlan {
  const none: FrontloadPlan = { exploreRoot: null, nudgeProjects: [], viaSubScan: false };

  // 1. up-walk — nearest indexed ancestor (incl. cwd). Cheap; covers the common
  //    single-project case without a down-scan.
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    if (isInitialized(dir)) return { exploreRoot: dir, nudgeProjects: [], viaSubScan: false };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2. down-scan — only from something that looks like a workspace root, so a
  //    non-project cwd (e.g. $HOME) is a cheap no-op, not a deep crawl.
  const base = path.resolve(cwd);
  if (!looksLikeProjectRoot(base)) return none;
  const subs = findIndexedSubprojectRoots(base);
  if (subs.length === 0) return none;
  if (subs.length === 1) return { exploreRoot: subs[0]!, nudgeProjects: [], viaSubScan: true };

  // Several indexed sub-projects — pick the one the prompt points at, if any.
  const p = prompt.toLowerCase();
  let best: { root: string; score: number; relLen: number } | null = null;
  for (const s of subs) {
    const rel = path.relative(base, s);
    const relLc = rel.split(path.sep).join('/').toLowerCase();
    const name = path.basename(s).toLowerCase();
    let score = 0;
    if (relLc && p.includes(relLc)) score = 10;                         // "packages/api"
    else if (name.length >= 3 && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(p)) score = 5; // "api"
    if (score > 0 && (!best || score > best.score || (score === best.score && rel.length < best.relLen))) {
      best = { root: s, score, relLen: rel.length };
    }
  }
  if (best) {
    return { exploreRoot: best.root, nudgeProjects: subs.filter((s) => s !== best!.root), viaSubScan: true };
  }
  // No clear match — nudge the full list rather than front-load a guess.
  return { exploreRoot: null, nudgeProjects: subs, viaSubScan: true };
}

/**
 * Contents of `.codegraph/.gitignore`. A single wildcard ignore keeps every
 * transient file in the index dir — the database, `daemon.pid`, the socket,
 * logs, cache, and anything future versions add — out of git, without having
 * to enumerate each name (issues #788, #492, #484). Older versions wrote an
 * explicit allowlist that never listed `daemon.pid` or the socket, so those
 * runtime files were silently committed.
 */
const GITIGNORE_CONTENT = `# CodeGraph data files — local to each machine, not for committing.
# Ignore everything in .codegraph/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;

/** Header line that prefixes every .gitignore CodeGraph has auto-generated. */
const GITIGNORE_MARKER = '# CodeGraph data files';

/**
 * Is `content` a stale CodeGraph-generated `.gitignore` that should be
 * regenerated in place? True when it carries our header but predates the
 * wildcard ignore (it has no bare `*` line) — i.e. one of the old explicit
 * allowlists (`*.db`, `cache/`, `.dirty`, …) that never ignored `daemon.pid`
 * or the socket (issue #788). A file WITHOUT our header is user-authored and
 * is left untouched; one that already has the wildcard is current. Matching
 * on the header (not a byte-exact list of past defaults) heals every old
 * variant — v0.7.x through 0.9.9 — and is idempotent once upgraded.
 */
function isStaleDefaultGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

/**
 * Write `.codegraph/.gitignore` if it's absent, or upgrade a stale
 * CodeGraph-generated default in place; a user-customized file is left alone.
 * Best-effort — returns `false` only if a needed write failed.
 */
function ensureGitignore(gitignorePath: string): boolean {
  let existing: string | null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null; // absent (ENOENT) or unreadable — (re)create below
  }
  // Current default or a user-authored file: nothing to do.
  if (existing !== null && !isStaleDefaultGitignore(existing)) return true;
  try {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the .codegraph directory structure
 * Note: Only throws if codegraph.db already exists, not just if .codegraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);
  const dbPath = path.join(codegraphDir, 'codegraph.db');

  // Only throw if CodeGraph is actually initialized (db exists)
  // .codegraph/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`CodeGraph already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(codegraphDir, { recursive: true });

  // Write .gitignore inside .codegraph (create if absent, upgrade a stale
  // pre-wildcard default left by an older version — issue #788).
  ensureGitignore(path.join(codegraphDir, '.gitignore'));
}

/**
 * Remove the .codegraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  // Verify .codegraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(codegraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(codegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(codegraphDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(codegraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .codegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair / upgrade .gitignore (non-critical file). A missing one is
  // recreated; a stale pre-wildcard default that never ignored daemon.pid is
  // regenerated in place (issue #788); a user-authored file is left alone.
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  if (!ensureGitignore(gitignorePath) && !existedBefore) {
    // Only a missing-and-uncreatable file is surfaced; a failed in-place
    // upgrade of an existing file is non-fatal — the index still works.
    errors.push('.gitignore missing in .codegraph directory and could not be created');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
