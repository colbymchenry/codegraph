// How long the engine takes to index one large file in everything the README lists that
// kernel-languages.mjs does not cover: the languages the native kernel does not read, each
// framework's and router's routes file, and each cross-language bridge. See
// docs/design/large-file-performance.md.
//
//   node scripts/benchmarks/large-files/other-languages.mjs <built engine: dist> <megabytes> [case,case… or a word cases start with]
//
// One line a case: seconds, the megabytes of the whole project, the large file's symbols, and
// the project's routes and edges. Read the counts as well as the time: a case with no symbols,
// routes or edges gave the engine nothing to link, so it measured nothing. A case with a file
// over the engine's size limit is marked NOT MEASURED, because the engine leaves that file out.
// Set CODEGRAPH_KERNEL=0 to time the wasm extractor. BENCH_WRITE=<folder> writes the projects
// out instead of timing them (for compare-graphs.mjs).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const [distArg, megabytes = '0.3', only = ''] = process.argv.slice(2);
if (!distArg) {
  console.error('usage: other-languages.mjs <built engine: dist> <megabytes> [cases]');
  process.exit(2);
}
const dist = resolve(distArg);
// The benchmark times the index, not telemetry or a shared daemon.
Object.assign(process.env, { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1' });
const require = createRequire(import.meta.url);
const { CodeGraph } = require(join(dist, 'index.js'));
const { MAX_SOURCE_FILE_SIZE_BYTES } = require(join(dist, 'file-limits.js'));
const bytes = +megabytes * 1024 * 1024;
const p = (i) => (i ? i - 1 : 0);

const fill = (unit, head = '', tail = '', size = bytes) => {
  const parts = [head];
  let length = head.length + tail.length;
  for (let i = 0; length < size; i++) {
    const part = unit(i);
    parts.push(part);
    length += part.length;
  }
  parts.push(tail);
  return parts.join('');
};
/** How many units of about `each` bytes fill the size. */
const count = (each) => Math.max(1, Math.floor(bytes / each));
const one = (path, text) => ({ files: { [path]: text }, main: path });
const hex = () => '0f3a'.repeat(Math.floor(bytes / 4));

const CASES = {
  // --- languages -----------------------------------------------------------------------------
  'arkts/mixed': () => one('src/big.ets', fill((i) => `function thing${i}(name: string): string {\n  const value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'function helper(x: string) { return x; }\n\n')),
  'arkts/components': () => one('src/big.ets', fill((i) => `@Component\nstruct View${i} {\n  @State count: number = ${i}\n  build() {\n    Column() {\n      Text('x${i}')\n      View${p(i)}()\n    }\n  }\n}\n\n`)),
  'tsx/components': () => one('src/big.tsx', fill((i) => `export function Comp${i}(props: { name: string }) {\n  const value = helper(props.name);\n  return <div><Comp${p(i)} name={value} /></div>;\n}\n\n`, "import React from 'react';\nfunction helper(x: string) { return x; }\n\n")),
  'jsx/components': () => one('src/big.jsx', fill((i) => `export function Comp${i}(props) {\n  const value = helper(props.name);\n  return <div><Comp${p(i)} name={value} /></div>;\n}\n\n`, "import React from 'react';\nfunction helper(x) { return x; }\n\n")),
  'tsx/markup': () => one('src/big.tsx', fill((i) => `      <Row key="${i}" name="n${i}" onClick={() => helper("${i}")} />\n`, "import React from 'react';\nfunction helper(x: string) { return x; }\nfunction Row(props: any) { return <li>{props.name}</li>; }\nexport function Big() {\n  return (\n    <ul>\n", '    </ul>\n  );\n}\n')),
  'razor/markup': () => one('Views/Big.cshtml', fill((i) => `<p>@Html.DisplayFor(m => m.Name${i})</p>\n<a asp-action="Go${i}">@Model.Name${i}</a>\n`, '@model App.Models.Big\n@inject App.Services.Svc Svc\n<div>\n', '</div>\n')),
  'blazor/markup': () => one('Pages/Big.razor', fill((i) => `<Item Value="@items[${i}]" OnClick="@(() => Pick(${i}))" />\n`, '@page "/big"\n@inject App.Services.Svc Svc\n', '\n@code {\n  int[] items = new int[1];\n  void Pick(int i) { }\n}\n')),
  'objc/members': () => one('src/Big.m', fill((i) => `- (NSString *)thing${i}:(NSString *)name {\n  NSString *value = [self helper:name];\n  return [self thing${p(i)}:value];\n}\n\n`, '#import <Foundation/Foundation.h>\n\n@interface Big : NSObject\n- (NSString *)helper:(NSString *)x;\n@end\n\n@implementation Big\n- (NSString *)helper:(NSString *)x { return x; }\n\n', '@end\n')),
  'metal/mixed': () => one('src/big.metal', fill((i) => `float thing${i}(float name) {\n  float value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, '#include <metal_stdlib>\nusing namespace metal;\n\nfloat helper(float x) { return x; }\n\n')),
  'cuda/kernels': () => one('src/big.cu', fill((i) => `__global__ void kernel${i}(float *a) {\n  a[0] = helper(a[0]);\n}\n\nvoid launch${i}(float *a) {\n  kernel${i}<<<1, 1>>>(a);\n}\n\n`, '__device__ float helper(float x) { return x; }\n\n')),
  'svelte/script': () => one('src/Big.svelte', fill((i) => `  function thing${i}(name: string): string {\n    const value = helper(name);\n    return thing${p(i)}(value);\n  }\n\n`, '<script lang="ts">\n  function helper(x: string) { return x; }\n\n', "</script>\n\n<div>{thing0('x')}</div>\n")),
  'svelte/markup': () => one('src/Big.svelte', fill((i) => `<p on:click={() => pick(${i})}>{label(${i})}</p>\n`, '<script lang="ts">\n  function pick(i: number) {}\n  function label(i: number) { return String(i); }\n</script>\n\n<div>\n', '</div>\n')),
  'vue/script': () => one('src/Big.vue', fill((i) => `function thing${i}(name: string): string {\n  const value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, '<script setup lang="ts">\nfunction helper(x: string) { return x; }\n\n', "</script>\n\n<template>\n  <div>{{ thing0('x') }}</div>\n</template>\n")),
  'vue/markup': () => one('src/Big.vue', fill((i) => `    <p @click="pick(${i})">{{ label(${i}) }}</p>\n`, '<script setup lang="ts">\nfunction pick(i: number) {}\nfunction label(i: number) { return String(i); }\n</script>\n\n<template>\n  <div>\n', '  </div>\n</template>\n')),
  'vue/options': () => one('src/Big.vue', fill((i) => `    thing${i}(name) {\n      const value = this.helper(name);\n      return this.thing${p(i)}(value);\n    },\n`, '<script>\nexport default {\n  name: "Big",\n  methods: {\n    helper(x) { return x; },\n', '  },\n};\n</script>\n\n<template>\n  <div></div>\n</template>\n')),
  'astro/frontmatter': () => one('src/pages/big.astro', fill((i) => `function thing${i}(name: string): string {\n  const value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, '---\nfunction helper(x: string) { return x; }\n\n', "---\n<div>{thing0('x')}</div>\n")),
  'astro/markup': () => one('src/pages/big.astro', fill((i) => `<p data-i="${i}">{label(${i})}</p>\n`, '---\nfunction label(i: number) { return String(i); }\n---\n<div>\n', '</div>\n')),
  'liquid/markup': () => one('sections/big.liquid', fill((i) => `{% render 'snippet${i % 50}', value: product.title %}\n{{ product.title | append: '${i}' }}\n{% assign v${i} = product.price | times: ${i} %}\n`)),
  'pascal/mixed': () => one('src/Big.pas', fill((i) => `function Thing${i}(Name: string): string;\nvar\n  Value: string;\nbegin\n  Value := Helper(Name);\n  Result := Thing${p(i)}(Value);\nend;\n\n`, 'unit Big;\n\ninterface\n\nfunction Helper(X: string): string;\n\nimplementation\n\nfunction Helper(X: string): string;\nbegin\n  Result := X;\nend;\n\n', 'end.\n')),
  'pascal/members': () => {
    const n = count(230);
    const decl = Array.from({ length: n }, (_, i) => `    function Thing${i}(Name: string): string;\n`).join('');
    const impl = Array.from({ length: n }, (_, i) => `function TBig.Thing${i}(Name: string): string;\nvar\n  Value: string;\nbegin\n  Value := Self.Helper(Name);\n  Result := Self.Thing${p(i)}(Value);\nend;\n\n`).join('');
    return one('src/Big.pas', `unit Big;\n\ninterface\n\ntype\n  TBig = class\n  public\n    function Helper(X: string): string;\n${decl}  end;\n\nimplementation\n\nfunction TBig.Helper(X: string): string;\nbegin\n  Result := X;\nend;\n\n${impl}end.\n`);
  },
  'dfm/form': () => ({ files: {
    'src/Unit1.pas': `unit Unit1;\n\ninterface\n\nuses Forms, StdCtrls;\n\ntype\n  TForm1 = class(TForm)\n    procedure ButtonClick(Sender: TObject);\n  end;\n\nimplementation\n\n{$R *.dfm}\n\nprocedure TForm1.ButtonClick(Sender: TObject);\nbegin\nend;\n\nend.\n`,
    'src/Unit1.dfm': fill((i) => `  object Button${i}: TButton\n    Left = ${i}\n    Caption = 'B${i}'\n    OnClick = ButtonClick\n  end\n`, 'object Form1: TForm1\n  Caption = \'Form1\'\n', 'end\n'),
  }, main: 'src/Unit1.dfm' }),
  'luau/mixed': () => one('src/big.luau', fill((i) => `local function thing${i}(name: string): string\n  local value = helper(name)\n  return thing${p(i)}(value)\nend\n\n`, 'local function helper(x: string): string\n  return x\nend\n\n')),
  'cfml/script': () => one('src/Big.cfc', fill((i) => `  public string function thing${i}(required string name) {\n    var value = helper(name);\n    return thing${p(i)}(value);\n  }\n\n`, 'component {\n  public string function helper(required string x) {\n    return x;\n  }\n\n', '}\n')),
  'cfml/tags': () => one('src/Big.cfc', fill((i) => `  <cffunction name="thing${i}" access="public" returntype="string">\n    <cfargument name="name" type="string" required="true">\n    <cfset var value = helper(arguments.name)>\n    <cfreturn thing${p(i)}(value)>\n  </cffunction>\n\n`, '<cfcomponent>\n  <cffunction name="helper" access="public" returntype="string">\n    <cfargument name="x" type="string" required="true">\n    <cfreturn arguments.x>\n  </cffunction>\n\n', '</cfcomponent>\n')),
  'cobol/paragraphs': () => one('src/BIG.cbl', fill((i) => `       PARA-${i}.\n           PERFORM PARA-${p(i)}.\n           DISPLAY "X${i}".\n`, '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. BIG.\n       PROCEDURE DIVISION.\n       MAIN-PARA.\n           PERFORM PARA-0.\n           STOP RUN.\n')),
  'cobol/data': () => one('src/BIG.cbl', fill((i) => `           05 FIELD-${i}         PIC X(10).\n`, '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. BIG.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01 BIG-RECORD.\n', '       PROCEDURE DIVISION.\n       MAIN-PARA.\n           STOP RUN.\n')),
  'vbnet/members': () => one('src/Big.vb', fill((i) => `  Public Function Thing${i}(name As String) As String\n    Dim value As String = Helper(name)\n    Return Thing${p(i)}(value)\n  End Function\n\n`, 'Public Class Big\n  Public Function Helper(x As String) As String\n    Return x\n  End Function\n\n', 'End Class\n')),
  'erlang/mixed': () => one('src/big.erl', fill((i) => `thing${i}(Name) ->\n    Value = helper(Name),\n    thing${p(i)}(Value).\n\n`, '-module(big).\n-export([thing0/1]).\n\nhelper(X) -> X.\n\n')),
  'solidity/members': () => one('src/Big.sol', fill((i) => `  function thing${i}(uint name) public pure returns (uint) {\n    uint value = helper(name);\n    return thing${p(i)}(value);\n  }\n\n`, 'pragma solidity ^0.8.0;\n\ncontract Big {\n  function helper(uint x) internal pure returns (uint) { return x; }\n\n', '}\n')),
  'terraform/resources': () => one('main.tf', fill((i) => `variable "name${i}" {\n  type = string\n}\n\nresource "null_resource" "thing${i}" {\n  triggers = {\n    value = var.name${i}\n    prev  = null_resource.thing${p(i)}.id\n  }\n}\n\n`)),
  'nix/bindings': () => one('default.nix', fill((i) => `  thing${i} = name: let value = helper name; in thing${p(i)} value;\n`, '{ pkgs }:\nlet\n  helper = x: x;\n', 'in { inherit thing0; }\n')),
  'mybatis/mapper': () => ({ files: {
    'src/main/java/x/BigMapper.java': `package x;\n\npublic interface BigMapper {\n${Array.from({ length: Math.min(2000, count(90)) }, (_, i) => `  Object find${i}(int id);\n`).join('')}}\n`,
    'src/main/resources/x/BigMapper.xml': fill((i) => `  <select id="find${i}" resultType="x.Thing">\n    select * from things where id = #{id} and n = ${i}\n  </select>\n`, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n<mapper namespace="x.BigMapper">\n', '</mapper>\n'),
  }, main: 'src/main/resources/x/BigMapper.xml' }),

  // --- long runs in the languages above ----------------------------------------------------------
  'objc/hex': () => one('src/Big.m', `#import <Foundation/Foundation.h>\nstatic NSString *const BLOB = @"${hex()}";\nint use(void) { return 1; }\n`),
  'pascal/hex': () => one('src/Big.pas', `unit Big;\ninterface\nconst\n  BLOB = '${hex()}';\nimplementation\nend.\n`),
  'vbnet/hex': () => one('src/Big.vb', `Public Module Big\n  Public Const Blob As String = "${hex()}"\n  Public Function Use() As Integer\n    Return 1\n  End Function\nEnd Module\n`),
  'solidity/hex': () => one('src/Big.sol', `pragma solidity ^0.8.0;\ncontract Big {\n  bytes constant BLOB = hex"${hex()}";\n  function use() public pure returns (uint) { return 1; }\n}\n`),
  'vue/hex': () => one('src/Big.vue', `<script setup lang="ts">\nconst BLOB = "${hex()}";\nfunction use() { return BLOB.length; }\n</script>\n<template><div>{{ use() }}</div></template>\n`),
  'svelte/hex': () => one('src/Big.svelte', `<script lang="ts">\n  const BLOB = "${hex()}";\n  function use() { return BLOB.length; }\n</script>\n<div>{use()}</div>\n`),
  'erlang/hex': () => one('src/big.erl', `-module(big).\n-export([use/0]).\n\nblob() -> "${hex()}".\n\nuse() -> length(blob()).\n`),
  'terraform/hex': () => one('main.tf', `locals {\n  blob = "${hex()}"\n}\n\noutput "n" {\n  value = length(local.blob)\n}\n`),
  'nix/hex': () => one('default.nix', `{ pkgs }:\nlet\n  blob = "${hex()}";\nin { inherit blob; }\n`),
  'cobol/comments': () => one('src/BIG.cbl', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. BIG.\n       PROCEDURE DIVISION.\n       MAIN-PARA.\n           STOP RUN.\n' + fill((i) => `      * a line of commentary, number ${i}\n`)),
  'pascal/comments': () => one('src/Big.pas', 'unit Big;\ninterface\nfunction Helper(X: string): string;\nimplementation\nfunction Helper(X: string): string;\nbegin\n  Result := X;\nend;\n' + fill((i) => `// a line of commentary, number ${i}\n`) + 'end.\n'),
  'vbnet/comments': () => one('src/Big.vb', 'Public Module Big\n  Public Function Use() As Integer\n    Return 1\n  End Function\nEnd Module\n' + fill((i) => `' a line of commentary, number ${i}\n`)),
  'objc/comments': () => one('src/Big.m', '#import <Foundation/Foundation.h>\nint use(void) { return 1; }\n' + fill((i) => `// a line of commentary, number ${i}\n`)),
  'erlang/comments': () => one('src/big.erl', '-module(big).\n-export([use/0]).\n\nuse() -> 1.\n' + fill((i) => `% a line of commentary, number ${i}\n`)),
  'solidity/comments': () => one('src/Big.sol', 'pragma solidity ^0.8.0;\ncontract Big {\n  function use() public pure returns (uint) { return 1; }\n}\n' + fill((i) => `// a line of commentary, number ${i}\n`)),
  'terraform/comments': () => one('main.tf', 'variable "name" {\n  type = string\n}\n' + fill((i) => `# a line of commentary, number ${i}\n`)),
  'nix/comments': () => one('default.nix', '{ pkgs }:\n' + fill((i) => `# a line of commentary, number ${i}\n`) + '{ x = 1; }\n'),

  // --- frameworks: one large routes file each -----------------------------------------------------
  'django/urls': () => {
    const n = count(95);
    return { files: {
      'requirements.txt': 'django\n',
      'manage.py': "import django\n",
      'app/__init__.py': '',
      'app/views.py': Array.from({ length: n }, (_, i) => `def view${i}(request):\n    return None\n\n`).join(''),
      'app/urls.py': `from django.urls import path\nfrom . import views\n\nurlpatterns = [\n${Array.from({ length: n }, (_, i) => `    path('x${i}/', views.view${i}, name='x${i}'),\n`).join('')}]\n`,
    }, main: 'app/urls.py' };
  },
  'flask/routes': () => ({ files: { 'requirements.txt': 'flask\n', 'app.py': fill((i) => `@app.route('/x${i}', methods=['GET'])\ndef view${i}():\n    return helper(${i})\n\n`, 'from flask import Flask\n\napp = Flask(__name__)\n\ndef helper(x):\n    return x\n\n') }, main: 'app.py' }),
  'fastapi/routes': () => ({ files: { 'requirements.txt': 'fastapi\n', 'main.py': fill((i) => `@app.get('/x${i}')\nasync def view${i}():\n    return helper(${i})\n\n`, 'from fastapi import FastAPI\n\napp = FastAPI()\n\ndef helper(x):\n    return x\n\n') }, main: 'main.py' }),
  'express/inline': () => ({ files: { 'package.json': '{"name":"big","dependencies":{"express":"^4.0.0"}}\n', 'server.js': fill((i) => `app.get('/x${i}', (req, res) => {\n  res.json(helper(${i}));\n});\n\n`, "const express = require('express');\nconst app = express();\nfunction helper(x) { return x; }\n\n", 'module.exports = app;\n') }, main: 'server.js' }),
  'express/named': () => ({ files: { 'package.json': '{"name":"big","dependencies":{"express":"^4.0.0"}}\n', 'server.js': fill((i) => `function h${i}(req, res) { res.json(helper(${i})); }\nrouter.post('/x${i}', auth, h${i});\n`, "const express = require('express');\nconst router = express.Router();\nfunction helper(x) { return x; }\nfunction auth(req, res, next) { next(); }\n\n", 'module.exports = router;\n') }, main: 'server.js' }),
  'elysia/chains': () => ({ files: { 'package.json': '{"name":"big","dependencies":{"elysia":"^1.0.0"}}\n', 'src/app.ts': fill((j) => `export const app${j} = new Elysia({ prefix: '/p${j}' })\n${Array.from({ length: 40 }, (_, k) => `  .get('/x${k}', () => helper(${k}))\n`).join('')};\n\n`, "import { Elysia } from 'elysia';\nfunction helper(x: number) { return x; }\n\n") }, main: 'src/app.ts' }),
  'nestjs/controller': () => ({ files: { 'package.json': '{"name":"big","dependencies":{"@nestjs/common":"^10.0.0","@nestjs/core":"^10.0.0"}}\n', 'src/big.controller.ts': fill((i) => `  @Get('x${i}')\n  x${i}() {\n    return helper(${i});\n  }\n\n`, "import { Controller, Get } from '@nestjs/common';\nfunction helper(x: number) { return x; }\n\n@Controller('big')\nexport class BigController {\n", '}\n') }, main: 'src/big.controller.ts' }),
  'laravel/routes': () => {
    const n = count(60);
    return { files: {
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}\n',
      'artisan': '<?php\n',
      'app/Http/Controllers/BigController.php': `<?php\nnamespace App\\Http\\Controllers;\n\nclass BigController extends Controller {\n${Array.from({ length: n }, (_, i) => `  public function x${i}() { return ${i}; }\n`).join('')}}\n`,
      'routes/web.php': `<?php\nuse Illuminate\\Support\\Facades\\Route;\nuse App\\Http\\Controllers\\BigController;\n\n${Array.from({ length: n }, (_, i) => `Route::get('/x${i}', [BigController::class, 'x${i}']);\n`).join('')}`,
    }, main: 'routes/web.php' };
  },
  'drupal/routing': () => {
    const n = count(172);
    return { files: {
      'big.info.yml': "name: Big\ntype: module\ncore_version_requirement: ^10\n",
      'src/Controller/BigController.php': `<?php\nnamespace Drupal\\big\\Controller;\n\nclass BigController {\n${Array.from({ length: n }, (_, i) => `  public function x${i}() { return []; }\n`).join('')}}\n`,
      'big.routing.yml': Array.from({ length: n }, (_, i) => `big.x${i}:\n  path: '/x${i}'\n  defaults:\n    _controller: '\\Drupal\\big\\Controller\\BigController::x${i}'\n  requirements:\n    _permission: 'access content'\n\n`).join(''),
    }, main: 'big.routing.yml' };
  },
  'codeigniter/routes': () => {
    const n = count(34);
    return { files: {
      'index.php': "<?php\ndefine('BASEPATH', 'system/');\n",
      'system/core/CodeIgniter.php': "<?php\n",
      'application/controllers/Big.php': `<?php\nclass Big extends CI_Controller {\n${Array.from({ length: n }, (_, i) => `  public function x${i}() { return ${i}; }\n`).join('')}}\n`,
      'application/config/routes.php': `<?php\n$route['default_controller'] = 'big';\n${Array.from({ length: n }, (_, i) => `$route['x${i}'] = 'big/x${i}';\n`).join('')}`,
    }, main: 'application/config/routes.php' };
  },
  'rails/routes': () => {
    const n = count(34);
    return { files: {
      'Gemfile': "source 'https://rubygems.org'\ngem 'rails'\n",
      'config/application.rb': "require 'rails/all'\n",
      'app/controllers/big_controller.rb': `class BigController < ApplicationController\n${Array.from({ length: n }, (_, i) => `  def x${i}\n  end\n\n`).join('')}end\n`,
      'config/routes.rb': `Rails.application.routes.draw do\n${Array.from({ length: n }, (_, i) => `  get '/x${i}', to: 'big#x${i}'\n`).join('')}end\n`,
    }, main: 'config/routes.rb' };
  },
  'spring/controller': () => ({ files: { 'pom.xml': '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n', 'src/main/java/x/BigController.java': fill((i) => `  @GetMapping("/x${i}")\n  public String x${i}() {\n    return helper(${i});\n  }\n\n`, 'package x;\n\nimport org.springframework.web.bind.annotation.*;\n\n@RestController\n@RequestMapping("/big")\npublic class BigController {\n  static String helper(int x) { return "" + x; }\n\n', '}\n') }, main: 'src/main/java/x/BigController.java' }),
  'play/routes': () => {
    const n = count(40);
    return { files: {
      'build.sbt': 'lazy val root = (project in file(".")).enablePlugins(PlayScala)\n',
      'app/controllers/Big.scala': `package controllers\n\nimport play.api.mvc._\n\nclass Big extends BaseController {\n${Array.from({ length: n }, (_, i) => `  def x${i} = Action { Ok("${i}") }\n`).join('')}}\n`,
      'conf/routes': Array.from({ length: n }, (_, i) => `GET     /x${i}     controllers.Big.x${i}\n`).join(''),
    }, main: 'conf/routes' };
  },
  'gin/routes': () => {
    const n = count(90);
    return { files: {
      'go.mod': 'module example.com/big\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
      'main.go': `package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc helper(x int) int { return x }\n\n${Array.from({ length: n }, (_, i) => `func handler${i}(c *gin.Context) { helper(${i}) }\n`).join('')}\nfunc main() {\n\tr := gin.Default()\n${Array.from({ length: n }, (_, i) => `\tr.GET("/x${i}", handler${i})\n`).join('')}\tr.Run()\n}\n`,
    }, main: 'main.go' };
  },
  'axum/routes': () => {
    const n = count(110);
    const routers = [];
    for (let j = 0; j * 40 < n; j++) routers.push(`fn router${j}() -> Router {\n    Router::new()\n${Array.from({ length: Math.min(40, n - j * 40) }, (_, k) => `        .route("/x${j * 40 + k}", get(handler${j * 40 + k}))\n`).join('')}}\n\n`);
    return { files: {
      'Cargo.toml': '[package]\nname = "big"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n',
      'src/main.rs': `use axum::{routing::get, Router};\n\n${Array.from({ length: n }, (_, i) => `async fn handler${i}() -> &'static str { "x" }\n`).join('')}\n${routers.join('')}fn main() {}\n`,
    }, main: 'src/main.rs' };
  },
  'aspnet/controller': () => ({ files: { 'Big.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n', 'Controllers/BigController.cs': fill((i) => `  [HttpGet("x${i}")]\n  public string X${i}() {\n    return Helper(${i});\n  }\n\n`, 'using Microsoft.AspNetCore.Mvc;\n\n[ApiController]\n[Route("api/[controller]")]\npublic class BigController : ControllerBase {\n  static string Helper(int x) { return "" + x; }\n\n', '}\n') }, main: 'Controllers/BigController.cs' }),
  'aspnet/minimal': () => ({ files: { 'Big.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n', 'Program.cs': fill((i) => `app.MapGet("/x${i}", () => Helper(${i}));\n`, 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\nstatic string Helper(int x) { return "" + x; }\n\n', 'app.Run();\n') }, main: 'Program.cs' }),
  'vapor/routes': () => {
    const n = count(110);
    return { files: {
      'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "big", dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")])\n',
      'Sources/App/routes.swift': `import Vapor\n\n${Array.from({ length: n }, (_, i) => `func handler${i}(req: Request) -> String { return "x" }\n`).join('')}\nfunc routes(_ app: Application) throws {\n${Array.from({ length: n }, (_, i) => `    app.get("x${i}", use: handler${i})\n`).join('')}}\n`,
    }, main: 'Sources/App/routes.swift' };
  },
  'react-router/routes': () => {
    const n = count(105);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react":"^18.0.0","react-router-dom":"^6.0.0"}}\n',
      'src/routes.tsx': `import React from 'react';\nimport { Routes, Route, useNavigate } from 'react-router-dom';\n\n${Array.from({ length: n }, (_, i) => `function Page${i}() { return <div>${i}</div>; }\n`).join('')}\nexport function Nav() {\n  const navigate = useNavigate();\n${Array.from({ length: Math.min(n, 2000) }, (_, i) => `  const go${i} = () => navigate('/x${i}');\n`).join('')}  return null;\n}\n\nexport function App() {\n  return (\n    <Routes>\n${Array.from({ length: n }, (_, i) => `      <Route path="/x${i}" element={<Page${i} />} />\n`).join('')}    </Routes>\n  );\n}\n`,
    }, main: 'src/routes.tsx' };
  },
  'vue-router/routes': () => {
    const n = count(116);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"vue":"^3.0.0","vue-router":"^4.0.0"}}\n',
      'src/router.ts': `import { createRouter, createWebHistory } from 'vue-router';\n\n${Array.from({ length: n }, (_, i) => `const Page${i} = { template: '<div>${i}</div>' };\n`).join('')}\nexport const router = createRouter({\n  history: createWebHistory(),\n  routes: [\n${Array.from({ length: n }, (_, i) => `    { path: '/x${i}', name: 'x${i}', component: Page${i} },\n`).join('')}  ],\n});\n\nexport function go(i: number) {\n  router.push('/x1');\n}\n`,
    }, main: 'src/router.ts' };
  },
  'angular/routes': () => {
    const n = count(140);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"@angular/core":"^17.0.0","@angular/router":"^17.0.0"}}\n',
      'src/app/app.routes.ts': `import { Component } from '@angular/core';\nimport { Routes } from '@angular/router';\n\n${Array.from({ length: n }, (_, i) => `@Component({ selector: 'p-${i}', template: '' })\nexport class Page${i}Component {}\n`).join('')}\nexport const routes: Routes = [\n${Array.from({ length: n }, (_, i) => `  { path: 'x${i}', component: Page${i}Component },\n`).join('')}];\n`,
    }, main: 'src/app/app.routes.ts' };
  },
  'tanstack/routes': () => {
    const n = count(200);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react":"^18.0.0","@tanstack/react-router":"^1.0.0"}}\n',
      'src/routes.tsx': `import React from 'react';\nimport { createRootRoute, createRoute } from '@tanstack/react-router';\n\nexport const rootRoute = createRootRoute();\n\n${Array.from({ length: n }, (_, i) => `function Page${i}() { return <div>${i}</div>; }\nexport const route${i} = createRoute({ getParentRoute: () => rootRoute, path: '/x${i}', component: Page${i} });\n`).join('')}`,
    }, main: 'src/routes.tsx' };
  },
};

