import { expect, it } from 'vitest';
import { CoreExtractionReuse } from '../src/extraction/core-reuse';
import type { ExtractionResult } from '../src/types';
const result = (): ExtractionResult => ({ nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 });
it('invalidates changed bytes/languages/paths and never caches failures', () => {
 const c = new CoreExtractionReuse();const r=result();c.set('a.php','a','php',r);
 expect(c.get('a.php','a','php')).toBe(r);expect(c.get('b.php','a','php')).toBeUndefined();
 expect(c.get('a.php','b','php')).toBeUndefined();expect(c.get('a.php','a','php')).toBeUndefined();
 c.set('a.php','a','php',r);expect(c.get('a.php','a','python')).toBeUndefined();
 c.set('a.php','a','php',{...r,errors:[{message:'failed',severity:'error'}]});expect(c.get('a.php','a','php')).toBeUndefined();
});
it('bounds retained data, does not evict the whole working set during a large scan and prunes deleted paths', () => {
 const r=result(),size=Buffer.byteLength(JSON.stringify(r))*2,c=new CoreExtractionReuse(size);
 c.set('a','a','php',r);c.set('b','b','php',r);expect(c.stats().bytes).toBe(size);
 expect(c.get('a','a','php')).toBe(r);expect(c.get('b','b','php')).toBeUndefined();
 c.retain(['b']);expect(c.stats().entries).toBe(0);c.set('b','b','php',r);c.clear();expect(c.stats().bytes).toBe(0);
});
