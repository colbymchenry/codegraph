/** Bounded, source-preserving HDL conditional selection. No macro expansion. */
export interface HdlPreprocessDiagnostic {
  filePath: string;
  line: number;
  code: string;
  message: string;
}
export interface HdlIncludeSource { filePath: string; source: string }
export interface HdlPreprocessOptions {
  filePath: string;
  defines?: Record<string, string | null>;
  includeDirs?: string[];
  /** The caller owns filesystem access and must enforce its allowed roots. */
  readInclude?: (request: string, fromFile: string, includeDirs: readonly string[]) => HdlIncludeSource | null;
  maxIncludeDepth?: number;
}
export interface HdlPreprocessResult {
  source: string;
  dependencies: string[];
  diagnostics: HdlPreprocessDiagnostic[];
  /** All encountered constructs were handled within this bounded mode. */
  complete: boolean;
}
interface Conditional {
  parent: boolean;
  active: boolean;
  taken: boolean;
  uncertain: boolean;
  elseSeen: boolean;
}
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*/;
const OTHER_DIRECTIVES = new Set(['timescale', 'default_nettype', 'celldefine', 'endcelldefine',
  'resetall', 'unconnected_drive', 'nounconnected_drive', 'line', 'begin_keywords', 'end_keywords', 'pragma']);

/** Each call is a separate translation unit. Includes affect macro definedness,
 * but are never pasted into the returned text. All offsets are original UTF-16
 * offsets; inactive text is replaced with spaces while CR/LF bytes stay put. */
