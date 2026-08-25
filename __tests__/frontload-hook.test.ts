/**
 * Front-load hook project resolution (#964).
 *
 * The Claude `UserPromptSubmit` front-load hook must inject CodeGraph context
 * for the RIGHT project — including the monorepo case where the agent's cwd is
 * an un-indexed workspace root and the index lives in a sub-project. These test
 * `planFrontload` / `findIndexedSubprojectRoots` directly (the hook's decision
 * logic), since the end-to-end hook is validated by a live agent run, not a
 * unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planFrontload, findIndexedSubprojectRoots, isStructuralPrompt, hasStructuralKeyword, extractCodeTokens } from '../src/directory';

/** Make `dir` look indexed (isInitialized needs `.codegraph/codegraph.db`). */
function mkIndexed(dir: string): string {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  return dir;
}
/** A workspace-root manifest so the down-scan gate (looksLikeProjectRoot) passes. */
function mkWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
  return dir;
}

describe('planFrontload — front-load hook project resolution (#964)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-frontload-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('cwd is itself indexed → front-load cwd (the common single-project case)', () => {
    mkIndexed(tmp);
    const plan = planFrontload(tmp, 'how does login work');
    expect(plan.exploreRoot).toBe(tmp);
    expect(plan.viaSubScan).toBe(false);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('a nested file under an indexed project resolves up to that project', () => {
    mkIndexed(tmp);
    const nested = path.join(tmp, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(planFrontload(nested, 'trace the flow').exploreRoot).toBe(tmp);
  });

  it('un-indexed workspace root with ONE indexed sub-project → front-load it (the #964 case)', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const plan = planFrontload(tmp, 'how does the request get handled');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('multiple indexed sub-projects, prompt names one by path → front-load it, nudge the rest', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'in packages/api, how does the handler validate the token?');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([web]);
  });

  it('multiple indexed sub-projects, prompt names one by package name → front-load it', () => {
    mkWorkspaceRoot(tmp);
    mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does the web frontend render the dashboard?');
    expect(plan.exploreRoot).toBe(web);
  });

  it('multiple indexed sub-projects, NO clear match → nudge the full list, do not guess', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does authentication work end to end?');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects.sort()).toEqual([api, web].sort());
  });

  it('un-indexed dir that is NOT a workspace root → no-op (guards $HOME-style crawls)', () => {
    // Indexed project exists below, but cwd has no manifest, so the down-scan is skipped.
    mkIndexed(path.join(tmp, 'some', 'project'));
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('nothing indexed anywhere → no-op', () => {
    mkWorkspaceRoot(tmp);
    fs.mkdirSync(path.join(tmp, 'packages', 'api'), { recursive: true });
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });
});

describe('findIndexedSubprojectRoots', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-subscan-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds indexed projects a couple levels down and skips node_modules/.git', () => {
    mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(tmp, 'services', 'auth'));
    // Decoys that must NOT be scanned into.
    mkIndexed(path.join(tmp, 'node_modules', 'dep'));
    mkIndexed(path.join(tmp, '.git', 'x'));
    const found = findIndexedSubprojectRoots(tmp).map((p) => path.relative(tmp, p)).sort();
    expect(found).toEqual([path.join('packages', 'api'), path.join('services', 'auth')].sort());
  });

  it('does not descend INTO an indexed project (a project\'s sub-dirs are not separate projects)', () => {
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(api, 'submodule')); // nested index under an already-indexed project
    const found = findIndexedSubprojectRoots(tmp);
    expect(found).toEqual([api]);
  });

  it('respects the depth bound', () => {
    mkIndexed(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep'));
    expect(findIndexedSubprojectRoots(tmp, { maxDepth: 2 })).toEqual([]);
  });
});

