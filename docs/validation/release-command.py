import subprocess, pathlib, sys, json, datetime, time, re
name, *command = sys.argv[1:]
out = pathlib.Path('.qa/recovery')
out.mkdir(parents=True, exist_ok=True)
start = time.monotonic()
record = {'command': command, 'cwd': str(pathlib.Path.cwd()), 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    record['revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    record['working_tree'] = subprocess.check_output(['git', 'status', '--porcelain=v1'], text=True)
except subprocess.CalledProcessError:
    pass
(out / (name + '.started.json')).write_text(json.dumps(record, indent=2)+'\n')
with (out / (name + '.log')).open('w') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
record.update(exit_code=result.returncode, seconds=round(time.monotonic()-start, 3), finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
log_text = re.sub(r'\x1b\[[0-9;]*m', '', (out / (name + '.log')).read_text(errors='replace'))
record['summary'] = [line.strip() for line in log_text.splitlines() if re.match(r'^\s*(Test Files|Tests|Duration)\s', line)]
(out / (name + '.json')).write_text(json.dumps(record, indent=2)+'\n')
if name.startswith('final-shard-'):
    with pathlib.Path('../RECOVERY-CHECKPOINT.md').open('a') as checkpoint:
        checkpoint.write(f"\n- Completed `{name}` at {record['finished_at']}: revision `{record.get('revision')}`, exit {result.returncode}, {record['seconds']} s. Command: `{' '.join(command)}`. Summary: {'; '.join(record['summary'])}. Receipt/log: `codegraph/.qa/recovery/{name}.json` / `.log`.\n")
print(json.dumps(record), flush=True)
if result.returncode:
    print('\n'.join((out / (name + '.log')).read_text(errors='replace').splitlines()[-60:]), flush=True)
sys.exit(result.returncode)
