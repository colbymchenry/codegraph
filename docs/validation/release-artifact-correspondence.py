"""Verify npm tarballs against the exact archive used by the executable proofs."""
import sys, pathlib, tarfile, hashlib, json, base64
root=pathlib.Path(sys.argv[1])
pkg=root/'.qa/release-package'
archive=root/'release/codegraph-linux-x64.tar.gz'
def sha(data):return hashlib.sha256(data).hexdigest()
with tarfile.open(archive) as original:
 hashes={m.name:sha(original.extractfile(m).read()) for m in original if m.isfile()}
records=[]
for command,kind in [(3,'main'),(4,'platform')]:
 meta=json.loads((pkg/f'command-{command}.log').read_text())[0]
 file=pkg/meta['filename'];data=file.read_bytes()
 assert hashlib.sha1(data).hexdigest()==meta['shasum']
 assert 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()==meta['integrity']
 verified=[]
 with tarfile.open(file) as t:
  actual={m.name[8:]:m for m in t if m.isfile()}
  assert set(actual)=={m['path'] for m in meta['files']}
  for rel,m in actual.items():
   expected=None
   if kind=='main' and rel.startswith('dist/') and rel.endswith('.d.ts'):
    expected='codegraph-linux-x64/lib/'+rel
   if kind=='platform' and rel!='package.json':expected='codegraph-linux-x64/'+rel
   if expected:
    assert sha(t.extractfile(m).read())==hashes[expected],rel
    verified.append(rel)
 records.append({'kind':kind,'tarball':str(file),'sha256':sha(data),'verifiedArchiveFiles':verified,'npmIntegrityVerified':True,'fileListVerified':True})
print(json.dumps({'archive':str(archive),'packages':records},indent=2))