describe('hasStructuralKeyword — keyword signal fires the hook directly (#994)', () => {
  it('English keywords match with word boundaries so "flow" ≠ "flower"', () => {
    expect(hasStructuralKeyword('how does article publish work')).toBe(true);
    expect(hasStructuralKeyword('where is the token validated')).toBe(true);
    expect(hasStructuralKeyword('trace the request flow')).toBe(true);
    expect(hasStructuralKeyword('what calls parseToken')).toBe(true);
    expect(hasStructuralKeyword('water the flower')).toBe(false);   // "flow" in "flower"
  });

  it('Chinese keywords match WITHOUT `\\b` — the #994 fix (were silently dropped)', () => {
    expect(hasStructuralKeyword('介绍文章发布流程')).toBe(true);      // introduce / flow
    expect(hasStructuralKeyword('登录是如何实现的')).toBe(true);       // how / implement
    expect(hasStructuralKeyword('这个函数的调用链')).toBe(true);        // call (chain)
    expect(hasStructuralKeyword('支付模块依赖哪些服务')).toBe(true);    // depend
    expect(hasStructuralKeyword('修复这个拼写错误')).toBe(false);       // "fix this typo"
  });

  it('a bare code-token is NOT a keyword — it needs graph verification', () => {
    expect(hasStructuralKeyword('看看 get_user 这段逻辑')).toBe(false);
    expect(hasStructuralKeyword('I really love JavaScript')).toBe(false);
  });
});

