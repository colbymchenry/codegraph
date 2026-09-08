/**
 * Branch guards, call sites and decorators for the server languages — Python,
 * Java, Kotlin, C#, Go, C — read from source the way the Steps view reads
 * them. Every language gets the same four readings the JS rules give: the
 * conditions a site runs under (early exits before it included), what it is
 * passed, what is called as written, and what is written on its definition.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars } from '../src/extraction/grammars';
import { callSiteInSource, decoratorsInSource, guardsInSource, guardLabel, loopsInSource, memberTypesInSource, supportsBranchGuards } from '../src/graph/branch-guards';
import type { Language } from '../src/types';

beforeAll(async () => {
  await initGrammars();
});

function lineOf(src: string, needle: string): number {
  const i = src.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line contains ${needle}`);
  return i + 1;
}

async function labelAt(src: string, needle: string, language: Language): Promise<string> {
  const line = lineOf(src, needle);
  const column = src.split('\n')[line - 1]!.indexOf(needle);
  return guardLabel(await guardsInSource(src, language, line, column));
}

async function siteAt(src: string, needle: string, language: Language) {
  const line = lineOf(src, needle);
  const column = src.split('\n')[line - 1]!.indexOf(needle);
  return callSiteInSource(src, language, line, column);
}

describe('languages with rules', () => {
  it('names them', () => {
    for (const l of ['python', 'java', 'kotlin', 'csharp', 'go', 'c', 'cpp']) expect(supportsBranchGuards(l)).toBe(true);
    expect(supportsBranchGuards('ruby')).toBe(false);
    expect(supportsBranchGuards('php')).toBe(false);
  });
});

describe('Python', () => {
  const src = `
@router.post("/", dependencies=[Depends(auth)])
def create_item(session: SessionDep, item_in: ItemCreate) -> Any:
    if not item_in.title:
        raise HTTPException(status_code=400, detail="no title")
    try:
        item = Item.model_validate(item_in, update={"owner_id": 1})
    except ValueError as e:
        return None
    if item.count > 0 and item.ok:
        session.add(item)
    elif item.count == 0:
        session.delete(item)
    else:
        pass
    match item.kind:
        case "a":
            session.commit()
        case _:
            pass
    x = a if cond else b
    for i in items:
        if i is None:
            continue
        session.refresh(i)
    return item
`;
  it('reads if / elif / match / early exits / the ternary form / the loop guard', async () => {
    expect(await labelAt(src, 'raise HTTPException', 'python')).toBe('not item_in.title');
    expect(await labelAt(src, 'session.add(item)', 'python')).toBe('item_in.title && item.count > 0 and item.ok');
    expect(await labelAt(src, 'session.delete(item)', 'python')).toBe('item_in.title && !(item.count > 0 and item.ok) && item.count == 0');
    expect(await labelAt(src, 'session.commit()', 'python')).toBe('item_in.title && item.kind == "a"');
    expect(await labelAt(src, 'session.refresh(i)', 'python')).toBe('item_in.title && i is not None');
    expect(await labelAt(src, 'return None', 'python')).toBe('item_in.title && on error');
  });
  it('reads the call as written, with keyword arguments', async () => {
    expect(await siteAt(src, 'HTTPException(', 'python')).toMatchObject({ callee: 'HTTPException', args: 'status_code=400, detail="no title"' });
    expect(await siteAt(src, 'Item.model_validate', 'python')).toMatchObject({ callee: 'Item.model_validate', args: 'item_in, update={ "owner_id" }' });
  });
  it('reads the decorators on the definition', async () => {
    expect(await decoratorsInSource(src, 'python', lineOf(src, 'def create_item'))).toEqual({
      own: ['router.post("/", dependencies=[Depends(auth)])'],
      class: [],
    });
  });
});

describe('Java', () => {
  const src = `
@RestController
@RequestMapping("/api")
public class OwnerController {
  @PostMapping("/owners/new")
  @PreAuthorize("hasRole('ADMIN')")
  public String processCreationForm(@Valid Owner owner, BindingResult result) {
    if (result.hasErrors()) {
      return VIEWS;
    }
    try {
      this.owners.save(owner);
    } catch (IllegalStateException e) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "x");
    }
    switch (owner.kind) {
      case A: owners.delete(owner); break;
      default: return "b";
    }
    String s = cond ? a() : b();
    Owner o = new Owner("x", 3);
    return cond && !late ? "redirect:/owners/" + owner.getId() : "x";
  }
}
`;
  it('reads early exits, try/catch, switch and the ternary', async () => {
    expect(await labelAt(src, 'this.owners.save', 'java')).toBe('!result.hasErrors()');
    // A negated guard on one call with nested parentheses stays a bare `!`.
    const nested = 'class A {\n  void f(Owner owner, int ownerId) {\n    if (!Objects.equals(owner.getId(), ownerId)) {\n      return;\n    }\n    owners.save(owner);\n  }\n}\n';
    expect(await labelAt(nested, 'owners.save', 'java')).toBe('Objects.equals(owner.getId(), ownerId)');
    expect(await labelAt(src, 'new ResponseStatusException', 'java')).toBe('!result.hasErrors() && on error');
    expect(await labelAt(src, 'owners.delete(owner)', 'java')).toBe('!result.hasErrors() && owner.kind == A');
    expect(await labelAt(src, 'return "b"', 'java')).toBe('!result.hasErrors() && owner.kind: default');
    expect(await labelAt(src, 'a() : b()', 'java')).toBe('!result.hasErrors() && cond');
    expect(await labelAt(src, 'owner.getId()', 'java')).toBe('!result.hasErrors() && cond && !late');
  });
  it('reads the call as written', async () => {
    expect(await siteAt(src, 'new Owner(', 'java')).toMatchObject({ callee: 'Owner', args: '"x", 3' });
    expect(await siteAt(src, 'this.owners.save', 'java')).toMatchObject({ callee: 'this.owners.save', args: 'owner' });
    expect(await siteAt(src, 'new ResponseStatusException', 'java')).toMatchObject({ callee: 'ResponseStatusException', args: 'HttpStatus.NOT_FOUND, "x"' });
  });
  it('reads the annotations on the method and its class', async () => {
    expect(await decoratorsInSource(src, 'java', lineOf(src, 'public String processCreationForm'))).toEqual({
      own: ['PostMapping("/owners/new")', 'PreAuthorize("hasRole(\'ADMIN\')")'],
      class: ['RestController', 'RequestMapping("/api")'],
    });
  });
});

describe('Kotlin', () => {
  const src = `
@RestController
class OwnerController(val owners: OwnerRepository) {
  @PostMapping("/owners/new")
  fun processCreationForm(@Valid owner: Owner, result: BindingResult): String {
    if (result.hasErrors()) {
      return VIEWS
    }
    try { owners.save(owner) } catch (e: IllegalStateException) { throw NotFound("x") }
    when (owner.kind) {
      A -> owners.delete(owner)
      else -> return "b"
    }
    val s = if (cond) a() else b()
    owner.let { owners.save(it) }
    return "redirect:/owners/"
  }
}
`;
  it('reads early exits, try/catch, when and the if-expression', async () => {
    expect(await labelAt(src, 'owners.save(owner)', 'kotlin')).toBe('!result.hasErrors()');
    expect(await labelAt(src, 'NotFound("x")', 'kotlin')).toBe('!result.hasErrors() && on error');
    expect(await labelAt(src, 'owners.delete(owner)', 'kotlin')).toBe('!result.hasErrors() && owner.kind == A');
    expect(await labelAt(src, 'return "b"', 'kotlin')).toBe('!result.hasErrors() && owner.kind: else');
    expect(await labelAt(src, 'a() else', 'kotlin')).toBe('!result.hasErrors() && cond');
    expect(await labelAt(src, 'b()', 'kotlin')).toBe('!result.hasErrors() && !cond');
    // A lambda is inline: the conditions around it are the conditions it runs under.
    expect(await labelAt(src, 'owners.save(it)', 'kotlin')).toBe('!result.hasErrors()');
  });
  it('reads the call as written', async () => {
    expect(await siteAt(src, 'owners.delete(owner)', 'kotlin')).toMatchObject({ callee: 'owners.delete', args: 'owner' });
    // A trailing lambda is `{ … }`, as Swift's closure is — not its body.
    const lambda = 'class A(val prefs: DataStore<P>) {\n  suspend fun set(b: Boolean) {\n    prefs.updateData { it.copy { bookmarked = b } }\n  }\n}\n';
    expect(await siteAt(lambda, 'prefs.updateData', 'kotlin')).toMatchObject({ callee: 'prefs.updateData', args: '{ … }' });
  });
  it('reads the annotations', async () => {
    expect(await decoratorsInSource(src, 'kotlin', lineOf(src, 'fun processCreationForm'))).toEqual({
      own: ['PostMapping("/owners/new")'],
      class: ['RestController'],
    });
  });
});

describe('C#', () => {
  const src = `
[ApiController]
public class TodoController : ControllerBase {
  [HttpPost("items")]
  [Authorize(Roles = "Admin")]
  public async Task<IActionResult> Create([FromBody] Item item) {
    if (item == null) return BadRequest();
    try { await _context.Items.AddAsync(item); } catch (DbUpdateException e) { return Conflict(); }
    switch (item.Kind) { case 1: _bus.Publish(item); break; default: break; }
    var x = cond ? Ok(item) : NotFound();
    return item.Ok && !late ? Created("x", item) : StatusCode(500);
  }
}
`;
  it('reads early exits, try/catch, switch and the conditional', async () => {
    expect(await labelAt(src, '_context.Items.AddAsync', 'csharp')).toBe('item != null');
    expect(await labelAt(src, 'Conflict()', 'csharp')).toBe('item != null && on error');
    expect(await labelAt(src, '_bus.Publish', 'csharp')).toBe('item != null && item.Kind == 1');
    expect(await labelAt(src, 'Ok(item)', 'csharp')).toBe('item != null && cond');
    expect(await labelAt(src, 'NotFound()', 'csharp')).toBe('item != null && !cond');
    expect(await labelAt(src, 'Created("x"', 'csharp')).toBe('item != null && item.Ok && !late');
    expect(await labelAt(src, 'StatusCode(500)', 'csharp')).toBe('item != null && !(item.Ok && !late)');
  });
  it('reads the call as written', async () => {
    expect(await siteAt(src, '_context.Items.AddAsync', 'csharp')).toMatchObject({ callee: '_context.Items.AddAsync', args: 'item' });
    expect(await siteAt(src, 'Created("x"', 'csharp')).toMatchObject({ callee: 'Created', args: '"x", item' });
  });
  it('reads the attributes on the action and its controller', async () => {
    expect(await decoratorsInSource(src, 'csharp', lineOf(src, 'public async Task<IActionResult> Create'))).toEqual({
      own: ['HttpPost("items")', 'Authorize(Roles = "Admin")'],
      class: ['ApiController'],
    });
  });
});

describe('Go', () => {
  const src = `
package main
func createUser(c *gin.Context) {
  if err := c.BindJSON(&u); err != nil {
    c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
    return
  }
  if u.Name == "" && !ok {
    c.AbortWithStatus(404)
  } else if u.Age > 3 {
    db.Create(&u)
  } else {
    db.Save(&u)
  }
  switch u.Kind {
  case "a":
    q.Publish("x", u)
  default:
    return
  }
  go worker(u)
  c.JSON(http.StatusCreated, u)
}
`;
  it('reads the idiomatic error guard flipped, else-if chains and the switch', async () => {
    expect(await labelAt(src, 'c.JSON(http.StatusBadRequest', 'go')).toBe('err != nil');
    expect(await labelAt(src, 'c.AbortWithStatus', 'go')).toBe('err == nil && u.Name == "" && !ok');
    expect(await labelAt(src, 'db.Create', 'go')).toBe('err == nil && !(u.Name == "" && !ok) && u.Age > 3');
    expect(await labelAt(src, 'db.Save', 'go')).toBe('err == nil && !(u.Name == "" && !ok) && !(u.Age > 3)');
    expect(await labelAt(src, 'q.Publish', 'go')).toBe('err == nil && u.Kind == "a"');
    expect(await labelAt(src, 'worker(u)', 'go')).toBe('err == nil');
  });
  it('reads the call as written, a composite literal as its type', async () => {
    expect(await siteAt(src, 'c.JSON(http.StatusBadRequest', 'go')).toMatchObject({ callee: 'c.JSON', args: 'http.StatusBadRequest, gin.H{…}' });
  });
});

describe('C', () => {
  const src = `
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "r");
  if (!f) { perror("open"); return 1; }
  if (argc > 2 && flag) fprintf(stderr, "x %d", argc);
  else exit(2);
  switch (argc) { case 1: fclose(f); break; default: break; }
  int x = argc ? read(fd, buf, 10) : 0;
  return 0;
}
`;
  it('reads the null-check guard, if/else, switch and the ternary', async () => {
    expect(await labelAt(src, 'perror(', 'c')).toBe('!f');
    expect(await labelAt(src, 'fprintf(', 'c')).toBe('f && argc > 2 && flag');
    expect(await labelAt(src, 'exit(2)', 'c')).toBe('f && !(argc > 2 && flag)');
    expect(await labelAt(src, 'fclose(f)', 'c')).toBe('f && argc == 1');
    expect(await labelAt(src, 'read(fd', 'c')).toBe('f && argc');
  });
  it('reads the call as written', async () => {
    expect(await siteAt(src, 'fprintf(', 'c')).toMatchObject({ callee: 'fprintf', args: 'stderr, "x %d", argc' });
  });
});

describe('member types', () => {
  it('TypeScript: constructor parameter properties and typed fields', async () => {
    const src = `
@Injectable()
export class CatsService {
  private readonly log: Logger = new Logger()
  constructor(
    @InjectRepository(Cat) private readonly catsRepository: Repository<Cat>,
    private readonly mailer: MailerService,
    plain: string
  ) {}
  async create(dto) {
    return this.catsRepository.save(dto)
  }
}
`;
    const types = await memberTypesInSource(src, 'typescript', lineOf(src, 'async create'));
    expect(Object.fromEntries(types)).toEqual({ log: 'Logger', catsRepository: 'Repository<Cat>', mailer: 'MailerService' });
  });
  it('Java: fields and constructor parameters', async () => {
    const src = `
public class OwnerController {
  private final OwnerRepository owners;
  private VisitService visits;
  public OwnerController(OwnerRepository owners, Clock clock) { this.owners = owners; }
  public String create(Owner owner) { return owners.save(owner); }
}
`;
    const types = await memberTypesInSource(src, 'java', lineOf(src, 'public String create'));
    expect(Object.fromEntries(types)).toEqual({ owners: 'OwnerRepository', visits: 'VisitService', clock: 'Clock' });
  });
  it('Kotlin: the primary constructor and properties', async () => {
    const src = `
class OwnerController(val owners: OwnerRepository, private val visits: VisitService, plain: String) {
  val clock: Clock = Clock.systemUTC()
  fun create(owner: Owner): String = owners.save(owner)
}
`;
    const types = await memberTypesInSource(src, 'kotlin', lineOf(src, 'fun create'));
    expect(Object.fromEntries(types)).toEqual({ owners: 'OwnerRepository', visits: 'VisitService', clock: 'Clock' });
  });
  it('C#: fields, properties and constructor parameters', async () => {
    const src = `
public class OrderService : IOrderService {
  private readonly IRepository<Order> _orderRepository;
  public IEmailSender Mailer { get; }
  public OrderService(IRepository<Order> orderRepository, IUriComposer uriComposer) { _orderRepository = orderRepository; }
  public async Task Create(Order o) { await _orderRepository.AddAsync(o); }
}
`;
    const types = await memberTypesInSource(src, 'csharp', lineOf(src, 'public async Task Create'));
    expect(Object.fromEntries(types)).toEqual({ _orderRepository: 'IRepository<Order>', Mailer: 'IEmailSender', orderRepository: 'IRepository<Order>', uriComposer: 'IUriComposer' });
  });
});

describe('loops a site is written inside', () => {
  /** The loop headers at the site, outermost first, as `<kind> <text>`. */
  async function loopsAt(src: string, needle: string, language: Language) {
    const line = lineOf(src, needle);
    const column = src.split('\n')[line - 1]!.indexOf(needle);
    return (await loopsInSource(src, language, line, column)).map((l) => `${l.kind} ${l.text}`);
  }

  it('reads a JS for-of and a while', async () => {
    const src = `
function run(items) {
  for (const item of items) {
    save(item)
  }
  while (queue.length > 0) {
    drain()
  }
}`;
    expect(await loopsAt(src, 'save(item)', 'javascript')).toEqual(['each item of items']);
    expect(await loopsAt(src, 'drain()', 'javascript')).toEqual(['while queue.length > 0']);
  });

  it('reads nested loops outermost first', async () => {
    const src = `
function run(rows) {
  for (const row of rows) {
    for (const cell of row) {
      draw(cell)
    }
  }
}`;
    expect(await loopsAt(src, 'draw(cell)', 'javascript')).toEqual(['each row of rows', 'each cell of row']);
  });

  it('reads nothing for a site outside every loop', async () => {
    const src = `
function run(items) {
  begin()
  for (const item of items) { save(item) }
}`;
    expect(await loopsAt(src, 'begin()', 'javascript')).toEqual([]);
  });

  it('reads a Python for and a while', async () => {
    const src = `
def run(items):
    for item in items:
        save(item)
    while pending:
        drain()
`;
    expect(await loopsAt(src, 'save(item)', 'python')).toEqual(['each item in items']);
    expect(await loopsAt(src, 'drain()', 'python')).toEqual(['while pending']);
  });

  it('reads a Java enhanced for', async () => {
    const src = `
class A {
  void run(List<Item> items) {
    for (Item item : items) {
      save(item);
    }
  }
}`;
    expect(await loopsAt(src, 'save(item)', 'java')).toEqual(['each Item item : items']);
  });

  it('reads a Go range loop', async () => {
    const src = `
func run(items []Item) {
	for _, item := range items {
		save(item)
	}
}`;
    expect(await loopsAt(src, 'save(item)', 'go')).toEqual(['each _, item := range items']);
  });

  it('reads a C# foreach', async () => {
    const src = `
class A {
  void Run(List<Item> items) {
    foreach (var item in items) {
      Save(item);
    }
  }
}`;
    // The binding word is noise in a header a person reads: `var` goes.
    expect(await loopsAt(src, 'Save(item)', 'csharp')).toEqual(['each item in items']);
  });

  it('reads a Swift for-in', async () => {
    const src = `
func run(items: [Item]) {
  for item in items {
    save(item)
  }
}`;
    expect(await loopsAt(src, 'save(item)', 'swift')).toEqual(['each item in items']);
  });

  it('reads a Kotlin for', async () => {
    const src = `
fun run(items: List<Item>) {
    for (item in items) {
        save(item)
    }
}`;
    expect(await loopsAt(src, 'save(item)', 'kotlin')).toEqual(['each item in items']);
  });

  it('reads nothing for a language without rules', async () => {
    expect(await loopsInSource('def f\n  xs.each { save }\nend\n', 'ruby', 2, 2)).toEqual([]);
  });
});
