#!/usr/bin/env python3
"""Реальные bounded tests экспортера; запускать Python окружения pyslang 11.0.0.

Не устанавливает зависимости. Создаёт только изолированные временные fixtures.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'src/hdl/source-map-export.py'
WORK_ROOT = None


class SourceMapExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='hdl-source-map-test-', dir=WORK_ROOT)
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, name, text, crlf=False, bom=False):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((b'\xef\xbb\xbf' if bom else b'') + text.replace('\n', '\r\n' if crlf else '\n').encode('utf8'))

    def compile(self, source, extra=(), success=True):
        out = self.root / 'facts.json'
        result = subprocess.run([sys.executable, '-I', str(HELPER), '--ast-json', str(out),
            '--ast-json-source-info', '--ast-json-detailed-types', '--std=1800-2023',
            '--threads=1', '--error-limit=20', '--top', 'top', *extra, '--', source],
            cwd=self.root, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        if not success:
            self.assertFalse(out.exists(), 'failed frontend must not emit semantic facts')
            return result
        payload = json.loads(out.read_text())
        self.assertEqual(payload['codegraphSemanticVersion'], 1)
        return payload['facts']

    def assertPoint(self, point):
        file = (self.root / point['file']).resolve()
        self.assertTrue(file.is_relative_to(self.root))
        data = file.read_bytes()
        offset = point['byteOffset']
        self.assertGreaterEqual(offset, 0)
        self.assertLessEqual(offset, len(data))
        self.assertEqual(point['line'], data.count(b'\n', 0, offset) + 1)
        self.assertEqual(point['column'], offset - data.rfind(b'\n', 0, offset))

    def test_nested_arguments_include_utf8_crlf_and_four_state_value(self):
        self.write('defs/inner.svh', '`define LEAF(name,value) localparam int name=value;\n', crlf=True)
        self.write('defs/outer.svh', '`include "inner.svh"\n`define WRAP(name,value) `LEAF(name,value)\n', crlf=True)
        source = "top space'quote.sv"
        self.write(source, '`include "defs/outer.svh"\nmodule top #(parameter int N=1);\n  /* 😀 */ `WRAP(P, 7)\n  localparam logic [3:0] XZ=4\'b10xz;\nendmodule\n', crlf=True, bom=True)
        facts = self.compile(source, ['-G', "N=32'd4"])
        byname = {fact['name']: fact for fact in facts}
        self.assertEqual(byname['N']['value'], '4')
        self.assertEqual(byname['P']['value'], '7')
        self.assertEqual(byname['XZ']['value'].lower(), "4'b10xz")
        p = byname['P']
        self.assertEqual(p['sourceOrigin'], 'macro')
        self.assertFalse(p['macroExpansionComplete'])
        frames = p['macroExpansion']
        self.assertEqual({frame['name'] for frame in frames}, {'LEAF', 'WRAP'})
        self.assertTrue(any(frame['name'] == 'LEAF' and frame['argument'] for frame in frames))
        self.assertTrue(any(frame['name'] == 'WRAP' and frame['argument'] for frame in frames))
        data = (self.root / source).read_bytes()
        offset = data.index(b'P, 7')
        self.assertEqual(p['source'], {'file': source, 'line': 3, 'column': offset - data.rfind(b'\n', 0, offset)})
        for frame in frames:
            if 'spelling' in frame:
                self.assertPoint(frame['spelling'])
            if 'invocation' in frame:
                self.assertPoint(frame['invocation']['start'])
                self.assertPoint(frame['invocation']['end'])
        self.assertTrue(any(frame.get('spelling', {}).get('file') == 'defs/inner.svh' for frame in frames))

    def test_token_concat_is_prefix_point_not_a_generated_name_range(self):
        self.write('defs.svh', '`define CAT(a,b) a``b\n`define DECL(p) localparam int `CAT(p,_param)=3;\n')
        self.write('top.sv', '`include "defs.svh"\nmodule top;\n  `DECL(bus)\nendmodule\n')
        fact = next(f for f in self.compile('top.sv') if f['name'] == 'bus_param')
        self.assertEqual(fact['value'], '3')
        self.assertEqual(fact['sourceOrigin'], 'macro')
        self.assertNotIn('nameRange', fact)
        self.assertFalse(fact['macroExpansionComplete'])
        data = (self.root / 'top.sv').read_bytes()
        prefix = [frame['spelling'] for frame in fact['macroExpansion']
                  if frame.get('spelling', {}).get('file') == 'top.sv'
                  and data[frame['spelling']['byteOffset']:].startswith(b'bus')]
        self.assertTrue(prefix)
        self.assertFalse(data[prefix[0]['byteOffset']:].startswith(b'bus_param'))

    def test_zero_empty_string_and_physical_line_directive_coordinates(self):
        self.write('top.sv', '`line 700 "virtual.sv" 0\nmodule top; parameter int ZERO=0; parameter string EMPTY=""; endmodule\n')
        facts = {f['name']: f for f in self.compile('top.sv')}
        self.assertEqual(facts['ZERO']['value'], '0')
        self.assertEqual(facts['EMPTY']['value'], '""')
        for fact in facts.values():
            self.assertEqual(fact['sourceOrigin'], 'direct')
            self.assertEqual(fact['source']['file'], 'top.sv')
            self.assertEqual(fact['source']['line'], 2)

    def test_type_alias_facts_have_integral_width_and_declaration_origin(self):
        self.write('types.svh', '`define DECLTYPE(name) typedef logic [7:0] name;\n')
        self.write('top.sv', '`include "types.svh"\nmodule top;\n `DECLTYPE(byte_t)\n typedef logic [3:0] nibble_t;\nendmodule\n')
        facts = {fact['name']: fact for fact in self.compile('top.sv')}
        self.assertEqual(facts['byte_t']['kind'], 'type')
        self.assertEqual(facts['byte_t']['width'], 8)
        self.assertEqual(facts['byte_t']['sourceOrigin'], 'macro')
        self.assertTrue(facts['byte_t']['macroExpansion'])
        self.assertEqual(facts['nibble_t']['kind'], 'type')
        self.assertEqual(facts['nibble_t']['width'], 4)
        self.assertEqual(facts['nibble_t']['sourceOrigin'], 'direct')
        self.assertNotIn('direction', facts['byte_t'])

    def test_rejects_semantic_errors_instead_of_exporting_partial_ast(self):
        self.write('top.sv', 'module top; missing_dependency u(); endmodule\n')
        result = self.compile('top.sv', success=False)
        self.assertIn('unknown module', result.stderr)

    def test_shared_bodies_and_generate_indices_have_instance_specific_paths(self):
        self.write('top.sv', 'module leaf #(parameter int P=2); endmodule\nmodule top; leaf u1(); leaf u2(); for(genvar i=2;i<4;i++) begin : lanes leaf u(); end endmodule\n')
        facts = self.compile('top.sv')
        paths = {f['instancePath'] for f in facts if f['name'] == 'P'}
        self.assertEqual(paths, {'top.u1', 'top.u2', 'top.lanes[2].u', 'top.lanes[3].u'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, default=HELPER)
    parser.add_argument('--work-root', type=Path)
    args = parser.parse_args()
    HELPER = args.helper.resolve()
    WORK_ROOT = args.work_root
    unittest.main(argv=[sys.argv[0], '-v'])
