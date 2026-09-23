import sys, subprocess, pathlib, json, datetime, hashlib
root=pathlib.Path(__file__).resolve().parents[2]
expected=sys.argv[1]
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==expected
out=root/'.qa/release-full';out.mkdir(parents=True,exist_ok=True)
files=sorted(str(p.relative_to(root)) for p in (root/'__tests__').rglob('*.test.ts'))
manifest={'revision':expected,'files':files,'commands':[]}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for shard in range(1,5):
 name=f'release-final-shard-{shard}'
 if (root/'.qa/recovery'/f'{name}.json').exists():
  receipt=json.loads((root/'.qa/recovery'/f'{name}.json').read_text())
  assert receipt['revision']==expected and receipt['exit_code']==0
  continue
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==expected
 command=['node','node_modules/vitest/vitest.mjs','run',f'--shard={shard}/4','--maxWorkers=1','--minWorkers=1','--reporter=default','--reporter=json',f'--outputFile.json=.qa/release-full/shard-{shard}.json']
 result=subprocess.run(['python3','docs/validation/release-command.py',name,*command],cwd=root)
 if result.returncode:sys.exit(result.returncode)
seen=[];counts={'passed':0,'failed':0,'pending':0}
for shard in range(1,5):
 report=json.loads((out/f'shard-{shard}.json').read_text())
 for suite in report['testResults']:
  seen.append(str(pathlib.Path(suite['name']).relative_to(root)))
 for k in counts:counts[k]+=report[{'passed':'numPassedTests','failed':'numFailedTests','pending':'numPendingTests'}[k]]
assert len(seen)==len(set(seen)) and set(seen)==set(files),(len(seen),len(files),set(files)-set(seen))
summary={'revision':expected,'counts':counts,'testFiles':len(files),'exactlyOnce':True,'finished':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
