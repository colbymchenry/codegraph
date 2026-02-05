/**
 * Configuration Management
 *
 * Load, save, and validate CodeGraph configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { CodeGraphConfig, DEFAULT_CONFIG, Language, NodeKind } from './types';

/**
 * Configuration filename
 */
export const CONFIG_FILENAME = 'config.json';

/**
 * Get the config file path for a project
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', CONFIG_FILENAME);
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): config is CodeGraphConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Required fields
  if (typeof c.version !== 'number') return false;
  if (typeof c.rootDir !== 'string') return false;
  if (!Array.isArray(c.include)) return false;
  if (!Array.isArray(c.exclude)) return false;
  if (!Array.isArray(c.languages)) return false;
  if (!Array.isArray(c.frameworks)) return false;
  if (typeof c.maxFileSize !== 'number') return false;
  if (typeof c.extractDocstrings !== 'boolean') return false;
  if (typeof c.trackCallSites !== 'boolean') return false;
  if (typeof c.enableEmbeddings !== 'boolean') return false;

  // Validate include/exclude are string arrays
  if (!c.include.every((p) => typeof p === 'string')) return false;
  if (!c.exclude.every((p) => typeof p === 'string')) return false;

  // Validate languages
  const validLanguages: Language[] = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'unknown',
  ];
  if (!c.languages.every((l) => validLanguages.includes(l as Language))) return false;

  // Validate frameworks
  for (const fw of c.frameworks) {
    if (typeof fw !== 'object' || fw === null) return false;
    const framework = fw as Record<string, unknown>;
    if (typeof framework.name !== 'string') return false;
  }

  // Validate custom patterns if present
  if (c.customPatterns !== undefined) {
    if (!Array.isArray(c.customPatterns)) return false;
    for (const pattern of c.customPatterns) {
      if (typeof pattern !== 'object' || pattern === null) return false;
      const p = pattern as Record<string, unknown>;
      if (typeof p.name !== 'string') return false;
      if (typeof p.pattern !== 'string') return false;
      if (typeof p.kind !== 'string') return false;
    }
  }

  return true;
}

/**
 * Merge configuration with defaults
 */
function mergeConfig(
  defaults: CodeGraphConfig,
  overrides: Partial<CodeGraphConfig>
): CodeGraphConfig {
  return {
    version: overrides.version ?? defaults.version,
    rootDir: overrides.rootDir ?? defaults.rootDir,
    include: overrides.include ?? defaults.include,
    exclude: overrides.exclude ?? defaults.exclude,
    languages: overrides.languages ?? defaults.languages,
    frameworks: overrides.frameworks ?? defaults.frameworks,
    maxFileSize: overrides.maxFileSize ?? defaults.maxFileSize,
    extractDocstrings: overrides.extractDocstrings ?? defaults.extractDocstrings,
    trackCallSites: overrides.trackCallSites ?? defaults.trackCallSites,
    enableEmbeddings: overrides.enableEmbeddings ?? defaults.enableEmbeddings,
    customPatterns: overrides.customPatterns ?? defaults.customPatterns,
  };
}

/**
 * Load configuration from a project
 */
export function loadConfig(projectRoot: string): CodeGraphConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    // Return default config with adjusted rootDir
    return {
      ...DEFAULT_CONFIG,
      rootDir: projectRoot,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Merge with defaults to ensure all fields are present
    const merged = mergeConfig(DEFAULT_CONFIG, parsed as Partial<CodeGraphConfig>);
    merged.rootDir = projectRoot; // Always use actual project root

    if (!validateConfig(merged)) {
      throw new Error('Invalid configuration format');
    }

    return merged;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Save configuration to a project
 */
export function saveConfig(projectRoot: string, config: CodeGraphConfig): void {
  const configPath = getConfigPath(projectRoot);
  const dir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create a copy without rootDir (it's always derived from project path)
  const toSave = { ...config };
  delete (toSave as Partial<CodeGraphConfig>).rootDir;

  const content = JSON.stringify(toSave, null, 2);
  fs.writeFileSync(configPath, content, 'utf-8');
}

/**
 * Create default configuration for a new project
 */
export function createDefaultConfig(projectRoot: string): CodeGraphConfig {
  return {
    ...DEFAULT_CONFIG,
    rootDir: projectRoot,
  };
}

/**
 * Update specific configuration values
 */
export function updateConfig(
  projectRoot: string,
  updates: Partial<CodeGraphConfig>
): CodeGraphConfig {
  const current = loadConfig(projectRoot);
  const updated = mergeConfig(current, updates);
  updated.rootDir = projectRoot;
  saveConfig(projectRoot, updated);
  return updated;
}

/**
 * Add patterns to include list
 */
export function addIncludePatterns(projectRoot: string, patterns: string[]): CodeGraphConfig {
  const config = loadConfig(projectRoot);
  const newPatterns = patterns.filter((p) => !config.include.includes(p));
  config.include = [...config.include, ...newPatterns];
  saveConfig(projectRoot, config);
  return config;
}

/**
 * Add patterns to exclude list
 */
export function addExcludePatterns(projectRoot: string, patterns: string[]): CodeGraphConfig {
  const config = loadConfig(projectRoot);
  const newPatterns = patterns.filter((p) => !config.exclude.includes(p));
  config.exclude = [...config.exclude, ...newPatterns];
  saveConfig(projectRoot, config);
  return config;
}

/**
 * Add a custom pattern
 */
export function addCustomPattern(
  projectRoot: string,
  name: string,
  pattern: string,
  kind: NodeKind
): CodeGraphConfig {
  const config = loadConfig(projectRoot);

  if (!config.customPatterns) {
    config.customPatterns = [];
  }

  // Check for duplicate name
  const existing = config.customPatterns.find((p) => p.name === name);
  if (existing) {
    existing.pattern = pattern;
    existing.kind = kind;
  } else {
    config.customPatterns.push({ name, pattern, kind });
  }

  saveConfig(projectRoot, config);
  return config;
}

/**
 * Check if a file path matches the include/exclude patterns
 */
export function shouldIncludeFile(filePath: string, config: CodeGraphConfig): boolean {
  // Simple glob matching (for now, just check if any pattern matches)
  // A full implementation would use a proper glob library

  const matchesPattern = (pattern: string, filePath: string): boolean => {
    return picomatch.isMatch(filePath, pattern, { dot: true });
  };

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesPattern(pattern, filePath)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesPattern(pattern, filePath)) {
      return true;
    }
  }

  // Default to not including if no pattern matches
  return false;
}
