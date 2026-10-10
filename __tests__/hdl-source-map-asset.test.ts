import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
it('ships the Python exporter byte-for-byte with the compiled engine', () => {
  const root = path.resolve(__dirname, '..');
  expect(fs.readFileSync(path.join(root, 'dist/hdl/source-map-export.py')))
    .toEqual(fs.readFileSync(path.join(root, 'src/hdl/source-map-export.py')));
});
