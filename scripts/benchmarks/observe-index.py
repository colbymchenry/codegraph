#!/usr/bin/env python3
"""Observe one owned benchmark child on Linux, without a wall-clock timeout.

Usage: python3 observe-index.py NEW_RUN_DIR -- node measure-index.cjs ENGINE FIXTURE NEW_RUN_DIR native
The child retains the caller's environment/affinity. No host settings are changed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def read(path):
    try:
        return Path(path).read_text()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return None


def sample(pid):
    tasks = {}
    try:
        for task in Path(f'/proc/{pid}/task').iterdir():
            tasks[task.name] = {name: read(task / name) for name in ('stat', 'schedstat', 'wchan')}
    except (FileNotFoundError, ProcessLookupError):
        pass
    # Both common cgroup layouts; unavailable counters are recorded as null.
    paths = [
        '/proc/stat', '/proc/meminfo', '/proc/loadavg', '/proc/diskstats',
        '/proc/pressure/cpu', '/proc/pressure/io', '/proc/pressure/memory',
        '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/cpu.max',
        '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/cpu,cpuacct/cpu.stat',
        '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us',
        '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us',
        '/sys/fs/cgroup/memory/memory.usage_in_bytes',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ]
    return {'epochMs': time.time() * 1000,
            'process': {name: read(f'/proc/{pid}/{name}') for name in ('stat', 'status', 'io')},
            'threads': tasks, 'host': {path: read(path) for path in paths}}


def main():
    if sys.platform != 'linux' or len(sys.argv) < 4 or sys.argv[2] != '--':
        raise SystemExit(__doc__)
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)  # Preserve completed/interrupted runs.
    argv = sys.argv[3:]
    command = {'argv': argv, 'startedEpochMs': time.time() * 1000,
               'affinity': sorted(os.sched_getaffinity(0)), 'wallTimeout': None}
    command_path = out / 'command.json'
    command_path.write_text(json.dumps(command, indent=2))
    start = time.monotonic()
    with (out / 'console.log').open('w') as log, (out / 'resources.ndjson').open('w') as resources:
        # Inherit the foreground process group: Ctrl-C reaches this owned child
        # too. Never signal a PID discovered outside this invocation.
        child = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
        command['pid'] = child.pid
        command_path.write_text(json.dumps(command, indent=2))
        next_notice = start
        try:
            while child.poll() is None:
                resources.write(json.dumps(sample(child.pid)) + '\n')
                resources.flush()
                now = time.monotonic()
                if now >= next_notice:
                    print(f'Benchmark PID {child.pid}: {now-start:.0f}s elapsed; progress in {out}', flush=True)
                    next_notice = now + 30
                time.sleep(2)
        except BaseException:
            # Record an explicit interrupted outcome, even when no final result
            # exists. Give only our child a chance to stop, then reap it.
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            command['interrupted'] = True
            raise
        finally:
            command.update(exit=child.poll(), wallSec=time.monotonic()-start)
            command_path.write_text(json.dumps(command, indent=2))
    return child.returncode


if __name__ == '__main__':
    sys.exit(main())
