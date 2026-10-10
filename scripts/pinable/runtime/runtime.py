#!/usr/bin/env python3
"""Pinable runtime producer. Python 3.12+, standard library only.

The desktop's component-lock.json remains consumer-owned. The manifest produced
here describes verified artifacts; it is NOT a replacement consumer lock file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / "release/pinable-work"
OUT = ROOT / "release/pinable-runtime"
TARGETS = {
    "darwin-arm64": ("darwin", "arm64"), "darwin-x64": ("darwin", "amd64"),
    "linux-x64": ("linux", "amd64"), "linux-arm64": ("linux", "arm64"),
    "win32-x64": ("windows", "amd64"), "win32-arm64": ("windows", "arm64"),
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def settings() -> dict:
    config = read_json(ROOT / ".pinable/runtime.json")
    require(config.get("schemaVersion") == 1, "unsupported runtime configuration")
    require(re.fullmatch(r"v24\.\d+\.\d+", config["nodeVersion"]) is not None,
            "nodeVersion must be an explicit supported Node 24 version")
    require(tuple(map(int, config["nodeVersion"][1:].split("."))) >= (24, 21, 0),
            "Node >=24.21.0 is required for the Windows short-path fs.watch fix")
    require(config["targets"] == list(TARGETS), "target matrix must contain all six targets in canonical order")
    require(config["releasePrefix"] == "pinable-runtime-v", "unexpected release namespace")
    return config


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def source_info() -> dict:
    config = settings()
    require(not git("diff", "--name-only", "HEAD"), "tracked source changes must be committed before packaging")
    revision = git("rev-parse", "HEAD")
    version = read_json(ROOT / "package.json")["version"]
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version) is not None, "invalid package version")
    return {"repository": "PinableAgents/codegraph", "revision": revision,
            "tree": git("rev-parse", "HEAD^{tree}"), "version": version,
            "nodeVersion": config["nodeVersion"], "commitTime": int(git("show", "-s", "--format=%ct", "HEAD")),
            "packageLockSha256": hashlib.sha256(subprocess.check_output(["git", "show", "HEAD:package-lock.json"], cwd=ROOT)).hexdigest(),
            "releaseTag": config["releasePrefix"] + version + "-" + revision[:12]}


def binary_target(path: Path) -> str:
    """Inspect the file header, not its filename. Reject fat or unknown binaries."""
    with path.open("rb") as stream:
        data = stream.read(4096)
        require(len(data) >= 64, f"truncated executable: {path}")
        if data[:4] == b"\x7fELF":
            require(data[4:6] == b"\x02\x01", "expected little-endian ELF64")
            machine = struct.unpack_from("<H", data, 18)[0]
            result = {62: "linux-x64", 183: "linux-arm64"}.get(machine)
        elif data[:4] == b"\xcf\xfa\xed\xfe":
            cpu = struct.unpack_from("<I", data, 4)[0]
            result = {0x01000007: "darwin-x64", 0x0100000C: "darwin-arm64"}.get(cpu)
        elif data[:2] == b"MZ":
            offset = struct.unpack_from("<I", data, 60)[0]
            require(64 <= offset < 16 * 1024 * 1024, "invalid PE header offset")
            stream.seek(offset)
            pe = stream.read(6)
            require(len(pe) == 6 and pe[:4] == b"PE\0\0", "invalid PE signature")
            result = {0x8664: "win32-x64", 0xAA64: "win32-arm64"}.get(struct.unpack_from("<H", pe, 4)[0])
        else:
            result = None
    require(result is not None, f"unsupported binary architecture: {path}")
    return result


def checked_member(name: str) -> None:
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and ".." not in path.parts
            and "\\" not in name and ":" not in name, f"unsafe archive member: {name!r}")


def unpack(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                checked_member(info.filename)
                require(not stat.S_ISLNK(info.external_attr >> 16), "ZIP symlinks are not accepted")
            zf.extractall(destination)
            if os.name != "nt":
                for info in zf.infolist():
                    mode = (info.external_attr >> 16) & 0o777
                    if mode:
                        (destination / info.filename).chmod(mode)
    else:
        with tarfile.open(archive, "r:gz") as tf:
            for info in tf.getmembers():
                checked_member(info.name)
                require(info.isfile() or info.isdir() or info.issym() or info.islnk(), "special archive file rejected")
            tf.extractall(destination, filter="data")


def archive_tree(root: Path, output: Path, epoch: int) -> None:
    """Normalize tar ownership/time; ZIPs dereference internal npm bin links."""
    output.parent.mkdir(parents=True, exist_ok=True)
    require(not output.exists(), f"refusing to overwrite artifact: {output}")
    members = [root, *sorted(root.rglob("*"))]
    for item in members:
        if item.is_symlink():
            require(item.resolve().is_relative_to(root.resolve()), f"out-of-tree symlink: {item}")
    if output.suffix == ".zip":
        stamp = time.gmtime(max(epoch, 315532800))[:6]
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for item in members:
                name = item.relative_to(root.parent).as_posix() + ("/" if item.is_dir() else "")
                info = zipfile.ZipInfo(name, stamp)
                info.create_system = 3
                info.external_attr = ((0o40755 if item.is_dir() else (0o100755 if item.stat().st_mode & 0o111 else 0o100644)) << 16)
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, b"" if item.is_dir() else item.read_bytes())
    else:
        def normalized(info: tarfile.TarInfo) -> tarfile.TarInfo:
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = epoch
            return info
        with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as tf:
            tf.add(root, arcname=root.name, filter=normalized)


def download(url: str, output: Path) -> None:
    require(url.startswith("https://nodejs.org/dist/"), "only the official Node distribution origin is allowed")
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response, output.open("wb") as stream:
                require(response.geturl().startswith("https://nodejs.org/"), "unexpected Node download redirect")
                shutil.copyfileobj(response, stream, length=1024 * 1024)
            return
        except (OSError, ValueError) as error:
            last = error
            output.unlink(missing_ok=True)
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed: {url}: {last}")


def node_archive_name(target: str, version: str) -> str:
    require(target in TARGETS, "unknown target")
    platform = target.replace("win32-", "win-")
    return f"node-{version}-{platform}" + (".zip" if target.startswith("win32-") else ".tar.gz")


def expected_digest(text: str, filename: str) -> str:
    matches = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip("*") == filename:
            require(re.fullmatch(r"[0-9a-f]{64}", fields[0]) is not None, "malformed official checksum")
            matches.append(fields[0])
    require(len(matches) == 1, "official Node checksum missing or duplicated")
    return matches[0]


def stage_app() -> None:
    info = source_info()
    stage = WORK / "app"
    require(not stage.exists(), f"staging directory already exists: {stage}")
    (stage / "lib").mkdir(parents=True)
    shutil.copytree(ROOT / "dist", stage / "lib/dist")
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(ROOT / name, stage / "lib" / name)
    shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
    write_json(stage / "build.json", info)


def validate_app(stage: Path) -> None:
    for name in ("lib/dist/bin/codegraph.js", "lib/dist/db/schema.sql", "lib/dist/viewer/index.html", "lib/package.json"):
        require((stage / name).is_file(), f"missing application asset: {name}")
    require(any((stage / "lib/dist/extraction/wasm").glob("*.wasm")), "vendored grammars missing")
    pkg = read_json(stage / "lib/package.json")
    for name in pkg["dependencies"]:
        require((stage / "lib/node_modules" / name / "package.json").is_file(), f"production dependency missing: {name}")


def pack_app() -> None:
    stage = WORK / "app"
    validate_app(stage)
    (stage / "lib/package-lock.json").unlink(missing_ok=True)
    archive_tree(stage, ROOT / "release/pinable-app.tar.gz", read_json(stage / "build.json")["commitTime"])


def launcher_name(target: str) -> str:
    goos, goarch = TARGETS[target]
    return f"codegraph_{goos}_{goarch}" + (".exe" if goos == "windows" else "")


def describe_file(path: Path) -> dict:
    require(path.is_file() and path.stat().st_size > 0, f"missing/empty asset: {path}")
    return {"file": path.name, "sha256": sha256(path), "size": path.stat().st_size}


def build_bundle(target: str, kernel: Path, launcher: Path) -> None:
    for binary in (kernel, launcher):
        require(binary_target(binary) == target, f"wrong target for {binary}")
    WORK.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bundle-", dir=WORK) as temp:
        temp = Path(temp)
        unpack(ROOT / "release/pinable-app.tar.gz", temp)
        stage = temp / ("codegraph-" + target)
        (temp / "app").rename(stage)
        info = read_json(stage / "build.json")
        require(info == source_info(), "application artifact and checked-out source do not match")
        validate_app(stage)
        node_name = node_archive_name(target, info["nodeVersion"])
        sums = temp / "SHASUMS256.txt"
        download(f'https://nodejs.org/dist/{info["nodeVersion"]}/SHASUMS256.txt', sums)
        node_archive = temp / node_name
        digest = expected_digest(sums.read_text(encoding="utf-8"), node_name)
        download(f'https://nodejs.org/dist/{info["nodeVersion"]}/{node_name}', node_archive)
        require(sha256(node_archive) == digest, "official Node archive checksum mismatch")
        node_dir = temp / "node-dist"
        unpack(node_archive, node_dir)
        dist_name = node_name.removesuffix(".tar.gz").removesuffix(".zip")
        windows = target.startswith("win32-")
        node = node_dir / dist_name / ("node.exe" if windows else "bin/node")
        require(binary_target(node) == target, "Node architecture mismatch")
        shutil.copy2(node, stage / ("node.exe" if windows else "node"))
        (stage / "LICENSES").mkdir()
        shutil.copy2(node_dir / dist_name / "LICENSE", stage / "LICENSES/Node-LICENSE")
        (stage / "lib/kernel").mkdir(exist_ok=True)
        shutil.copy2(kernel, stage / "lib/kernel/codegraph-kernel.node")
        (stage / "bin").mkdir(exist_ok=True)
        entry = "bin/codegraph.exe" if windows else "bin/codegraph"
        shutil.copy2(launcher, stage / entry)
        (stage / entry).chmod(0o755)
        (stage / ("node.exe" if windows else "node")).chmod(0o755)
        if windows:
            (stage / "bin/codegraph.cmd").write_bytes(b'@"%~dp0codegraph.exe" %*\r\n')
        metadata = {"schemaVersion": 1, "component": "codegraph", "source": info,
                    "target": target, "goos": TARGETS[target][0], "goarch": TARGETS[target][1],
                    "entrypoint": entry, "nodeExecutable": "node.exe" if windows else "node",
                    "nodeArgs": ["--liftoff-only", "--disable-warning=ExperimentalWarning", "lib/dist/bin/codegraph.js"],
                    "nativeKernel": {"required": True, "sha256": sha256(kernel)},
                    "nodeDistribution": {"file": node_name, "sha256": digest},
                    "buildTools": {"go": subprocess.check_output(["go", "version"], text=True).strip(),
                                   "rust": subprocess.check_output(["rustc", "--version"], text=True).strip()},
                    "signing": "no Pinable Developer ID, notarization or Authenticode signature applied"}
        (stage / "build.json").unlink()
        write_json(stage / "runtime.json", metadata)
        archive = OUT / ("codegraph-" + target + (".zip" if windows else ".tar.gz"))
        archive_tree(stage, archive, info["commitTime"])
        standalone = OUT / launcher_name(target)
        require(not standalone.exists(), f"refusing to overwrite launcher: {standalone}")
        shutil.copy2(stage / entry, standalone)
        standalone.chmod(0o755)
        metadata["archive"] = describe_file(archive)
        metadata["launcher"] = describe_file(standalone)
        metadata["archiveRoot"] = stage.name
        write_json(OUT / f"codegraph-{target}.json", metadata)


def verify_bundle(target: str) -> None:
    meta = read_json(OUT / f"codegraph-{target}.json")
    archive = OUT / meta["archive"]["file"]
    require(describe_file(archive) == meta["archive"], "archive changed before smoke test")
    with tempfile.TemporaryDirectory(prefix="Pinable runtime 空格 ") as temp:
        temp = Path(temp)
        unpack(archive, temp)
        bundle = temp / meta["archiveRoot"]
        node = bundle / meta["nodeExecutable"]
        env = dict(os.environ, CODEGRAPH_TELEMETRY="0", DO_NOT_TRACK="1", CODEGRAPH_NO_DAEMON="1")
        for key in ("NODE_OPTIONS", "NODE_PATH", "CODEGRAPH_KERNEL", "CODEGRAPH_KERNEL_PATH", "CODEGRAPH_DIR"):
            env.pop(key, None)
        subprocess.run([str(node), "--liftoff-only", "--disable-warning=ExperimentalWarning",
                        str(ROOT / "scripts/pinable/runtime/smoke.cjs"), str(bundle)],
                       env=env, check=True, timeout=180)
        # Also exercise the separately distributed launcher from the bundle root.
        standalone = bundle / launcher_name(target)
        shutil.copy2(OUT / standalone.name, standalone)
        standalone.chmod(0o755)
        result = subprocess.run([str(standalone), "--version"], cwd=temp, env=env,
                                capture_output=True, text=True, check=True, timeout=30)
        require(meta["source"]["version"] in result.stdout, "standalone launcher version mismatch")
    write_json(OUT / f"codegraph-{target}.smoke.json", {
        "schemaVersion": 1, "ok": True, "target": target, "source": meta["source"],
        "checks": ["binary-architecture", "bundled-node", "sqlite-fts5", "kernel-contract-and-extraction",
                   "index-and-sync", "native-launcher-version", "standalone-launcher", "mcp-initialize-and-tools-list",
                   "unicode-and-spaces-path", "native-file-watch-events", "viewer-and-wasm-assets"]})


def aggregate(directory: Path) -> dict:
    assets = []
    source = None
    expected = set()
    for target in TARGETS:
        record_name, smoke_name = f"codegraph-{target}.json", f"codegraph-{target}.smoke.json"
        meta, smoke = read_json(directory / record_name), read_json(directory / smoke_name)
        require(meta.get("schemaVersion") == 1 and meta.get("component") == "codegraph", "invalid runtime record")
        require(meta["target"] == target and (meta["goos"], meta["goarch"]) == TARGETS[target], "target metadata mismatch")
        source = source or meta["source"]
        require(meta["source"] == source and smoke["source"] == source, "mixed source revisions or versions")
        require(smoke.get("ok") is True and smoke.get("target") == target, "native runtime smoke test missing/failed")
        require(meta["nativeKernel"]["required"] is True, "native kernel cannot be optional")
        for kind, expected_name in (("archive", "codegraph-" + target + (".zip" if target.startswith("win32-") else ".tar.gz")),
                                    ("launcher", launcher_name(target))):
            require(meta[kind]["file"] == expected_name, "unsafe or unexpected artifact filename")
            require(describe_file(directory / expected_name) == meta[kind], "artifact hash/size mismatch")
            expected.add(expected_name)
        expected.update((record_name, smoke_name))
        assets.append(meta)
    require(set(p.name for p in directory.iterdir()) == expected, "missing or unexpected artifact files")
    require(re.fullmatch(r"[0-9a-f]{40}", source["revision"]) is not None, "invalid source revision")
    require(source["repository"] == "PinableAgents/codegraph", "unexpected source repository")
    require(source["nodeVersion"] == settings()["nodeVersion"], "Node version drift")
    require(source["releaseTag"] == "pinable-runtime-v" + source["version"] + "-" + source["revision"][:12], "invalid release tag")
    manifest = {"schemaVersion": 1, "component": "codegraph", "source": source, "assets": assets,
                "consumerLock": "Maintainer-reviewed input for pinable-desktop/internal/assets/codegraph/component-lock.json; not a replacement schema"}
    write_json(directory / "codegraph-runtime-manifest.json", manifest)
    expected.add("codegraph-runtime-manifest.json")
    (directory / "SHA256SUMS").write_text("".join(f"{sha256(directory / name)}  {name}\n" for name in sorted(expected)), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["stage-app", "pack-app", "bundle", "verify", "manifest"])
    parser.add_argument("--target", choices=list(TARGETS))
    parser.add_argument("--kernel", type=Path)
    parser.add_argument("--launcher", type=Path)
    parser.add_argument("--input", type=Path, default=OUT)
    args = parser.parse_args()
    if args.command == "stage-app": stage_app()
    elif args.command == "pack-app": pack_app()
    elif args.command == "bundle":
        require(args.target and args.kernel and args.launcher, "bundle needs target, kernel and launcher")
        build_bundle(args.target, args.kernel.resolve(), args.launcher.resolve())
    elif args.command == "verify":
        require(args.target, "verify needs target")
        verify_bundle(args.target)
    else:
        manifest = aggregate(args.input)
        print(json.dumps(manifest["source"]))


if __name__ == "__main__":
    main()
