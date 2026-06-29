/**
 * #383 — CodeGraph indexes config KEYS but must never surface config VALUES.
 *
 * Spring `application.{yml,properties}` keys are indexed as `constant` nodes so
 * `@Value` resolution works, but their values are routinely secrets (DB
 * passwords, API keys, JDBC URLs with embedded creds). CodeGraph must surface
 * the KEY and never the value — not in node metadata (docstring/signature),
 * not via `codegraph_explore`'s verbatim source dump, and not via
 * `codegraph_node` `includeCode`. An agent that genuinely needs a value can
 * read the file itself (a deliberate pull); CodeGraph must never volunteer it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const SECRET = 'sk-live-DO-NOT-LEAK-2f9a4c7e1b';

describe('config secret redaction (#383)', () => {
  let tmpDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-secret-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example');
    const resDir = path.join(tmpDir, 'src/main/resources');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });
    // pom.xml triggers Spring detection so the resolver parses the config files.
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n',
    );
    fs.writeFileSync(
      path.join(resDir, 'application.properties'),
      `server.port=8080\nspring.datasource.password=${SECRET}\n`,
    );
    fs.writeFileSync(
      path.join(resDir, 'application.yml'),
      `app:\n  api:\n    key: "${SECRET}"\n`,
    );
    fs.writeFileSync(
      path.join(javaDir, 'DataConfig.java'),
      'package com.example;\n' +
        'import org.springframework.beans.factory.annotation.Value;\n' +
        'public class DataConfig {\n' +
        '  @Value("${spring.datasource.password}") private String dbPass;\n' +
        '  @Value("${app.api.key}") private String apiKey;\n' +
        '}\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const configKeys = () =>
    cg.getNodesByKind('constant').filter((n) => n.language === 'yaml' || n.language === 'properties');

  it('still indexes config KEYS as nodes (resolution must not regress)', () => {
    const byQn = (qn: string) => configKeys().find((n) => n.qualifiedName === qn);
    expect(byQn('spring.datasource.password'), '.properties key indexed').toBeDefined();
    expect(byQn('app.api.key'), 'yaml key indexed').toBeDefined();
  });

  it('never stores the secret VALUE in node metadata (docstring/signature/name)', () => {
    const keys = configKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const n of keys) {
      expect(n.docstring ?? '', `docstring of ${n.qualifiedName}`).not.toContain(SECRET);
      expect(n.signature ?? '', `signature of ${n.qualifiedName}`).not.toContain(SECRET);
      expect(n.name, `name of ${n.qualifiedName}`).not.toContain(SECRET);
    }
  });

  it('codegraph_explore surfaces the config key but NEVER the secret value', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'DataConfig dbPass apiKey spring.datasource.password app.api.key',
    });
    const text = res.content.map((c) => c.text).join('\n');
    expect(text).toContain('password'); // the key is in scope (non-vacuous)
    expect(text).not.toContain(SECRET); // ...but the value is never dumped
  });

  it('codegraph_node includeCode returns the key, not the secret value', async () => {
    const res = await handler.execute('codegraph_node', {
      symbol: 'spring.datasource.password',
      includeCode: true,
    });
    const text = res.content.map((c) => c.text).join('\n');
    expect(text).toContain('password'); // found the node
    expect(text).not.toContain(SECRET); // value redacted from the code path
  });
});
