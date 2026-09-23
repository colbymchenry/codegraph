/** Public profile state is deliberately separate from the currently configured
 * profile: queries describe the context stored with the index until rebuilt. */
export interface HdlProfileDisplayIdentity {
  name: string;
  fingerprint: string;
  files?: readonly string[];
  includeDirs?: readonly string[];
  defines?: Readonly<Record<string, unknown>>;
  topModules?: readonly string[];
  languageMode?: 'verilog' | 'systemverilog';
}
export interface HdlProfileSettingsSummary {
  fileCount?: number;
  includeDirs?: string[];
  defineNames?: string[];
  topModules?: string[];
  languageMode?: 'verilog' | 'systemverilog';
}
export interface HdlProfileConfiguration {
  status: 'none' | 'active' | 'invalid-config' | 'invalid-profile';
  profile: HdlProfileDisplayIdentity | null;
  diagnostics: string[];
}
export interface HdlIndexedProfileMetadata {
  name: string | null;
  fingerprint: string | null;
  context: string | null;
}
export interface HdlProfileStatus {
  configured: { mode: 'raw' | 'profile' | 'invalid'; name: string | null; fingerprint: string | null } & HdlProfileSettingsSummary;
  indexed: { mode: 'raw' | 'profile' | 'unknown'; name: string | null; fingerprint: string | null; configurationFingerprint: string | null } & HdlProfileSettingsSummary;
  state: 'matches' | 'mismatch' | 'unknown' | 'configuration-error';
  mismatch: boolean | null;
  reindexRecommended: boolean;
  diagnostics: string[];
  indexedDiagnostics: string[];
  incomplete: boolean;
  limitations: string[];
}
const RAW_LIMIT = 'Raw source may contain multiple conditional alternatives; no HDL build profile was applied.';
const PROFILE_LIMIT = 'HDL preprocessing selects conditional branches and include macro state; macro invocations are not fully expanded. Displayed snippets are original source and may include inactive branches; indexed symbols follow the selected profile.';
const DIALECT_LIMIT = 'languageMode records the intended dialect; the SystemVerilog grammar does not enforce Verilog-only conformance. topModules are recorded roots, not an elaborated hierarchy.';
const SOURCE_LIMIT = 'Source relationships are not elaboration, synthesis, simulation or timing validation.';

function settingsSummary(value: object | null): HdlProfileSettingsSummary {
  const record = value as Record<string, unknown> | null;
  if (!record) return {};
  const strings = (candidate: unknown): candidate is string[] => Array.isArray(candidate) && candidate.every(n => typeof n === 'string');
  return {
    ...(strings(record.files) ? {fileCount:record.files.length} : {}),
    ...(strings(record.includeDirs) ? {includeDirs:[...record.includeDirs]} : {}),
    ...(record.defines && typeof record.defines === 'object' && !Array.isArray(record.defines)
      ? {defineNames:Object.keys(record.defines).sort()} : {}),
    ...(strings(record.topModules) ? {topModules:[...record.topModules]} : {}),
    ...(record.languageMode === 'verilog' || record.languageMode === 'systemverilog' ? {languageMode:record.languageMode} : {}),
  };
}

