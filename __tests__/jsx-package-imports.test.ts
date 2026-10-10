import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * A tag the file imports from a package — antd's `<Button>`, react-router's
 * `<Link>`, a Vue SFC's `<Card>` from ant-design-vue — renders that package's
 * component, which the index does not hold. Any project symbol that happens
 * to share the name is a stranger. The JSX pass took that namesake, and when
 * the name was unique it never looked at the file's imports at all. On SigNoz
 * that bound about a thousand tags: 431 antd and @signozhq/ui `<Button>`s
 * rendered `export const Button = styled(Link)` from a 404 page's styles.
 *
 * "A package" is what the name matcher already means by it for calls and
 * values: a specifier no project file answers, which a package.json on the
 * file's way to the root declares. An alias that reads like a package
 * (`components/Modal`), an undeclared bare specifier and a workspace package
 * of the repository all stay the project's.
 */
describe('JSX and Vue template tags imported from a package', { timeout: 60_000 }, () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-pkg-'));
  });

  afterEach(() => {
    cg?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  async function index(): Promise<void> {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  }

  /** `name file:line` of each node an edge of `synthesizedBy` out of `parent` points at. */
  const targets = (parent: string, synthesizedBy: string): string[] =>
    cg.db.db
      .prepare(
        `SELECT t.name || ' ' || t.file_path || ':' || t.start_line AS r FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = ?
          ORDER BY r`
      )
      .all(parent, synthesizedBy)
      .map((row: any) => row.r);
  const renders = (parent: string) => targets(parent, 'jsx-render');

  it('renders nothing for a tag imported from a declared package, whether one or several project symbols share its name', async () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^18.0.0', antd: '^5.0.0' } }));
    write(
      'src/components/NotFound/styles.ts',
      `import styled from 'styled-components';
import { Link } from 'react-router-dom';

export const Button = styled(Link)\`
  color: inherit;
\`;
`
    );
    write('src/lib/uPlot/Tooltip.tsx', 'export function Tooltip() {\n  return <div />;\n}\n');
    write('src/lib/charts/Tooltip.tsx', 'export function Tooltip() {\n  return <div />;\n}\n');
    write(
      'src/pages/Settings.tsx',
      `import { Button, Tooltip } from 'antd';

export function Settings() {
  return (
    <Tooltip title="Save">
      <Button type="primary">Save</Button>
    </Tooltip>
  );
}
`
    );
    await index();
    expect(renders('Settings')).toEqual([]);
  });

  it('renders nothing for a default import from a package subpath, or a package import under another name', async () => {
    // mantis/berry: `import Typography from '@mui/material/Typography'` beside
    // the theme's own `Typography` override; a router link renamed on import.
    write(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.0.0', '@mui/material': '^5.0.0', 'react-router-dom': '^6.0.0' } })
    );
    write(
      'src/themes/overrides/Typography.js',
      'export default function Typography(theme) {\n  return { MuiTypography: { styleOverrides: {} } };\n}\n'
    );
    write('src/components/RouterLink.tsx', 'export function RouterLink() {\n  return <a />;\n}\n');
    write(
      'src/pages/Login.tsx',
      `import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

export function Login() {
  return (
    <Typography variant="h3">
      <RouterLink to="/register">Sign up</RouterLink>
    </Typography>
  );
}
`
    );
    await index();
    expect(renders('Login')).toEqual([]);
  });

  it('keeps a tag imported through an alias that reads like a package, or through a bare specifier no package.json declares', async () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^18.0.0', antd: '^5.0.0' } }));
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'components/*': ['src/components/*'] } } })
    );
    write('src/components/Modal/index.tsx', 'export default function Modal() {\n  return <div />;\n}\n');
    write('src/layouts/Header.tsx', 'export default function Header() {\n  return <header />;\n}\n');
    write(
      'src/container/Alerts.tsx',
      `import Modal from 'components/Modal';

export function Alerts() {
  return <Modal />;
}
`
    );
    write(
      'src/container/Confirm.tsx',
      `import { Modal } from 'antd';

export function Confirm() {
  return <Modal />;
}
`
    );
    // No alias maps `layouts/*` and no package.json declares `layouts`: the
    // resolver can't follow it, which does not make it a package.
    write(
      'src/App.tsx',
      `import Header from 'layouts/Header';

export function App() {
  return <Header />;
}
`
    );
    await index();
    expect(renders('Alerts')).toEqual(['Modal src/components/Modal/index.tsx:1']);
    expect(renders('Confirm')).toEqual([]);
    expect(renders('App')).toEqual(['Header src/layouts/Header.tsx:1']);
  });

  it('keeps a tag imported from a workspace package of the repository', async () => {
    write('package.json', JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
    write('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', version: '1.0.0' }));
    write('packages/ui/index.tsx', 'export function Button() {\n  return <button />;\n}\n');
    // The app depends on it by version, as a published package would be.
    write(
      'apps/web/package.json',
      JSON.stringify({ name: 'web', dependencies: { '@acme/ui': '^1.0.0', react: '^18.0.0' } })
    );
    write(
      'apps/web/src/Page.tsx',
      `import { Button } from '@acme/ui';

export function Page() {
  return <Button />;
}
`
    );
    await index();
    expect(renders('Page')).toEqual(['Button packages/ui/index.tsx:1']);
  });

  it('binds nothing in a Vue template for a tag or a composable imported from a package', async () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { vue: '^3.4.0', 'ant-design-vue': '^4.0.0', '@vueuse/core': '^10.0.0' } })
    );
    write(
      'src/components/ui/card/Card.vue',
      '<script setup lang="ts">\ndefineProps<{ title?: string }>();\n</script>\n\n<template>\n  <div class="card"><slot /></div>\n</template>\n'
    );
    write(
      'src/components/ui/button/Button.vue',
      '<script setup lang="ts">\ndefineProps<{ variant?: string }>();\n</script>\n\n<template>\n  <button><slot /></button>\n</template>\n'
    );
    write(
      'src/components/AppHeader.vue',
      '<script setup lang="ts">\nconst title = "App";\n</script>\n\n<template>\n  <header>{{ title }}</header>\n</template>\n'
    );
    write(
      'src/composables/useFullscreen.ts',
      'export function useFullscreen() {\n  function toggle() {\n    return document.fullscreenElement;\n  }\n  return { toggle };\n}\n'
    );
    // The handler is what the package's composable returns, not the project's
    // composable of the same name.
    write(
      'src/views/Dashboard.vue',
      `<script setup lang="ts">
import { Button, Card } from 'ant-design-vue';
import { useFullscreen } from '@vueuse/core';
import AppHeader from '../components/AppHeader.vue';

const { toggle: toggleFullscreen } = useFullscreen();
</script>

<template>
  <AppHeader />
  <Card title="Usage">
    <Button @click="toggleFullscreen">Full screen</Button>
  </Card>
</template>
`
    );
    await index();
    expect(renders('Dashboard')).toEqual(['AppHeader src/components/AppHeader.vue:1']);
    expect(targets('Dashboard', 'vue-handler')).toEqual([]);
  });
});
