/**
 * Extraction Tests
 *
 * Tests for the tree-sitter extraction system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource, scanDirectory, shouldIncludeFile } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages } from '../src/extraction/grammars';
import { normalizePath } from '../src/utils';
import { DEFAULT_CONFIG } from '../src/types';

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Language Detection', () => {
  it('should detect TypeScript files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('components/Button.tsx')).toBe('tsx');
  });

  it('should detect JavaScript files', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('App.jsx')).toBe('jsx');
    expect(detectLanguage('config.mjs')).toBe('javascript');
  });

  it('should detect Python files', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('should detect Go files', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect Rust files', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should detect Java files', () => {
    expect(detectLanguage('Main.java')).toBe('java');
  });

  it('should detect C files', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('utils.h')).toBe('c');
  });

  it('should detect C++ files', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('class.hpp')).toBe('cpp');
  });

  it('should detect C# files', () => {
    expect(detectLanguage('Program.cs')).toBe('csharp');
  });

  it('should detect PHP files', () => {
    expect(detectLanguage('index.php')).toBe('php');
  });

  it('should detect Ruby files', () => {
    expect(detectLanguage('app.rb')).toBe('ruby');
  });

  it('should detect Swift files', () => {
    expect(detectLanguage('ViewController.swift')).toBe('swift');
  });

  it('should detect Kotlin files', () => {
    expect(detectLanguage('MainActivity.kt')).toBe('kotlin');
    expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
  });

  it('should detect Dart files', () => {
    expect(detectLanguage('main.dart')).toBe('dart');
  });

  it('should return unknown for unsupported extensions', () => {
    expect(detectLanguage('styles.css')).toBe('unknown');
    expect(detectLanguage('data.json')).toBe('unknown');
  });
});

describe('Language Support', () => {
  it('should report supported languages', () => {
    expect(isLanguageSupported('typescript')).toBe(true);
    expect(isLanguageSupported('python')).toBe(true);
    expect(isLanguageSupported('go')).toBe(true);
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should list all supported languages', () => {
    const languages = getSupportedLanguages();
    // Core languages with reliable native bindings
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('rust');
    expect(languages).toContain('java');
    expect(languages).toContain('csharp');
    expect(languages).toContain('php');
    expect(languages).toContain('ruby');
    // kotlin, swift and dart grammars may not be available on all platforms
    // (ABI incompatibilities or missing native bindings)
  });
});

describe('TypeScript Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}
`;
    const result = extractFromSource('payment.ts', code);

    // File node + function node
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('payment.ts');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processPayment',
      language: 'typescript',
      isExported: true,
    });
    expect(funcNode?.signature).toContain('amount: number');
  });

  it('should extract class declarations', () => {
    const code = `
export class PaymentService {
  private stripe: StripeClient;

  constructor(apiKey: string) {
    this.stripe = new StripeClient(apiKey);
  }

  async charge(amount: number): Promise<Receipt> {
    return this.stripe.charge(amount);
  }
}
`;
    const result = extractFromSource('service.ts', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    const methodNodes = result.nodes.filter((n) => n.kind === 'method');

    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('PaymentService');
    expect(classNode?.isExported).toBe(true);

    expect(methodNodes.length).toBeGreaterThanOrEqual(1);
    const chargeMethod = methodNodes.find((m) => m.name === 'charge');
    expect(chargeMethod).toBeDefined();
  });

  it('should extract interfaces', () => {
    const code = `
export interface User {
  id: string;
  name: string;
  email: string;
}
`;
    const result = extractFromSource('types.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toMatchObject({
      kind: 'interface',
      name: 'User',
      isExported: true,
    });
  });

  it('should track function calls', () => {
    const code = `
function main() {
  const result = processData();
  console.log(result);
}
`;
    const result = extractFromSource('main.ts', code);

    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((c) => c.referenceName === 'processData')).toBe(true);
  });
});

describe('Arrow Function Export Extraction', () => {
  it('should extract exported arrow functions assigned to const', () => {
    const code = `
export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'useAuth',
      isExported: true,
    });
  });

  it('should extract exported function expressions assigned to const', () => {
    const code = `
export const processData = function(input: string): string {
  return input.trim();
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processData',
      isExported: true,
    });
  });

  it('should not extract non-exported arrow functions as exported', () => {
    const code = `
const internalHelper = () => {
  return 42;
};
`;
    const result = extractFromSource('internal.ts', code);

    const helperNode = result.nodes.find((n) => n.name === 'internalHelper');
    expect(helperNode).toBeDefined();
    expect(helperNode?.isExported).toBeFalsy();
  });

  it('should still skip truly anonymous arrow functions', () => {
    const code = `
const items = [1, 2, 3].map((x) => x * 2);
`;
    const result = extractFromSource('anon.ts', code);

    // The inline arrow function passed to .map() has no variable_declarator parent
    // and should remain anonymous (skipped)
    const anonFunctions = result.nodes.filter(
      (n) => n.kind === 'function' && n.name === '<anonymous>'
    );
    expect(anonFunctions).toHaveLength(0);
  });

  it('should extract multiple exported arrow functions from the same file', () => {
    const code = `
export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

const internal = () => 'not exported';
`;
    const result = extractFromSource('math.ts', code);

    const exported = result.nodes.filter((n) => n.kind === 'function' && n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['add', 'subtract']);

    const internalNode = result.nodes.find((n) => n.name === 'internal');
    expect(internalNode).toBeDefined();
    expect(internalNode?.isExported).toBeFalsy();
  });

  it('should extract arrow functions in JavaScript files', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'fetchData',
      isExported: true,
    });
  });
});

describe('Type Alias Extraction', () => {
  it('should extract exported type aliases in TypeScript', () => {
    const code = `
export type AuthContextValue = {
  user: User | null;
  login: () => void;
  logout: () => void;
};
`;
    const result = extractFromSource('types.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'AuthContextValue',
      isExported: true,
    });
  });

  it('should extract non-exported type aliases', () => {
    const code = `
type InternalState = {
  loading: boolean;
  error: string | null;
};
`;
    const result = extractFromSource('internal.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'InternalState',
      isExported: false,
    });
  });

  it('should extract multiple type aliases from the same file', () => {
    const code = `
export type UnitSystem = 'metric' | 'imperial';
export type DateFormat = 'ISO' | 'US' | 'EU';
type Internal = string;
`;
    const result = extractFromSource('config.ts', code);

    const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias');
    expect(typeAliases).toHaveLength(3);

    const exported = typeAliases.filter((n) => n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['DateFormat', 'UnitSystem']);
  });
});

describe('Exported Variable Extraction', () => {
  it('should extract exported const with call expression (Zustand store)', () => {
    const code = `
export const useUIStore = create<UIState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
`;
    const result = extractFromSource('store.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'variable' && n.name === 'useUIStore');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with object literal', () => {
    const code = `
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
`;
    const result = extractFromSource('config.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'variable' && n.name === 'config');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with array literal', () => {
    const code = `
export const SCREEN_NAMES = ['home', 'settings', 'profile'] as const;
`;
    const result = extractFromSource('constants.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'variable' && n.name === 'SCREEN_NAMES');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with primitive value', () => {
    const code = `
export const MAX_RETRIES = 3;
export const API_VERSION = "v2";
`;
    const result = extractFromSource('constants.ts', code);

    const variables = result.nodes.filter((n) => n.kind === 'variable');
    expect(variables).toHaveLength(2);
    expect(variables.map((n) => n.name).sort()).toEqual(['API_VERSION', 'MAX_RETRIES']);
  });

  it('should NOT duplicate arrow functions as both function and variable', () => {
    const code = `
export const useAuth = () => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    // Should be extracted as function (from arrow function handler), NOT as variable
    const funcNodes = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useAuth');
    const varNodes = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'useAuth');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract non-exported const as non-exported variable', () => {
    const code = `
const internalConfig = {
  debug: true,
};
`;
    const result = extractFromSource('internal.ts', code);

    // Non-exported const at file level should be extracted as a constant (not exported)
    const varNodes = result.nodes.filter((n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'internalConfig');
    expect(varNodes).toHaveLength(1);
    expect(varNodes[0]?.isExported).toBeFalsy();
  });

  it('should extract Zod schema exports', () => {
    const code = `
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
`;
    const result = extractFromSource('schemas.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'variable' && n.name === 'userSchema');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract XState machine exports', () => {
    const code = `
export const authMachine = createMachine({
  id: "auth",
  initial: "idle",
  states: {
    idle: {},
    authenticated: {},
  },
});
`;
    const result = extractFromSource('machine.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'variable' && n.name === 'authMachine');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });
});

describe('File Node Extraction', () => {
  it('should create a file-kind node for each parsed file', () => {
    const code = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
    const result = extractFromSource('greeter.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('greeter.ts');
    expect(fileNode?.filePath).toBe('greeter.ts');
    expect(fileNode?.language).toBe('typescript');
    expect(fileNode?.startLine).toBe(1);
  });

  it('should create file nodes for Python files', () => {
    const code = `
def main():
    pass
`;
    const result = extractFromSource('main.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('main.py');
    expect(fileNode?.language).toBe('python');
  });

  it('should create containment edges from file node to top-level declarations', () => {
    const code = `
export function foo() {}
export function bar() {}
`;
    const result = extractFromSource('fns.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    // There should be contains edges from the file node to each function
    const containsEdges = result.edges.filter(
      (e) => e.source === fileNode?.id && e.kind === 'contains'
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Python Extraction', () => {
  it('should extract function definitions', () => {
    const code = `
def calculate_total(items: list, tax_rate: float) -> float:
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)
`;
    const result = extractFromSource('calc.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'calculate_total',
      language: 'python',
    });
  });

  it('should extract class definitions', () => {
    const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> User:
        return self.db.find_user(user_id)
`;
    const result = extractFromSource('service.py', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
  });
});

describe('Go Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
package main

func ProcessOrder(order Order) (Receipt, error) {
    // Process the order
    return Receipt{}, nil
}
`;
    const result = extractFromSource('main.go', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('ProcessOrder');
  });

  it('should extract method declarations', () => {
    const code = `
package main

type Service struct {
    db *Database
}

func (s *Service) GetUser(id string) (*User, error) {
    return s.db.FindUser(id)
}
`;
    const result = extractFromSource('service.go', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('GetUser');
  });
});

describe('Rust Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
pub fn process_data(input: &str) -> Result<Output, Error> {
    // Process data
    Ok(Output::new())
}
`;
    const result = extractFromSource('lib.rs', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('process_data');
    expect(funcNode?.visibility).toBe('public');
  });

  it('should extract struct declarations', () => {
    const code = `
pub struct User {
    pub id: String,
    pub name: String,
    email: String,
}
`;
    const result = extractFromSource('models.rs', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract trait declarations', () => {
    const code = `
pub trait Repository {
    fn find(&self, id: &str) -> Option<Entity>;
    fn save(&mut self, entity: Entity) -> Result<(), Error>;
}
`;
    const result = extractFromSource('traits.rs', code);

    const traitNode = result.nodes.find((n) => n.kind === 'trait');
    expect(traitNode).toBeDefined();
    expect(traitNode?.name).toBe('Repository');
  });
});

describe('Java Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public User getUser(String id) {
        return repository.findById(id);
    }
}
`;
    const result = extractFromSource('UserService.java', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');
  });

  it('should extract method declarations', () => {
    const code = `
public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const result = extractFromSource('Calculator.java', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'add');
    expect(methodNode).toBeDefined();
    expect(methodNode?.isStatic).toBe(true);
  });
});

describe('C# Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public async Task<Order> GetOrderAsync(string id)
    {
        return await _repository.FindByIdAsync(id);
    }
}
`;
    const result = extractFromSource('OrderService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('OrderService');
    expect(classNode?.visibility).toBe('public');
  });
});

describe('PHP Extraction', () => {
  it('should extract class declarations', () => {
    const code = `<?php

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function show(string $id): User
    {
        return $this->userService->find($id);
    }
}
`;
    const result = extractFromSource('UserController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserController');
  });
});

describe.skipIf(!isLanguageSupported('swift'))('Swift Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class NetworkManager {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchData(from url: URL) async throws -> Data {
        let (data, _) = try await session.data(from: url)
        return data
    }
}
`;
    const result = extractFromSource('NetworkManager.swift', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('NetworkManager');
  });

  it('should extract function declarations', () => {
    const code = `
func calculateSum(_ numbers: [Int]) -> Int {
    return numbers.reduce(0, +)
}

public func formatCurrency(amount: Double) -> String {
    return String(format: "$%.2f", amount)
}
`;
    const result = extractFromSource('utils.swift', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract struct declarations', () => {
    const code = `
public struct User {
    let id: UUID
    var name: String
    var email: String

    func displayName() -> String {
        return name
    }
}
`;
    const result = extractFromSource('User.swift', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract protocol declarations', () => {
    const code = `
public protocol Repository {
    associatedtype Entity

    func find(id: String) async throws -> Entity?
    func save(_ entity: Entity) async throws
}
`;
    const result = extractFromSource('Repository.swift', code);

    const protocolNode = result.nodes.find((n) => n.kind === 'interface');
    expect(protocolNode).toBeDefined();
    expect(protocolNode?.name).toBe('Repository');
  });
});

describe.skipIf(!isLanguageSupported('kotlin'))('Kotlin Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserRepository(private val database: Database) {
    fun findById(id: String): User? {
        return database.query("SELECT * FROM users WHERE id = ?", id)
    }

    suspend fun save(user: User) {
        database.insert(user)
    }
}
`;
    const result = extractFromSource('UserRepository.kt', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserRepository');
  });

  it('should extract function declarations', () => {
    const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}

suspend fun fetchUserData(userId: String): User {
    return api.getUser(userId)
}
`;
    const result = extractFromSource('utils.kt', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect suspend functions as async', () => {
    const code = `
suspend fun loadData(): List<String> {
    delay(1000)
    return listOf("a", "b", "c")
}
`;
    const result = extractFromSource('loader.kt', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.isAsync).toBe(true);
  });
});

describe.skipIf(!isLanguageSupported('dart'))('Dart Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserService {
  final Database _db;

  Future<User> findById(String id) async {
    return await _db.query(id);
  }

  void _privateMethod() {}
}
`;
    const result = extractFromSource('service.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');

    const methodNodes = result.nodes.filter((n) => n.kind === 'method');
    expect(methodNodes.length).toBeGreaterThanOrEqual(2);

    const findById = methodNodes.find((m) => m.name === 'findById');
    expect(findById).toBeDefined();
    expect(findById?.isAsync).toBe(true);

    const privateMethod = methodNodes.find((m) => m.name === '_privateMethod');
    expect(privateMethod).toBeDefined();
    expect(privateMethod?.visibility).toBe('private');
  });

  it('should extract top-level function declarations', () => {
    const code = `
void topLevelFunction(String name) {
  print(name);
}
`;
    const result = extractFromSource('utils.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('topLevelFunction');
    expect(funcNode?.language).toBe('dart');
  });

  it('should extract enum declarations', () => {
    const code = `
enum Status { active, inactive, pending }
`;
    const result = extractFromSource('models.dart', code);

    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    expect(enumNode).toBeDefined();
    expect(enumNode?.name).toBe('Status');
  });

  it('should extract mixin declarations', () => {
    const code = `
mixin LoggerMixin {
  void log(String message) {}
}
`;
    const result = extractFromSource('mixins.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('LoggerMixin');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('log');
  });

  it('should extract extension declarations', () => {
    const code = `
extension StringExt on String {
  bool get isBlank => trim().isEmpty;
}
`;
    const result = extractFromSource('extensions.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('StringExt');
  });

  it('should detect static methods', () => {
    const code = `
class Utils {
  static void doWork() {}
}
`;
    const result = extractFromSource('utils.dart', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('doWork');
    expect(methodNode?.isStatic).toBe(true);
  });

  it('should detect async functions', () => {
    const code = `
Future<String> fetchData() async {
  return await http.get('/data');
}
`;
    const result = extractFromSource('api.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('fetchData');
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should detect private visibility via underscore convention', () => {
    const code = `
void _privateHelper() {}

void publicFunction() {}
`;
    const result = extractFromSource('helpers.dart', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    const privateFunc = functions.find((f) => f.name === '_privateHelper');
    const publicFunc = functions.find((f) => f.name === 'publicFunction');

    expect(privateFunc?.visibility).toBe('private');
    expect(publicFunc?.visibility).toBe('public');
  });
});

describe('Import Extraction', () => {
  describe('TypeScript/JavaScript imports', () => {
    it('should extract default imports', () => {
      const code = `import React from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toBe("import React from 'react';");
    });

    it('should extract named imports', () => {
      const code = `import { Bug, Database } from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('Bug');
      expect(importNode?.signature).toContain('Database');
    });

    it('should extract namespace imports', () => {
      const code = `import * as Icons from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('* as Icons');
    });

    it('should extract side-effect imports', () => {
      const code = `import './styles.css';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('./styles.css');
    });

    it('should extract mixed imports (default + named)', () => {
      const code = `import React, { useState, useEffect } from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('React');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useEffect');
    });

    it('should extract multiple import statements', () => {
      const code = `
import React from 'react';
import { Button } from './components';
import './styles.css';
`;
      const result = extractFromSource('app.tsx', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('react');
      expect(names).toContain('./components');
      expect(names).toContain('./styles.css');
    });

    it('should extract type imports', () => {
      const code = `import type { FC, ReactNode } from 'react';`;
      const result = extractFromSource('types.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('type');
      expect(importNode?.signature).toContain('FC');
    });

    it('should extract aliased named imports', () => {
      const code = `import { useState as useStateAlias } from 'react';`;
      const result = extractFromSource('hooks.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useStateAlias');
    });

    it('should extract relative path imports', () => {
      const code = `import { helper } from '../utils/helper';`;
      const result = extractFromSource('components/Button.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helper');
      expect(importNode?.signature).toContain('helper');
    });
  });

  describe('Python imports', () => {
    it('should extract simple import statement', () => {
      const code = `import json`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
    });

    it('should extract from import statement', () => {
      const code = `from os import path`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('os');
      expect(importNode?.signature).toContain('path');
    });

    it('should extract multiple imports from same module', () => {
      const code = `from typing import List, Dict, Optional`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('List');
      expect(importNode?.signature).toContain('Dict');
    });

    it('should extract multiple import statements', () => {
      const code = `
import os
import sys
`;
      const result = extractFromSource('main.py', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('os');
      expect(names).toContain('sys');
    });

    it('should extract aliased import', () => {
      const code = `import numpy as np`;
      const result = extractFromSource('data.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('numpy');
      expect(importNode?.signature).toContain('as np');
    });

    it('should extract relative import', () => {
      const code = `from .utils import helper`;
      const result = extractFromSource('module.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('.utils');
      expect(importNode?.signature).toContain('helper');
    });

    it('should extract wildcard import', () => {
      const code = `from typing import *`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('*');
    });
  });

  describe('Rust imports', () => {
    it('should extract simple use declaration', () => {
      const code = `use std::io;`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toBe('use std::io;');
    });

    it('should extract scoped use list', () => {
      const code = `use std::{ffi::OsStr, io, path::Path};`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toContain('ffi::OsStr');
      expect(importNode?.signature).toContain('path::Path');
    });

    it('should extract crate imports', () => {
      const code = `use crate::error::Error;`;
      const result = extractFromSource('lib.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('crate');
    });

    it('should extract super imports', () => {
      const code = `use super::utils;`;
      const result = extractFromSource('submod.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('super');
    });

    it('should extract external crate imports', () => {
      const code = `use serde::{Serialize, Deserialize};`;
      const result = extractFromSource('types.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('serde');
      expect(importNode?.signature).toContain('Serialize');
      expect(importNode?.signature).toContain('Deserialize');
    });
  });

  describe('Go imports', () => {
    it('should extract single import', () => {
      const code = `
package main

import "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
    });

    it('should extract grouped imports', () => {
      const code = `
package main

import (
	"fmt"
	"os"
	"encoding/json"
)
`;
      const result = extractFromSource('main.go', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('fmt');
      expect(names).toContain('os');
      expect(names).toContain('encoding/json');
    });

    it('should extract aliased import', () => {
      const code = `
package main

import f "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
      expect(importNode?.signature).toContain('f');
    });

    it('should extract dot import', () => {
      const code = `
package main

import . "math"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('math');
      expect(importNode?.signature).toContain('.');
    });

    it('should extract blank import', () => {
      const code = `
package main

import _ "github.com/go-sql-driver/mysql"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('github.com/go-sql-driver/mysql');
      expect(importNode?.signature).toContain('_');
    });
  });

  describe.skipIf(!isLanguageSupported('swift'))('Swift imports', () => {
    it('should extract simple import', () => {
      const code = `import Foundation`;
      const result = extractFromSource('main.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Foundation');
      expect(importNode?.signature).toBe('import Foundation');
    });

    it('should extract @testable import', () => {
      const code = `@testable import Alamofire`;
      const result = extractFromSource('Tests.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Alamofire');
      expect(importNode?.signature).toContain('@testable');
    });

    it('should extract @preconcurrency import', () => {
      const code = `@preconcurrency import Security`;
      const result = extractFromSource('Auth.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Security');
    });

    it('should extract multiple imports', () => {
      const code = `
import Foundation
import UIKit
import Alamofire
`;
      const result = extractFromSource('App.swift', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Foundation');
      expect(names).toContain('UIKit');
      expect(names).toContain('Alamofire');
    });
  });

  describe.skipIf(!isLanguageSupported('kotlin'))('Kotlin imports', () => {
    it('should extract simple import', () => {
      const code = `import java.io.IOException`;
      const result = extractFromSource('Main.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.io.IOException');
      expect(importNode?.signature).toBe('import java.io.IOException');
    });

    it('should extract aliased import', () => {
      const code = `import okhttp3.Request.Builder as RequestBuilder`;
      const result = extractFromSource('Utils.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('okhttp3.Request.Builder');
      expect(importNode?.signature).toContain('as RequestBuilder');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.concurrent.TimeUnit.*`;
      const result = extractFromSource('Time.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.concurrent.TimeUnit');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.io.IOException
import kotlin.test.assertFailsWith
import okhttp3.OkHttpClient
`;
      const result = extractFromSource('Test.kt', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.io.IOException');
      expect(names).toContain('kotlin.test.assertFailsWith');
      expect(names).toContain('okhttp3.OkHttpClient');
    });
  });

  describe('Java imports', () => {
    it('should extract simple import', () => {
      const code = `import java.util.List;`;
      const result = extractFromSource('Main.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.List');
      expect(importNode?.signature).toBe('import java.util.List;');
    });

    it('should extract static import', () => {
      const code = `import static java.util.Collections.emptyList;`;
      const result = extractFromSource('Utils.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Collections.emptyList');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.*;`;
      const result = extractFromSource('App.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract nested class import', () => {
      const code = `import java.util.Map.Entry;`;
      const result = extractFromSource('MapUtil.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Map.Entry');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
      const result = extractFromSource('Service.java', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.util.List');
      expect(names).toContain('java.util.Map');
      expect(names).toContain('java.io.IOException');
    });
  });

  describe('C# imports', () => {
    it('should extract simple using', () => {
      const code = `using System;`;
      const result = extractFromSource('Program.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System');
      expect(importNode?.signature).toBe('using System;');
    });

    it('should extract qualified using', () => {
      const code = `using System.Collections.Generic;`;
      const result = extractFromSource('Utils.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic');
    });

    it('should extract static using', () => {
      const code = `using static System.Console;`;
      const result = extractFromSource('App.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Console');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract alias using', () => {
      const code = `using MyList = System.Collections.Generic.List<int>;`;
      const result = extractFromSource('Types.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic.List<int>');
      expect(importNode?.signature).toContain('MyList =');
    });

    it('should extract multiple usings', () => {
      const code = `
using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
`;
      const result = extractFromSource('Service.cs', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('System');
      expect(names).toContain('System.Threading.Tasks');
      expect(names).toContain('Microsoft.Extensions.DependencyInjection');
    });
  });

  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = `<?php use PHPUnit\\Framework\\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('PHPUnit\\Framework\\TestCase');
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = `<?php use function Illuminate\\Support\\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Illuminate\\Support\\env');
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = `<?php use Illuminate\\Database\\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Database\\Model');
      expect(names).toContain('Illuminate\\Database\\Builder');
    });

    it('should extract multiple uses', () => {
      const code = `<?php
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Support\\Collection');
      expect(names).toContain('Illuminate\\Support\\Str');
      expect(names).toContain('Closure');
    });
  });

  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });

  describe('C/C++ imports', () => {
    it('should extract system include', () => {
      const code = `#include <iostream>`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('iostream');
      expect(importNode?.signature).toBe('#include <iostream>');
    });

    it('should extract system include with path', () => {
      const code = `#include <nlohmann/json.hpp>`;
      const result = extractFromSource('app.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('nlohmann/json.hpp');
    });

    it('should extract local include', () => {
      const code = `#include "myheader.h"`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('myheader.h');
    });

    it('should extract C header', () => {
      const code = `#include <stdio.h>`;
      const result = extractFromSource('main.c', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('stdio.h');
    });

    it('should extract multiple includes', () => {
      const code = `
#include <iostream>
#include <vector>
#include "config.h"
`;
      const result = extractFromSource('app.cpp', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('iostream');
      expect(names).toContain('vector');
      expect(names).toContain('config.h');
    });
  });

  describe.skipIf(!isLanguageSupported('dart'))('Dart imports', () => {
    it('should extract dart: import', () => {
      const code = `import 'dart:async';`;
      const result = extractFromSource('main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('dart:async');
      expect(importNode?.signature).toBe("import 'dart:async';");
    });

    it('should extract package import', () => {
      const code = `import 'package:flutter/material.dart';`;
      const result = extractFromSource('app.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:flutter/material.dart');
    });

    it('should extract aliased import', () => {
      const code = `import 'package:http/http.dart' as http;`;
      const result = extractFromSource('api.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:http/http.dart');
      expect(importNode?.signature).toContain('as http');
    });

    it('should extract multiple imports', () => {
      const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
      const result = extractFromSource('main.dart', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('dart:async');
      expect(names).toContain('dart:convert');
      expect(names).toContain('package:flutter/material.dart');
    });

    it('should extract relative import', () => {
      const code = `import '../utils/helpers.dart';`;
      const result = extractFromSource('lib/main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helpers.dart');
    });
  });

  describe('Liquid imports', () => {
    it('should extract render tag', () => {
      const code = `{% render 'loading-spinner' %}`;
      const result = extractFromSource('template.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('loading-spinner');
      expect(importNode?.signature).toContain('render');
    });

    it('should extract section tag', () => {
      const code = `{% section 'header' %}`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('header');
      expect(importNode?.signature).toContain('section');
    });

    it('should extract include tag', () => {
      const code = `{% include 'icon-cart' %}`;
      const result = extractFromSource('snippets/header.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('icon-cart');
      expect(importNode?.signature).toContain('include');
    });

    it('should extract render with whitespace control', () => {
      const code = `{%- render 'price' -%}`;
      const result = extractFromSource('snippets/product.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('price');
    });

    it('should extract multiple imports', () => {
      const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('header');
      expect(names).toContain('loading-spinner');
      expect(names).toContain('cart-drawer');
    });
  });
});

describe('Full Indexing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index a TypeScript file', async () => {
    // Create test file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.nodesCreated).toBeGreaterThanOrEqual(2);

    // Check nodes were stored
    const nodes = cg.getNodesInFile('src/utils.ts');
    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const addFunc = nodes.find((n) => n.name === 'add');
    expect(addFunc).toBeDefined();
    expect(addFunc?.kind).toBe('function');

    cg.close();
  });

  it('should index multiple files', async () => {
    // Create test files
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'math.ts'),
      `export function add(a: number, b: number) { return a + b; }`
    );

    fs.writeFileSync(
      path.join(srcDir, 'string.ts'),
      `export function capitalize(s: string) { return s.toUpperCase(); }`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);

    const files = cg.getFiles();
    expect(files.length).toBe(2);

    cg.close();
  });

  it('should track file hashes for incremental updates', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 1;`);

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();

    // Check file is tracked
    const file = cg.getFile('src/main.ts');
    expect(file).toBeDefined();
    expect(file?.contentHash).toBeDefined();

    // Modify file
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 2;`);

    // Check for changes
    const changes = cg.getChangedFiles();
    expect(changes.modified).toContain('src/main.ts');

    cg.close();
  });

  it('should sync and detect changes', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function original() { return 1; }`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();

    const initialNodes = cg.getNodesInFile('src/main.ts');
    expect(initialNodes.some((n) => n.name === 'original')).toBe(true);

    // Modify file
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function updated() { return 2; }`
    );

    // Sync
    const syncResult = await cg.sync();
    expect(syncResult.filesModified).toBe(1);

    // Check nodes were updated
    const updatedNodes = cg.getNodesInFile('src/main.ts');
    expect(updatedNodes.some((n) => n.name === 'updated')).toBe(true);
    expect(updatedNodes.some((n) => n.name === 'original')).toBe(false);

    cg.close();
  });
});

describe('Path Normalization', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath('gui\\node_modules\\foo')).toBe('gui/node_modules/foo');
    expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should leave forward-slash paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should handle empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('Directory Exclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should exclude node_modules directories', () => {
    // Create structure: src/index.ts + node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'src');
    const nmDir = path.join(tempDir, 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude nested node_modules directories', () => {
    // Create structure: packages/app/node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'packages', 'app', 'src');
    const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('packages/app/src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude .git directories', () => {
    const srcDir = path.join(tempDir, 'src');
    const gitDir = path.join(tempDir, '.git', 'objects');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('.git'))).toBe(true);
  });

  it('should return forward-slash paths on all platforms', () => {
    const srcDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files.length).toBe(1);
    expect(files[0]).toBe('src/components/Button.tsx');
    expect(files[0]).not.toContain('\\');
  });

  it('should respect .codegraphignore marker', () => {
    const srcDir = path.join(tempDir, 'src');
    const vendorDir = path.join(tempDir, 'vendor');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(vendorDir, 'lib.ts'), 'export const y = 2;');
    fs.writeFileSync(path.join(vendorDir, '.codegraphignore'), '');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('vendor'))).toBe(true);
  });
});
