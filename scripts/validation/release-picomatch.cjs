// Compile advisory shapes, but only match bounded 16-character inputs. No load/DoS test.
const path=require('node:path'),assert=require('node:assert/strict');
const base=path.resolve(process.argv[2]||'node_modules/picomatch');
const picomatch=require(base), version=require(path.join(base,'package.json')).version;
const rows=['[[:constructor:]]','+(a|aa)','+(+(a))'].map(pattern=>{
 const regex=picomatch.makeRe(pattern);const start=performance.now();const result=regex.test('a'.repeat(16)+'b');
 return {pattern,regex:regex.source,result,ms:performance.now()-start};
});
console.log(JSON.stringify({base,version,node:process.version,rows}));
assert(!rows[0].regex.includes('function Object'),'inherited constructor entered regex');
assert(!rows[1].regex.includes('(?:a|aa)+'),'overlapping repeated alternative entered regex');
assert(picomatch('crates/*')('crates/example'));
assert(!picomatch('crates/*')('unrelated/example'));