export function buildHdlProfileStatus(
  configuration: HdlProfileConfiguration,
  metadata: HdlIndexedProfileMetadata,
  hasHdlFiles: boolean,
): HdlProfileStatus | null {
  if (!hasHdlFiles && configuration.status === 'none' && !metadata.context && !metadata.fingerprint) return null;
  let context: unknown;
  try { context = metadata.context ? JSON.parse(metadata.context) : null; } catch { context = null; }
  const record = context && typeof context === 'object' && !Array.isArray(context)
    ? context as Record<string, unknown> : null;
  const raw = record?.mode === 'raw';
  if (!hasHdlFiles && configuration.status === 'none' && (raw || !metadata.name)) return null;
  const indexed: HdlProfileStatus['indexed'] = raw
    ? {mode:'raw',name:null,fingerprint:metadata.fingerprint,configurationFingerprint:null}
    : metadata.name && metadata.fingerprint && record?.mode === 'profile' && typeof record.configurationFingerprint === 'string'
      ? {mode:'profile',name:metadata.name,fingerprint:metadata.fingerprint,configurationFingerprint:record.configurationFingerprint,...settingsSummary(record)}
      : {mode:'unknown',name:metadata.name,fingerprint:metadata.fingerprint,configurationFingerprint:null};
  const indexedDiagnostics = Array.isArray(record?.diagnostics) ? record.diagnostics.flatMap(value => {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object' && typeof value.message === 'string') {
      const location = typeof value.filePath === 'string' ? `${value.filePath}${typeof value.line === 'number' ? ':' + value.line : ''}: ` : '';
      return [location + value.message];
    }
    return [];
  }) : [];
  const invalid = configuration.status === 'invalid-config' || configuration.status === 'invalid-profile'
    || (configuration.status === 'active' && !configuration.profile);
  const configured: HdlProfileStatus['configured'] = invalid
    ? {mode:'invalid',name:configuration.profile?.name ?? null,fingerprint:null}
    : configuration.status === 'none'
      ? {mode:'raw',name:null,fingerprint:null}
      : {mode:'profile',name:configuration.profile!.name,fingerprint:configuration.profile!.fingerprint,...settingsSummary(configuration.profile)};
  const unknown = indexed.mode === 'unknown';
  const mismatch = invalid || unknown ? null : configured.mode !== indexed.mode
    || (configured.mode === 'profile' && (configured.fingerprint !== indexed.configurationFingerprint || configured.name !== indexed.name));
  return {configured,indexed,state:invalid ? 'configuration-error' : unknown ? 'unknown' : mismatch ? 'mismatch' : 'matches',
    mismatch,reindexRecommended:!invalid && (unknown || mismatch === true),diagnostics:[...configuration.diagnostics],
    indexedDiagnostics,incomplete:record?.incomplete === true || indexedDiagnostics.length > 0,
    limitations:[...(indexed.mode === 'raw' ? [RAW_LIMIT] : indexed.mode === 'profile' ? [PROFILE_LIMIT,DIALECT_LIMIT] : []), SOURCE_LIMIT]};
}

/** Shared compact note for CLI status and MCP explore responses. */
export function formatHdlProfileStatus(status: HdlProfileStatus | null): string {
  if (!status) return '';
  const label = (identity: HdlProfileStatus['indexed'] | HdlProfileStatus['configured']): string => {
    if (identity.mode === 'raw') return 'raw source (no profile)';
    if (identity.mode === 'unknown') return 'unknown';
    if (identity.mode === 'invalid') return 'invalid configuration';
    return `${JSON.stringify(identity.name)} (${identity.fingerprint?.slice(0,12)})`;
  };
  const lines = [`HDL context: indexed ${label(status.indexed)}; configured ${label(status.configured)}.`];
  if (status.indexed.mode === 'profile') {
    const summary = status.indexed;
    const parts = [summary.fileCount == null ? undefined : `${summary.fileCount} file(s)`,
      summary.includeDirs ? `${summary.includeDirs.length} include path(s)` : undefined,
      summary.defineNames ? `${summary.defineNames.length} define(s)` : undefined,
      summary.topModules ? `${summary.topModules.length} recorded top module(s)` : undefined,
      summary.languageMode ? `intended dialect ${summary.languageMode}` : undefined].filter(Boolean);
    if (parts.length) lines.push(`Indexed HDL settings: ${parts.join('; ')}.`);
  }
  if (status.state === 'mismatch') lines.push('Profile mismatch: rebuild the index before interpreting results as the configured profile.');
  if (status.state === 'unknown') lines.push('Indexed profile provenance is unknown; rebuild the index to establish its HDL context.');
  if (status.state === 'configuration-error') lines.push('Fix the HDL profile configuration before rebuilding; results retain the indexed context.');
  if (status.incomplete) lines.push('Indexed HDL preprocessing is incomplete; unresolved regions are not evidence of an inactive branch.');
  for (const [label, diagnostics] of [['HDL configuration', status.diagnostics], ['Indexed HDL', status.indexedDiagnostics]] as const) {
    lines.push(...diagnostics.slice(0,3).map(d=>`${label}: ${d.length > 240 ? d.slice(0,237) + '...' : d}`));
    if (diagnostics.length > 3) lines.push(`${label}: ${diagnostics.length - 3} additional diagnostics; inspect codegraph status --json.`);
  }
  lines.push(...status.limitations);
  return lines.join('\n');
}