// --- bridges, desktop commands, navigation, and more route styles --------------------------------
Object.assign(CASES, {
  'swift-objc/bridge': () => {
    const n = count(160);
    return { files: {
      'Sources/Big.h': `#import <Foundation/Foundation.h>\n\n@interface Big : NSObject\n${Array.from({ length: n }, (_, i) => `- (NSString *)thing${i}WithName:(NSString *)name;\n`).join('')}@end\n`,
      'Sources/Big.m': `#import "Big.h"\n\n@implementation Big\n${Array.from({ length: n }, (_, i) => `- (NSString *)thing${i}WithName:(NSString *)name {\n  return name;\n}\n\n`).join('')}@end\n`,
      'Sources/Use.swift': `import Foundation\n\nfunc use(big: Big) {\n${Array.from({ length: n }, (_, i) => `    _ = big.thing${i}(name: "x")\n`).join('')}}\n`,
    }, main: 'Sources/Big.m' };
  },
  'rn/legacy-bridge': () => {
    const n = count(140);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/Big.m': `#import <React/RCTBridgeModule.h>\n\n@interface Big : NSObject <RCTBridgeModule>\n@end\n\n@implementation Big\nRCT_EXPORT_MODULE(Big)\n\n${Array.from({ length: n }, (_, i) => `RCT_EXPORT_METHOD(thing${i}:(NSString *)name) {\n}\n\n`).join('')}@end\n`,
      'src/use.js': `import { NativeModules } from 'react-native';\n\nexport function use() {\n${Array.from({ length: n }, (_, i) => `  NativeModules.Big.thing${i}('x');\n`).join('')}}\n`,
    }, main: 'ios/Big.m' };
  },
  'rn/events': () => {
    const n = count(150);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/Big.m': `#import <React/RCTEventEmitter.h>\n\n@interface Big : RCTEventEmitter\n@end\n\n@implementation Big\nRCT_EXPORT_MODULE(Big)\n\n- (void)fire {\n${Array.from({ length: n }, (_, i) => `  [self sendEventWithName:@"e${i}" body:nil];\n`).join('')}}\n@end\n`,
      'src/listen.js': `import { NativeEventEmitter, NativeModules } from 'react-native';\n\nconst emitter = new NativeEventEmitter(NativeModules.Big);\n${Array.from({ length: n }, (_, i) => `function on${i}(e) {}\nemitter.addListener('e${i}', on${i});\n`).join('')}`,
    }, main: 'src/listen.js' };
  },
  'expo/modules': () => {
    const n = count(110);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"expo":"^51.0.0","expo-modules-core":"^1.12.0"}}\n',
      'ios/BigModule.swift': `import ExpoModulesCore\n\npublic class BigModule: Module {\n  public func definition() -> ModuleDefinition {\n    Name("Big")\n${Array.from({ length: n }, (_, i) => `    AsyncFunction("fn${i}") { (x: Int) -> Int in\n      return x\n    }\n`).join('')}  }\n}\n`,
      'src/use.ts': `import { requireNativeModule } from 'expo-modules-core';\n\nconst Big = requireNativeModule('Big');\n\nexport function use() {\n${Array.from({ length: n }, (_, i) => `  Big.fn${i}(1);\n`).join('')}}\n`,
    }, main: 'ios/BigModule.swift' };
  },
  'rn/paper-props': () => ({ files: {
    'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
    'ios/BigViewManager.m': fill((i) => `RCT_EXPORT_VIEW_PROPERTY(prop${i}, NSString)\n`, '#import <React/RCTViewManager.h>\n\n@interface BigViewManager : RCTViewManager\n@end\n\n@implementation BigViewManager\nRCT_EXPORT_MODULE(BigView)\n\n', '\n@end\n'),
    'src/BigView.js': "import { requireNativeComponent } from 'react-native';\nexport default requireNativeComponent('BigView');\n",
  }, main: 'ios/BigViewManager.m' }),
  'tauri/commands': () => {
    const n = count(110);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"@tauri-apps/api":"^2.0.0"}}\n',
      'src-tauri/Cargo.toml': '[package]\nname = "big"\nversion = "0.1.0"\n\n[dependencies]\ntauri = "2"\n',
      'src-tauri/src/main.rs': `${Array.from({ length: n }, (_, i) => `#[tauri::command]\nfn cmd${i}(x: i32) -> i32 {\n    x\n}\n\n`).join('')}fn main() {\n    tauri::Builder::default().invoke_handler(tauri::generate_handler![${Array.from({ length: n }, (_, i) => `cmd${i}`).join(', ')}]).run();\n}\n`,
      'src/use.ts': `import { invoke } from '@tauri-apps/api/core';\n\nexport async function use() {\n${Array.from({ length: n }, (_, i) => `  await invoke('cmd${i}', { x: 1 });\n`).join('')}}\n`,
    }, main: 'src-tauri/src/main.rs' };
  },
  'next/navigation': () => {
    const files = { 'package.json': '{"name":"big","dependencies":{"next":"^14.0.0","react":"^18.0.0"}}\n' };
    for (let k = 0; k < 100; k++) files[`app/x${k}/page.tsx`] = `export default function Page${k}() { return <div>${k}</div>; }\n`;
    files['app/nav.tsx'] = fill((i) => `  const go${i} = () => router.push('/x${i % 100}');\n`, "'use client';\nimport { useRouter } from 'next/navigation';\n\nexport function Nav() {\n  const router = useRouter();\n", '  return null;\n}\n');
    return { files, main: 'app/nav.tsx' };
  },
  'expo-router/navigation': () => {
    const files = { 'package.json': '{"name":"big","dependencies":{"expo-router":"^3.0.0","react":"^18.0.0"}}\n' };
    for (let k = 0; k < 100; k++) files[`app/x${k}.tsx`] = `export default function Page${k}() { return null; }\n`;
    files['components/nav.tsx'] = fill((i) => `  const go${i} = () => router.push('/x${i % 100}');\n`, "import { useRouter } from 'expo-router';\n\nexport function Nav() {\n  const router = useRouter();\n", '  return null;\n}\n');
    return { files, main: 'components/nav.tsx' };
  },
  'sveltekit/goto': () => {
    const files = { 'package.json': '{"name":"big","devDependencies":{"@sveltejs/kit":"^2.0.0","svelte":"^4.0.0"}}\n', 'svelte.config.js': 'export default {};\n' };
    for (let k = 0; k < 100; k++) files[`src/routes/x${k}/+page.svelte`] = `<h1>${k}</h1>\n`;
    files['src/lib/nav.ts'] = fill((i) => `export const go${i} = () => goto('/x${i % 100}');\n`, "import { goto } from '$app/navigation';\n\n");
    return { files, main: 'src/lib/nav.ts' };
  },
  'chi/routes': () => {
    const n = count(95);
    return { files: {
      'go.mod': 'module example.com/big\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n',
      'main.go': `package main\n\nimport (\n\t"net/http"\n\n\t"github.com/go-chi/chi/v5"\n)\n\n${Array.from({ length: n }, (_, i) => `func handler${i}(w http.ResponseWriter, r *http.Request) {}\n`).join('')}\nfunc main() {\n\tr := chi.NewRouter()\n${Array.from({ length: n }, (_, i) => `\tr.Get("/x${i}", handler${i})\n`).join('')}\thttp.ListenAndServe(":8080", r)\n}\n`,
    }, main: 'main.go' };
  },
  'gorilla/routes': () => {
    const n = count(120);
    return { files: {
      'go.mod': 'module example.com/big\n\ngo 1.22\n\nrequire github.com/gorilla/mux v1.8.0\n',
      'main.go': `package main\n\nimport (\n\t"net/http"\n\n\t"github.com/gorilla/mux"\n)\n\n${Array.from({ length: n }, (_, i) => `func handler${i}(w http.ResponseWriter, r *http.Request) {}\n`).join('')}\nfunc main() {\n\tr := mux.NewRouter()\n${Array.from({ length: n }, (_, i) => `\tr.HandleFunc("/x${i}", handler${i}).Methods("GET")\n`).join('')}\thttp.ListenAndServe(":8080", r)\n}\n`,
    }, main: 'main.go' };
  },
  'actix/routes': () => ({ files: { 'Cargo.toml': '[package]\nname = "big"\nversion = "0.1.0"\n\n[dependencies]\nactix-web = "4"\n', 'src/main.rs': fill((i) => `#[get("/x${i}")]\nasync fn handler${i}() -> impl Responder {\n    "x"\n}\n\n`, 'use actix_web::{get, Responder};\n\n', 'fn main() {}\n') }, main: 'src/main.rs' }),
  'rocket/routes': () => ({ files: { 'Cargo.toml': '[package]\nname = "big"\nversion = "0.1.0"\n\n[dependencies]\nrocket = "0.5"\n', 'src/main.rs': fill((i) => `#[get("/x${i}")]\nfn handler${i}() -> &'static str {\n    "x"\n}\n\n`, '#[macro_use]\nextern crate rocket;\n\n', 'fn main() {}\n') }, main: 'src/main.rs' }),
  'js/events': () => ({ files: { 'package.json': '{"name":"big"}\n', 'src/events.js': fill((i) => `function on${i}(x) { return x; }\nemitter.on('e${i}', on${i});\nfunction fire${i}() { emitter.emit('e${i}', ${i}); }\n`, "const { EventEmitter } = require('events');\nconst emitter = new EventEmitter();\n\n") }, main: 'src/events.js' }),
  'c/fnptr-table': () => {
    const n = count(75);
    return one('src/big.c', `struct op { const char *name; int (*run)(int); };\n\n${Array.from({ length: n }, (_, i) => `static int op${i}(int x) { return x + ${i}; }\n`).join('')}\nstatic const struct op OPS[] = {\n${Array.from({ length: n }, (_, i) => `  {"op${i}", op${i}},\n`).join('')}};\n\nint dispatch(int i, int x) {\n  return OPS[i].run(x);\n}\n`);
  },
  'spring/mappings': () => ({ files: { 'pom.xml': '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n', 'src/main/java/x/BigController.java': fill((i) => `  @RequestMapping(value = "/x${i}", method = RequestMethod.POST)\n  public ResponseEntity<String> x${i}(@RequestBody String body) {\n    return ResponseEntity.ok(service.handle(body));\n  }\n\n`, 'package x;\n\nimport org.springframework.http.ResponseEntity;\nimport org.springframework.web.bind.annotation.*;\n\n@RestController\npublic class BigController {\n  private final BigService service = new BigService();\n\n', '}\n\nclass BigService {\n  String handle(String body) { return body; }\n}\n') }, main: 'src/main/java/x/BigController.java' }),
  // The cases above for Razor, Blazor and TanStack give the engine nothing it links
  // (no component, no script, a root route with no options). These do.
  'tanstack/tree': () => {
    const n = count(200);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react":"^18.0.0","@tanstack/react-router":"^1.0.0"}}\n',
      'src/routes.tsx': `import React from 'react';\nimport { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';\n\nfunction Root() { return <Outlet />; }\nexport const rootRoute = createRootRoute({ component: Root });\n\n${Array.from({ length: n }, (_, i) => `function Page${i}() { return <div>${i}</div>; }\nexport const route${i} = createRoute({ getParentRoute: () => rootRoute, path: '/x${i}', component: Page${i} });\n`).join('')}`,
    }, main: 'src/routes.tsx' };
  },
  'blazor/components': () => {
    const k = 400;
    return { files: {
      'Components/Items.cs': `using Microsoft.AspNetCore.Components;\n\nnamespace App.Components;\n\n${Array.from({ length: k }, (_, i) => `public class Item${i} : ComponentBase { [Parameter] public int Value { get; set; } }\n`).join('')}`,
      'Models/Rows.cs': `namespace App.Models;\n\n${Array.from({ length: k }, (_, i) => `public class Row${i} { }\n`).join('')}`,
      'Pages/Big.razor': fill((i) => `<Item${i % k} Value="@items[${i}]" TItem="Row${(i * 7) % k}" />\n<p>@typeof(Row${(i * 3) % k})</p>\n`, '@page "/big"\n@using App.Components\n@using App.Models\n', '\n@code {\n  int[] items = new int[1];\n}\n'),
    }, main: 'Pages/Big.razor' };
  },
  'razor/script': () => ({ files: {
    'Models/Big.cs': 'namespace App.Models;\n\npublic class Big { }\n',
    'wwwroot/js/site.js': 'function helper(x) { return x; }\n',
    'Views/Big.cshtml': fill((i) => `  function thing${i}(name) {\n    var value = helper(name);\n    return thing${p(i)}(value);\n  }\n\n`, '@model App.Models.Big\n<div></div>\n<script>\n', '</script>\n'),
  }, main: 'Views/Big.cshtml' }),
  'razor/directives': () => {
    const k = 400;
    return { files: {
      'Services/Svcs.cs': `namespace App.Services;\n\n${Array.from({ length: k }, (_, i) => `public class Svc${i} { }\n`).join('')}`,
      'Views/Big.cshtml': fill((i) => `@inject App.Services.Svc${i % k} S${i}\n<p>@typeof(Svc${(i * 3) % k})</p>\n`, '@model App.Services.Svc0\n'),
    }, main: 'Views/Big.cshtml' };
  },
  'fabric/spec': () => ({ files: {
    'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
    'ios/BigView.mm': '#import <React/RCTViewComponentView.h>\n\n@interface BigView : RCTViewComponentView\n@end\n\n@implementation BigView\n@end\n',
    'src/BigNativeComponent.ts': fill((i) => `  prop${i}?: string;\n  onEvent${i}?: CT.DirectEventHandler<Readonly<{ value: string }>>;\n`, "import { codegenNativeComponent } from 'react-native';\nimport type { ViewProps, CodegenTypes as CT } from 'react-native';\n\nexport interface NativeProps extends ViewProps {\n", "}\n\nexport default codegenNativeComponent<NativeProps>('Big');\n"),
  }, main: 'src/BigNativeComponent.ts' }),
  // The bridge rows of the README the cases above leave out.
  'objc-swift/bridge': () => {
    const n = count(150);
    return { files: {
      'Sources/Big.swift': `import Foundation\n\n@objc class Big: NSObject {\n${Array.from({ length: n }, (_, i) => `  @objc func thing${i}(name: String) -> String {\n    return name\n  }\n\n`).join('')}}\n`,
      'Sources/Use.m': `#import "Big-Swift.h"\n\n@interface Use : NSObject\n@end\n\n@implementation Use\n- (void)use:(Big *)big {\n${Array.from({ length: n }, (_, i) => `  [big thing${i}WithName:@"x"];\n`).join('')}}\n@end\n`,
    }, main: 'Sources/Big.swift' };
  },
  'rn/turbomodule': () => {
    const n = count(150);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'src/NativeBig.ts': `import type { TurboModule } from 'react-native';\nimport { TurboModuleRegistry } from 'react-native';\n\nexport interface Spec extends TurboModule {\n${Array.from({ length: n }, (_, i) => `  thing${i}(name: string): string;\n`).join('')}}\n\nexport default TurboModuleRegistry.getEnforcing<Spec>('Big');\n`,
      'ios/Big.mm': `#import "Big.h"\n\n@implementation Big\nRCT_EXPORT_MODULE()\n\n${Array.from({ length: n }, (_, i) => `- (NSString *)thing${i}:(NSString *)name {\n  return name;\n}\n\n`).join('')}@end\n`,
      'src/use.ts': `import Big from './NativeBig';\n\nexport function use() {\n${Array.from({ length: n }, (_, i) => `  Big.thing${i}('x');\n`).join('')}}\n`,
    }, main: 'ios/Big.mm' };
  },
  'rn/extern-swift': () => {
    const n = count(150);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/Big.m': `#import <React/RCTBridgeModule.h>\n\n@interface RCT_EXTERN_MODULE(Big, NSObject)\n${Array.from({ length: n }, (_, i) => `RCT_EXTERN_METHOD(thing${i}:(NSString *)name)\n`).join('')}@end\n`,
      'ios/Big.swift': `import Foundation\n\n@objc(Big)\nclass Big: NSObject {\n${Array.from({ length: n }, (_, i) => `  @objc func thing${i}(_ name: String) {\n  }\n\n`).join('')}}\n`,
      'src/use.js': `import { NativeModules } from 'react-native';\n\nexport function use() {\n${Array.from({ length: n }, (_, i) => `  NativeModules.Big.thing${i}('x');\n`).join('')}}\n`,
    }, main: 'ios/Big.swift' };
  },
  'rn/android-bridge': () => {
    const n = count(160);
    return { files: {
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'android/src/main/java/com/big/BigModule.kt': `package com.big\n\nimport com.facebook.react.bridge.ReactApplicationContext\nimport com.facebook.react.bridge.ReactContextBaseJavaModule\nimport com.facebook.react.bridge.ReactMethod\n\nclass BigModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {\n  override fun getName(): String = "Big"\n\n${Array.from({ length: n }, (_, i) => `  @ReactMethod\n  fun thing${i}(name: String) {\n  }\n\n`).join('')}}\n`,
      'android/src/main/java/com/big/BigViewManager.java': `package com.big;\n\npublic class BigViewManager extends SimpleViewManager<View> {\n${Array.from({ length: n }, (_, i) => `  @ReactProp(name = "prop${i}")\n  public void setProp${i}(View view, String value) {\n  }\n\n`).join('')}}\n`,
      'src/use.js': `import { NativeModules } from 'react-native';\n\nexport function use() {\n${Array.from({ length: n }, (_, i) => `  NativeModules.Big.thing${i}('x');\n`).join('')}}\n`,
    }, main: 'android/src/main/java/com/big/BigModule.kt' };
  },
});

