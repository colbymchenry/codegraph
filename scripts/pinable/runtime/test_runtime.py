import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import runtime as r


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_config(self):
        self.assertEqual(r.settings()["targets"], list(r.TARGETS))

    def test_node_watch_fix_cannot_be_downgraded(self):
        config = r.settings()
        config['nodeVersion'] = 'v24.16.0'
        with patch.object(r, 'read_json', return_value=config):
            with self.assertRaisesRegex(ValueError, 'short-path'): r.settings()

    def test_build_node_version_matches_bundle_pin(self):
        workflow = (r.ROOT / '.github/workflows/pinable-desktop-runtime.yml').read_text()
        self.assertIn("node-version: '" + r.settings()['nodeVersion'][1:] + "'", workflow)

    def test_all_binary_headers(self):
        for target in r.TARGETS:
            with self.subTest(target=target):
                data = bytearray(256)
                if target.startswith("linux"):
                    data[:6] = b'\x7fELF\x02\x01'
                    struct.pack_into('<H', data, 18, 62 if target.endswith('x64') else 183)
                elif target.startswith('darwin'):
                    data[:4] = b'\xcf\xfa\xed\xfe'
                    struct.pack_into('<I', data, 4, 0x01000007 if target.endswith('x64') else 0x0100000C)
                else:
                    data[:2] = b'MZ'
                    struct.pack_into('<I', data, 60, 128)
                    data[128:132] = b'PE\0\0'
                    struct.pack_into('<H', data, 132, 0x8664 if target.endswith('x64') else 0xAA64)
                file = self.root / target
                file.write_bytes(data)
                self.assertEqual(r.binary_target(file), target)

    def test_invalid_binary(self):
        file = self.root / 'bad'
        for data in (b'', bytes(256), b'MZ'+bytes(254), b'\x7fELF\x01\x01'+bytes(250)):
            file.write_bytes(data)
            with self.assertRaises(ValueError): r.binary_target(file)

    def test_member_paths(self):
        r.checked_member('codegraph-linux-x64/lib/dist/index.js')
        for name in ('', '/etc/passwd', '../escape', 'safe/../../escape', 'C:/escape', 'safe\\escape'):
            with self.subTest(name=name), self.assertRaises(ValueError): r.checked_member(name)

    def test_zip_slip(self):
        file = self.root / 'bad.zip'
        with zipfile.ZipFile(file, 'w') as z: z.writestr('../escape', 'bad')
        with self.assertRaises(ValueError): r.unpack(file, self.root / 'dest')
        self.assertFalse((self.root / 'escape').exists())

    def test_tar_symlink_escape(self):
        file = self.root / 'bad.tar.gz'
        with tarfile.open(file, 'w:gz') as tf:
            link = tarfile.TarInfo('bundle/link')
            link.type = tarfile.SYMTYPE
            link.linkname = '../../escape'
            tf.addfile(link)
        with self.assertRaises(tarfile.FilterError): r.unpack(file, self.root / 'dest')

    def test_round_trip_and_no_overwrite(self):
        source = self.root / 'bundle'
        source.mkdir()
        (source / '含 空格').write_text('hello', encoding='utf-8')
        for suffix in ('.tar.gz', '.zip'):
            output = self.root / ('archive' + suffix)
            r.archive_tree(source, output, 1789888599)
            dest = self.root / suffix
            r.unpack(output, dest)
            self.assertEqual((dest / 'bundle/含 空格').read_text(encoding='utf-8'), 'hello')
            with self.assertRaises(ValueError): r.archive_tree(source, output, 1789888599)

    def test_node_checksum(self):
        digest = 'a'*64
        self.assertEqual(r.expected_digest(digest+'  node.zip\n', 'node.zip'), digest)
        for text in ('', 'bad node.zip', (digest+' node.zip\n')*2, digest+' different.zip'):
            with self.assertRaises(ValueError): r.expected_digest(text, 'node.zip')

    def test_target_names(self):
        self.assertEqual(r.node_archive_name('win32-arm64', 'v24.21.0'), 'node-v24.21.0-win-arm64.zip')
        self.assertEqual(r.launcher_name('linux-x64'), 'codegraph_linux_amd64')
        with self.assertRaises(ValueError): r.node_archive_name('unknown', 'v24.21.0')

    def records(self):
        source = {'repository': 'PinableAgents/codegraph', 'revision': 'a'*40, 'version': '1.6.0',
                  'nodeVersion': r.settings()['nodeVersion'], 'releaseTag': 'pinable-runtime-v1.6.0-'+'a'*12}
        for target, (goos, goarch) in r.TARGETS.items():
            archive = self.root / ('codegraph-'+target+('.zip' if goos == 'windows' else '.tar.gz'))
            launcher = self.root / r.launcher_name(target)
            archive.write_bytes(b'fixture-archive')
            launcher.write_bytes(b'fixture-launcher')
            record = {'schemaVersion':1, 'component':'codegraph', 'source':source, 'target':target, 'goos':goos, 'goarch':goarch,
                      'nativeKernel':{'required':True}, 'archive':r.describe_file(archive), 'launcher':r.describe_file(launcher)}
            r.write_json(self.root / f'codegraph-{target}.json', record)
            r.write_json(self.root / f'codegraph-{target}.smoke.json', {'ok':True, 'source':source, 'target':target})

    def test_manifest_complete(self):
        self.records()
        result = r.aggregate(self.root)
        self.assertEqual(len(result['assets']), 6)
        sums = (self.root / 'SHA256SUMS').read_text()
        self.assertIn(r.sha256(self.root / 'codegraph-runtime-manifest.json'), sums)
        self.assertEqual(len(sums.splitlines()), 25)

    def test_manifest_rejects_tampering(self):
        self.records()
        (self.root / r.launcher_name('linux-x64')).write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, 'hash/size'): r.aggregate(self.root)

    def test_manifest_rejects_missing_target(self):
        self.records()
        (self.root / 'codegraph-win32-arm64.smoke.json').unlink()
        with self.assertRaises(FileNotFoundError): r.aggregate(self.root)

    def test_manifest_rejects_unknown_assets(self):
        self.records()
        (self.root / 'secret.txt').write_text('never upload this')
        with self.assertRaisesRegex(ValueError, 'unexpected artifact'): r.aggregate(self.root)

    def test_manifest_rejects_mixed_revisions(self):
        self.records()
        file = self.root / 'codegraph-linux-x64.json'
        data = r.read_json(file); data['source']['revision'] = 'b'*40; r.write_json(file, data)
        with self.assertRaisesRegex(ValueError, 'mixed source'): r.aggregate(self.root)

    def test_manifest_rejects_failed_smoke(self):
        self.records()
        file = self.root / 'codegraph-linux-x64.smoke.json'
        data = r.read_json(file); data['ok'] = False; r.write_json(file, data)
        with self.assertRaisesRegex(ValueError, 'smoke test'): r.aggregate(self.root)

    def test_manifest_rejects_malicious_filename(self):
        self.records()
        file = self.root / 'codegraph-linux-x64.json'
        data = r.read_json(file); data['archive']['file'] = '../escape'; r.write_json(file, data)
        with self.assertRaisesRegex(ValueError, 'filename'): r.aggregate(self.root)

    def test_download_origin(self):
        with self.assertRaises(ValueError): r.download('https://untrusted.example/node.zip', self.root / 'node.zip')

    def test_application_asset_guard(self):
        with self.assertRaisesRegex(ValueError, 'missing application'): r.validate_app(self.root)


if __name__ == '__main__':
    unittest.main()