describe('hasStructuralKeyword — Latin-script languages, Cyrillic, JA/KO (#1126)', () => {
  it('French structural prompts fire — including the prompts from the report', () => {
    expect(hasStructuralKeyword('comment marche la state machine des commandes ?')).toBe(true);
    expect(hasStructuralKeyword("explique l'architecture du module de stock")).toBe(true);
    expect(hasStructuralKeyword('qui appelle cette fonction de parsing ?')).toBe(true);
    expect(hasStructuralKeyword('de quoi dépend le module de paiement ?')).toBe(true);
  });

  it('accented keyword edges match — ASCII `\\b` could never bound "où"', () => {
    expect(hasStructuralKeyword('où est validé le token ?')).toBe(true);
    expect(hasStructuralKeyword("d'où vient cette valeur ?")).toBe(true);
  });

  it('Spanish / Portuguese / German / Italian fire', () => {
    expect(hasStructuralKeyword('¿cómo funciona la máquina de estados de pedidos?')).toBe(true);
    expect(hasStructuralKeyword('¿qué rompe este cambio?')).toBe(true);
    expect(hasStructuralKeyword('como funciona a máquina de estados dos pedidos?')).toBe(true);
    expect(hasStructuralKeyword('qual é a arquitetura do módulo de estoque?')).toBe(true);
    expect(hasStructuralKeyword('wie funktioniert die Zustandsmaschine für Bestellungen?')).toBe(true);
    expect(hasStructuralKeyword('wovon hängt das Zahlungsmodul ab?')).toBe(true);
    expect(hasStructuralKeyword('come funziona la macchina a stati degli ordini?')).toBe(true);
    expect(hasStructuralKeyword('spiegami la struttura del modulo ordini')).toBe(true);
  });

  it('Russian / Japanese / Korean / traditional Chinese fire', () => {
    expect(hasStructuralKeyword('как работает конечный автомат заказов?')).toBe(true);
    expect(hasStructuralKeyword('от чего зависит модуль оплаты?')).toBe(true);
    expect(hasStructuralKeyword('注文のステートマシンの仕組みを説明して')).toBe(true);
    expect(hasStructuralKeyword('この関数の呼び出しの流れは?')).toBe(true);
    expect(hasStructuralKeyword('주문 상태 머신은 어떻게 작동하나요?')).toBe(true);
    expect(hasStructuralKeyword('訂單狀態機的架構是怎麼實現的?')).toBe(true);
  });

  it('English derived forms fire — "architecture"/"dependencies" failed the old exact-word list', () => {
    expect(hasStructuralKeyword('explain the architecture of the stock module')).toBe(true);
    expect(hasStructuralKeyword('what are the dependencies of the parser?')).toBe(true);
  });

  it('second-tier languages fire — VI/TR/ID/PL/UA/NL/CS/RO/HU/EL/SV/NO/FI/HI', () => {
    expect(hasStructuralKeyword('state machine của đơn hàng hoạt động thế nào?')).toBe(true);   // Vietnamese
    expect(hasStructuralKeyword('sipariş durum makinesi nasıl çalışıyor?')).toBe(true);          // Turkish
    expect(hasStructuralKeyword('bu fonksiyonun bağımlılıkları neler?')).toBe(true);             // Turkish (stem)
    expect(hasStructuralKeyword('bagaimana cara kerja mesin status pesanan?')).toBe(true);       // Indonesian
    expect(hasStructuralKeyword('jak działa maszyna stanów zamówień?')).toBe(true);              // Polish
    expect(hasStructuralKeyword('co wywołuje tę funkcję?')).toBe(true);                          // Polish (stem)
    expect(hasStructuralKeyword('як працює кінцевий автомат замовлень?')).toBe(true);            // Ukrainian
    expect(hasStructuralKeyword('від чого залежить модуль оплати?')).toBe(true);                 // Ukrainian (stem)
    expect(hasStructuralKeyword('hoe werkt de state machine van bestellingen?')).toBe(true);     // Dutch
    expect(hasStructuralKeyword('jak funguje stavový automat objednávek?')).toBe(true);          // Czech
    expect(hasStructuralKeyword('cum funcționează mașina de stări a comenzilor?')).toBe(true);   // Romanian
    expect(hasStructuralKeyword('hogyan működik a rendelések állapotgépe?')).toBe(true);         // Hungarian
    expect(hasStructuralKeyword('πώς λειτουργεί η μηχανή καταστάσεων παραγγελιών;')).toBe(true); // Greek
    expect(hasStructuralKeyword('hur fungerar orderns tillståndsmaskin?')).toBe(true);           // Swedish
    expect(hasStructuralKeyword('hvordan fungerer ordrenes tilstandsmaskin?')).toBe(true);       // Norwegian/Danish
    expect(hasStructuralKeyword('miten tilausten tilakone toimii?')).toBe(true);                 // Finnish
    expect(hasStructuralKeyword('ऑर्डर स्टेट मशीन कैसे काम करती है?')).toBe(true);                 // Hindi
  });

  it('RTL scripts and Thai fire — proclitics/unsegmented text uses substring matching', () => {
    expect(hasStructuralKeyword('كيف تعمل آلة حالات الطلبات؟')).toBe(true);        // Arabic
    expect(hasStructuralKeyword('وكيف يعتمد هذا على قاعدة البيانات؟')).toBe(true); // Arabic, proclitic و attached
    expect(hasStructuralKeyword('ماشین وضعیت سفارش‌ها چگونه کار می‌کند؟')).toBe(true); // Farsi
    expect(hasStructuralKeyword('איך עובדת מכונת המצבים של ההזמנות?')).toBe(true);  // Hebrew
    expect(hasStructuralKeyword('สถาปัตยกรรมของระบบทำงานอย่างไร')).toBe(true);       // Thai
  });

  it('terms that collide with English or code words are deliberately excluded', () => {
    expect(hasStructuralKeyword('pad the buffer with zeros')).toBe(false);     // NL pad=path skipped
    expect(hasStructuralKeyword('declare a var for the count')).toBe(false);   // SV var=where skipped
    expect(hasStructuralKeyword('refresh the token')).toBe(false);             // CS tok=flow skipped
    expect(hasStructuralKeyword('run the llama model locally')).toBe(false);   // ES bare llama skipped
    expect(hasStructuralKeyword('come back to this later')).toBe(false);       // IT bare come skipped
  });

  it('stems match only at word start — no mid-word false positives', () => {
    expect(hasStructuralKeyword('restructure this paragraph')).toBe(false); // "structur" mid-word
    expect(hasStructuralKeyword('an independent module')).toBe(false);      // "depend" mid-word
    expect(hasStructuralKeyword('water the flower')).toBe(false);           // unchanged guarantee
  });

  it('bounded stems reject ordinary-English completions (#1138)', () => {
    expect(hasStructuralKeyword('he has a callus on his palm')).toBe(false);
    expect(hasStructuralKeyword('a lovely calligraphy font')).toBe(false);
    expect(hasStructuralKeyword('Connecticut is a state')).toBe(false);
    expect(hasStructuralKeyword('connective tissue damage')).toBe(false);
    expect(hasStructuralKeyword('she is very affectionate')).toBe(false);
    expect(hasStructuralKeyword('Tracey went home early')).toBe(false);
  });

  it('bounded stems keep every structural derived form (#1138)', () => {
    // call
    expect(hasStructuralKeyword('list the callers of parseToken')).toBe(true);
    expect(hasStructuralKeyword('what callbacks fire on save')).toBe(true);
    expect(hasStructuralKeyword('is submitOrder callable from the worker')).toBe(true);
    expect(hasStructuralKeyword('find every call site of dispose')).toBe(true);
    expect(hasStructuralKeyword('who called setupRouter')).toBe(true);
    // trace ("tracing" is covered by the exact-word list — the e drops)
    expect(hasStructuralKeyword('trace the request')).toBe(true);
    expect(hasStructuralKeyword('we traced it to the cache layer')).toBe(true);
    expect(hasStructuralKeyword('add tracing to the pipeline')).toBe(true);
    // affect / connect
    expect(hasStructuralKeyword('which modules are affected by this change')).toBe(true);
    expect(hasStructuralKeyword('how do the connections get pooled')).toBe(true);
    expect(hasStructuralKeyword('the connector registers itself at boot')).toBe(true);
  });

  it('non-structural prose stays a no-op in every covered language', () => {
    expect(hasStructuralKeyword('corrige cette faute de frappe')).toBe(false);   // FR "fix this typo"
    expect(hasStructuralKeyword('arregla este error tipográfico')).toBe(false);  // ES
    expect(hasStructuralKeyword('behebe diesen Tippfehler')).toBe(false);        // DE
    expect(hasStructuralKeyword('исправь эту опечатку')).toBe(false);            // RU
    expect(hasStructuralKeyword('このタイプミスを直して')).toBe(false);            // JA
    expect(hasStructuralKeyword('이 오타를 수정해줘')).toBe(false);                // KO
    expect(hasStructuralKeyword('sửa lỗi chính tả này')).toBe(false);            // VI
    expect(hasStructuralKeyword('bu yazım hatasını düzelt')).toBe(false);        // TR
    expect(hasStructuralKeyword('popraw tę literówkę')).toBe(false);             // PL
    expect(hasStructuralKeyword('صحح هذا الخطأ الإملائي')).toBe(false);          // AR
  });
});