export function preprocessVerilog(source: string, options: HdlPreprocessOptions): HdlPreprocessResult {
  const diagnostics: HdlPreprocessDiagnostic[] = [];
  const record = (diagnostic: HdlPreprocessDiagnostic): void => {
    if (diagnostics.length < 512) diagnostics.push(diagnostic);
    else if (diagnostics.length === 512) diagnostics.push({ ...diagnostic, code: 'diagnostic-limit',
      message: 'Additional preprocessing diagnostics were omitted after 512 entries.' });
  };
  const dependencies = new Set<string>();
  const macros = new Map<string, boolean>();
  let unknownMacros = false;
  const trace = new Set<string>();
  const requestedDepth = options.maxIncludeDepth;
  const maxDepth = Number.isSafeInteger(requestedDepth) && requestedDepth! >= 0 ? Math.min(requestedDepth!, 256) : 64;
  const invalidateMacros = (): void => { macros.clear(); unknownMacros = true; };
  const mask = (text: string): string => text.replace(/[^\r\n]/g, ' ');
  for (const name of Object.keys(options.defines ?? {})) {
    if (IDENTIFIER.exec(name)?.[0] === name) macros.set(name, true);
    else record({ filePath: options.filePath, line: 1, code: 'invalid-profile-define', message: `Invalid macro name: ${name}` });
  }

  const process = (text: string, filePath: string, depth: number): string => {
    const output = text.split('');
    const stack: Conditional[] = [];
    let fatal = false;
    const lineStarts = [0];
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
    const active = (): boolean => stack.length ? stack[stack.length - 1]!.active : true;
    const report = (offset: number, code: string, message: string): void => {
      let lo = 0, hi = lineStarts.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid]! <= offset) lo = mid; else hi = mid; }
      record({ filePath, line: lo + 1, code, message });
    };
    const blank = (start: number, end: number): void => {
      for (let n = start; n < end; n++) if (text[n] !== '\n' && text[n] !== '\r') output[n] = ' ';
    };
    const lineEnd = (start: number): number => {
      let end = text.indexOf('\n', start);
      if (end < 0) return text.length;
      while (end > 0 && text[end - (text[end - 1] === '\r' ? 2 : 1)] === '\\') {
        const next = text.indexOf('\n', end + 1);
        if (next < 0) return text.length;
        end = next;
      }
      return end;
    };
    const nameAfter = (offset: number): { name?: string; end: number } => {
      let start = offset;
      while (text[start] === ' ' || text[start] === '\t') start++;
      const name = IDENTIFIER.exec(text.slice(start))?.[0];
      return { name, end: name ? start + name.length : lineEnd(start) };
    };
    const defined = (name: string): boolean | undefined => macros.get(name) ?? (unknownMacros ? undefined : false);
    const condition = (name: string | undefined, invert: boolean, offset: number): boolean | undefined => {
      const value = name ? defined(name) : undefined;
      if (value === undefined) {
        report(offset, name ? 'unknown-conditional' : 'unsupported-conditional', name
          ? `Cannot determine whether ${name} is defined; no branch was selected.`
          : 'Only a simple macro identifier is supported in a conditional directive.');
        // Either unknown arm could define or undefine names used later.
        invalidateMacros();
        return undefined;
      }
      return invert ? !value : value;
    };

    let i = 0;
    while (i < text.length) {
      const start = i;
      // Directives inside comments, strings and escaped identifiers are text.
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i + 2);
        i = end < 0 ? text.length : end;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
      } else if (text[i] === '"') {
        i++;
        while (i < text.length) {
          if (text[i] === '\\') { i += Math.min(2, text.length - i); continue; }
          if (text[i] === '"') { i++; break; }
          if (text[i] === '\n' || text[i] === '\r') break;
          i++;
        }
      } else if (text[i] === '\\') {
        i++;
        while (i < text.length && !/\s/.test(text[i]!)) i++;
      } else if (text[i] === '`') {
        const directive = IDENTIFIER.exec(text.slice(i + 1))?.[0];
        if (!directive) {
          if (active()) report(i, 'unsupported-macro-form', 'Unrecognized backtick form was preserved.');
          if (!active()) blank(i, i + 1);
          i++;
          continue;
        }
        const tokenEnd = i + 1 + directive.length;
        if (['ifdef', 'ifndef', 'elsif'].includes(directive)) {
          const argument = nameAfter(tokenEnd);
          blank(i, argument.end);
          if (directive !== 'elsif') {
            const parent = active();
            const value = parent ? condition(argument.name, directive === 'ifndef', i) : false;
            stack.push({ parent, active: parent && value === true, taken: value === true,
              uncertain: value === undefined, elseSeen: false });
          } else {
            const frame = stack[stack.length - 1];
            if (!frame || frame.elseSeen) {
              report(i, 'malformed-conditional', '`elsif without a matching open conditional, or after `else.'); fatal = true;
            } else if (!frame.parent || frame.taken || frame.uncertain) frame.active = false;
            else {
              const value = condition(argument.name, false, i);
              frame.active = value === true;
              frame.taken = value === true;
              frame.uncertain = value === undefined;
            }
          }
          i = argument.end;
          continue;
        }
        if (directive === 'else' || directive === 'endif') {
          blank(i, tokenEnd);
          const frame = stack[stack.length - 1];
          if (!frame || (directive === 'else' && frame.elseSeen)) {
            report(i, 'malformed-conditional', `Unexpected or duplicate \`${directive}.`); fatal = true;
          } else if (directive === 'endif') stack.pop();
          else { frame.active = frame.parent && !frame.taken && !frame.uncertain; frame.taken ||= frame.active; frame.elseSeen = true; }
          i = tokenEnd;
          continue;
        }
        if (directive === 'define') {
          const end = lineEnd(tokenEnd);
          const argument = nameAfter(tokenEnd);
          if (active()) {
            if (argument.name) macros.set(argument.name, true);
            else { report(i, 'unsupported-definition', 'Macro definition without a supported simple name was preserved.'); invalidateMacros(); }
          } else blank(i, end);
          i = end;
          continue;
        }
        if (directive === 'undef') {
          const argument = nameAfter(tokenEnd);
          if (active()) {
            if (argument.name) macros.set(argument.name, false);
            else { report(i, 'unsupported-definition', 'Macro undefinition without a supported simple name was preserved.'); invalidateMacros(); }
          } else blank(i, argument.end);
          i = argument.end;
          continue;
        }
        if (directive === 'undefineall') {
          if (active()) { macros.clear(); unknownMacros = false; } else blank(i, tokenEnd);
          i = tokenEnd;
          continue;
        }
        if (directive === 'include') {
          let cursor = tokenEnd;
          while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
          const opening = text[cursor];
          const closing = opening === '"' ? '"' : opening === '<' ? '>' : '';
          const end = closing ? text.indexOf(closing, cursor + 1) : -1;
          const supported = end >= 0 && !/[\r\n]/.test(text.slice(cursor, end));
          const includeEnd = supported ? end + 1 : lineEnd(cursor);
          if (active()) {
            if (!supported) {
              report(i, 'unsupported-include', 'Only literal quoted or bracketed include paths are supported.'); invalidateMacros();
            } else {
              const request = text.slice(cursor + 1, end);
              let included: HdlIncludeSource | null = null;
              try { included = options.readInclude?.(request, filePath, options.includeDirs ?? []) ?? null; }
              catch { report(i, 'include-read-failed', `Cannot read include ${request}.`); }
              if (!included) { report(i, 'unresolved-include', `Include ${request} was not resolved; subsequent macro state is uncertain.`); invalidateMacros(); }
              else {
                dependencies.add(included.filePath);
                const key = JSON.stringify([included.filePath, unknownMacros, [...macros].sort(([a], [b]) => a.localeCompare(b))]);
                if (depth >= maxDepth || trace.has(key)) {
                  report(i, 'include-cycle-or-depth', `Include recursion cannot be resolved at ${included.filePath}.`); invalidateMacros();
                } else { trace.add(key); process(included.source, included.filePath, depth + 1); trace.delete(key); }
              }
            }
          } else blank(i, includeEnd);
          i = includeEnd;
          continue;
        }
        if (active()) {
          report(i, OTHER_DIRECTIVES.has(directive) ? 'unsupported-directive' : 'unsupported-macro-expansion',
            `\`${directive} was preserved; ${OTHER_DIRECTIVES.has(directive) ? 'this compiler directive is not interpreted' : 'macro expansion is not supported'}.`);
          // A replacement can itself contain `define/`undef/`include. Without
          // expanding it, later macro definedness cannot be assumed unchanged.
          if (!OTHER_DIRECTIVES.has(directive)) invalidateMacros();
        } else blank(i, tokenEnd);
        i = tokenEnd;
        continue;
      } else i++;
      if (!active()) blank(start, i);
    }
    if (stack.length) { report(text.length, 'malformed-conditional', 'Conditional directive has no matching `endif.'); fatal = true; }
    if (fatal) { invalidateMacros(); return mask(text); }
    return output.join('');
  };
  const selected = process(source, options.filePath, 0);
  return { source: selected, dependencies: [...dependencies], diagnostics, complete: diagnostics.length === 0 };
}