const wanted = only ? only.split(',') : null;
const names = Object.keys(CASES).filter((name) => !wanted || wanted.some((w) => name === w || name.startsWith(w)));

// A small first run, so the first case timed does not pay for loading the engine.
{
  const dir = mkdtempSync(join(tmpdir(), 'cg-bench-warm-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'warm.ts'), 'export function warm() { return 1; }\n');
  (await CodeGraph.init(dir, { index: true })).close();
  rmSync(dir, { recursive: true, force: true });
}

const slow = [];
for (const name of names) {
  const { files, main } = CASES[name]();
  const dir = mkdtempSync(join(tmpdir(), 'cg-bench-big-'));
  let size = 0;
  let largest = 0;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    size += text.length;
    largest = Math.max(largest, Buffer.byteLength(text));
  }
  if (process.env.BENCH_WRITE) {
    const out = join(process.env.BENCH_WRITE, name.replace('/', '-'));
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), text); }
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  const started = Date.now();
  let failed = '';
  let symbols = 0;
  let routes = 0;
  let edges = 0;
  try {
    const cg = await CodeGraph.init(dir, { index: true });
    symbols = cg.getNodesInFile(main).filter((n) => n.kind !== 'file').length;
    cg.close();
    const db = new DatabaseSync(join(dir, '.codegraph', 'codegraph.db'));
    routes = db.prepare("SELECT count(*) AS n FROM nodes WHERE kind = 'route'").get().n;
    edges = db.prepare('SELECT count(*) AS n FROM edges').get().n;
    db.close();
  } catch (error) {
    failed = `  FAILED: ${String(error?.message ?? error).slice(0, 90)}`;
  }
  const seconds = (Date.now() - started) / 1000;
  rmSync(dir, { recursive: true, force: true });
  const perMb = seconds / (size / 1024 / 1024);
  // A file over the engine's limit is left out, so its time says nothing.
  const over = largest > MAX_SOURCE_FILE_SIZE_BYTES ? `  <-- NOT MEASURED: a file of ${(largest / 1048576).toFixed(2)} MB is over the size limit` : '';
  const mark = failed || over || (perMb > 2 ? '  <-- slow' : '');
  if (mark) slow.push(name);
  console.log(`${name.padEnd(22)} ${seconds.toFixed(1).padStart(6)} s  ${(size / 1048576).toFixed(2).padStart(5)} MB  ${String(symbols).padStart(7)} symbols  ${String(routes).padStart(6)} routes  ${String(edges).padStart(7)} edges${mark}`);
}
console.log(slow.length ? `\nslow (over 2 s a megabyte), failed or not measured: ${slow.join(', ')}` : '\nnothing over 2 s a megabyte');