describe('extractCodeTokens — candidate symbols the hook verifies against the graph', () => {
  it('pulls camelCase / PascalCase / snake_case / call / member tokens', () => {
    expect(extractCodeTokens('prepareArticlePublish 的调用链')).toContain('prepareArticlePublish');
    expect(extractCodeTokens('看看 get_user 这段逻辑')).toContain('get_user');   // snake_case
    expect(extractCodeTokens('render() 在哪触发')).toContain('render');          // call form
    expect(extractCodeTokens('user.login 做了什么').sort()).toEqual(['login', 'user']); // member access
    expect(extractCodeTokens('看看 UserService')).toContain('UserService');      // PascalCase class kept
  });

  it('a tech brand is extracted as a CANDIDATE — the hook’s graph check is what rejects it', () => {
    // This is the #994 follow-up: "JavaScript" is identifier-shaped, so it surfaces
    // here as a candidate; the hook only fires if it's a real symbol in the index.
    expect(extractCodeTokens('I really love JavaScript')).toEqual(['JavaScript']);
    expect(extractCodeTokens('thoughts on GitHub vs GitLab').sort()).toEqual(['GitHub', 'GitLab']);
  });

  it('ordinary prose and doc/data filenames yield no tokens', () => {
    expect(extractCodeTokens('fix typo in readme')).toEqual([]);
    expect(extractCodeTokens('fix the typo in README.md')).toEqual([]);   // doc filename excluded
    expect(extractCodeTokens('bump the version in package.json')).toEqual([]);
    expect(extractCodeTokens('water the flower')).toEqual([]);
  });
});

describe('isStructuralPrompt — cheap candidate gate (keyword OR code-token)', () => {
  it('fires on a keyword prompt in any language', () => {
    expect(isStructuralPrompt('how does article publish work')).toBe(true);
    expect(isStructuralPrompt('介绍文章发布流程')).toBe(true);
  });

  it('fires on a code-token prompt with no keyword', () => {
    expect(isStructuralPrompt('看看 get_user 这段逻辑')).toBe(true);
    expect(isStructuralPrompt('where is prepareArticlePublish 定义')).toBe(true);
    expect(isStructuralPrompt('user.login 做了什么')).toBe(true);
  });

  it('a tech brand passes the CHEAP gate as a candidate — the hook then graph-verifies it', () => {
    // Layering, not a bug: isStructuralPrompt is shape-only, so a token-shaped brand
    // is a candidate here; the hook rejects it as a non-symbol (proven by the CLI e2e).
    expect(isStructuralPrompt('I really love JavaScript')).toBe(true);
  });

  it('non-structural prose stays a no-op — in either language', () => {
    expect(isStructuralPrompt('fix typo in readme')).toBe(false);
    expect(isStructuralPrompt('修复这个拼写错误')).toBe(false);
    expect(isStructuralPrompt('water the flower')).toBe(false);
    expect(isStructuralPrompt('')).toBe(false);
  });
});
