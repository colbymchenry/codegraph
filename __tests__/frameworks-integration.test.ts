import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});

describe('Flutter end-to-end — setState→build synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes a handler→build edge when a State method calls setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.dart'),
      'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const increment = methods.find((n) => n.name === '_increment');
    const build = methods.find((n) => n.name === 'build');
    expect(increment).toBeDefined();
    expect(build).toBeDefined();

    // setState re-runs build (Flutter-internal, no static edge). The synthesizer
    // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
    const edges = cg.getOutgoingEdges(increment!.id);
    const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
    expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

    cg.close();
  });
});

describe('C++ end-to-end — virtual override synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves callers through typed object pointers', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'detect.hpp'),
        'class CDetect {\n' +
          ' public:\n' +
          '  int Processing();\n' +
          '};\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int Run();\n' +
          '  int Flush();\n' +
          '};\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'detect.cpp'),
        '#include "detect.hpp"\n' +
          'int CDetector::Run() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::Flush() { return m_cpAlg->Processing(); }\n' +
          'int CDetect::Processing() { return 0; }\n'
      );

      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const processing = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('CDetect::Processing'));
      expect(processing).toBeDefined();

      const callers = cg.getCallers(processing!.id).map((c) => c.node.qualifiedName);
      expect(callers).toContain('CDetector::Run');
      expect(callers).toContain('CDetector::Flush');

      const runMethod = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName.endsWith('CDetector::Run'));
      expect(runMethod).toBeDefined();
      const callees = cg.getCallees(runMethod!.id).map((c) => c.node.qualifiedName);
      expect(callees).toContain('CDetect::Processing');
    } finally {
      cg?.close();
    }
  });

  it('resolves typed pointer callers when the method name is ambiguous and the call sits inside a return/declaration', async () => {
    // Regression: an earlier version of the C++ receiver-type inference matched
    // the call line itself (`return m_cpAlg->Processing()`) and treated `return`
    // as the type, OR grabbed `int r =` as a type from the prefix. With Strategy
    // 3's "unique method name" fallback, the original issue example resolved
    // anyway — but as soon as two classes share a method name (very common in
    // real C++), both calls go unresolved.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'detect.hpp'),
        'class CDetect { public: int Processing(); };\n' +
          'class CWidget { public: int Processing(); };\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int RunReturn();\n' +
          '  int RunAssign();\n' +
          '};\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'detect.cpp'),
        '#include "detect.hpp"\n' +
          'int CDetector::RunReturn() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::RunAssign() { int r = m_cpAlg->Processing(); return r; }\n' +
          'int CDetect::Processing() { return 0; }\n' +
          'int CWidget::Processing() { return 0; }\n'
      );

      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const detectProc = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'CDetect::Processing');
      const widgetProc = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'CWidget::Processing');
      expect(detectProc).toBeDefined();
      expect(widgetProc).toBeDefined();

      const detectCallers = cg.getCallers(detectProc!.id).map((c) => c.node.qualifiedName);
      expect(detectCallers).toContain('CDetector::RunReturn');
      expect(detectCallers).toContain('CDetector::RunAssign');

      // CWidget::Processing is never called — calls must NOT misroute here.
      const widgetCallers = cg.getCallers(widgetProc!.id).map((c) => c.node.qualifiedName);
      expect(widgetCallers).not.toContain('CDetector::RunReturn');
      expect(widgetCallers).not.toContain('CDetector::RunAssign');
    } finally {
      cg?.close();
    }
  });

  it('bridges a base virtual method to the subclass override', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'iter.cpp'),
      'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Two methods named Next: the base virtual (lower line) and the override.
    const nexts = cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'Next')
      .sort((a, b) => a.startLine - b.startLine);
    expect(nexts.length).toBe(2);
    const [baseNext, overrideNext] = nexts;

    // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
    // trace/callees from the interface method reaches the implementation.
    const edge = cg
      .getOutgoingEdges(baseNext!.id)
      .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
    expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

    cg.close();
  });
});

describe('Java end-to-end — field-injected bean trace (issue #389)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // Mirrors the issue's Spring MVC pattern:
  //   UserAction(@Resource UserBO userbo).toLogin2() -> this.userbo.toLogin2()
  //     -> UserBO.toLogin2() -> userService.toLogin() -> UserService.toLogin (iface)
  //     -> UserServiceImpl.toLogin() via interface→impl synthesis.
  // Without the extractor `this.` strip + field-typed receiver lookup, the very
  // first hop (controller -> bean) was missing entirely, breaking trace.
  it('connects controller -> @Resource bean -> interface -> impl end-to-end', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-bean-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example/user');
    fs.mkdirSync(path.join(javaDir, 'action'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'bo'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(javaDir, 'service/impl'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'action/UserAction.java'),
      'package com.example.user.action;\n' +
        'import com.example.user.bo.UserBO;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Controller\n' +
        'public class UserAction {\n' +
        '  @Resource(name = "userBO") private UserBO userbo;\n' +
        '  public void toLogin2() { this.userbo.toLogin2(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'bo/UserBO.java'),
      'package com.example.user.bo;\n' +
        'import com.example.user.service.UserService;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Component("userBO")\n' +
        'public class UserBO {\n' +
        '  @Resource private UserService userService;\n' +
        '  public void toLogin2() { userService.toLogin(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'service/UserService.java'),
      'package com.example.user.service;\n' +
        'public interface UserService { void toLogin(); }\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'service/impl/UserServiceImpl.java'),
      'package com.example.user.service.impl;\n' +
        'import com.example.user.service.UserService;\n' +
        '@org.springframework.stereotype.Service("userService")\n' +
        'public class UserServiceImpl implements UserService {\n' +
        '  public void toLogin() { }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const find = (cls: string, name: string) =>
      methods.find((m) => m.name === name && m.filePath.endsWith(`${cls}.java`));

    const action = find('UserAction', 'toLogin2');
    const bo = find('UserBO', 'toLogin2');
    const svc = find('UserService', 'toLogin');
    const impl = find('UserServiceImpl', 'toLogin');
    expect(action).toBeDefined();
    expect(bo).toBeDefined();
    expect(svc).toBeDefined();
    expect(impl).toBeDefined();

    // UserAction.toLogin2 -> UserBO.toLogin2 (the regressed hop — `this.userbo`
    // receiver was emitted verbatim and the field-type lookup didn't exist).
    const actionToBo = cg.getOutgoingEdges(action!.id).find((e) => e.target === bo!.id);
    expect(actionToBo, 'controller `this.userbo.toLogin2()` should reach UserBO.toLogin2').toBeDefined();
    expect(actionToBo!.kind).toBe('calls');

    // UserBO.toLogin2 -> UserService.toLogin (plain identifier receiver, works pre-fix).
    const boToSvc = cg.getOutgoingEdges(bo!.id).find((e) => e.target === svc!.id);
    expect(boToSvc).toBeDefined();

    // UserService.toLogin -> UserServiceImpl.toLogin (interface->impl synth).
    const svcToImpl = cg.getOutgoingEdges(svc!.id).find((e) => e.target === impl!.id);
    expect(svcToImpl).toBeDefined();

    cg.close();
  });

  it('bridges a Java mapper interface method to its MyBatis XML statement (incl. SQL fragments)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example/dao');
    const xmlDir = path.join(tmpDir, 'src/main/resources/mappers');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.mybatis</groupId><artifactId>mybatis</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'UserDAOMapper.java'),
      'package com.example.dao;\n' +
        'public interface UserDAOMapper {\n' +
        '  Object getById(int id);\n' +
        '  int updateUser(Object u);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(xmlDir, 'UserDAOMapper.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n' +
        '<mapper namespace="com.example.dao.UserDAOMapper">\n' +
        '  <sql id="userCols">id, name, email</sql>\n' +
        '  <select id="getById" parameterType="int" resultType="User">\n' +
        '    SELECT <include refid="userCols"/> FROM users WHERE id = #{id}\n' +
        '  </select>\n' +
        '  <update id="updateUser" parameterType="User">\n' +
        '    UPDATE users SET name=#{name}, email=#{email} WHERE id=#{id}\n' +
        '  </update>\n' +
        '</mapper>\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const getByIdJava = methods.find((m) => m.name === 'getById' && m.language === 'java');
    const getByIdXml = methods.find((m) => m.name === 'getById' && m.language === 'xml');
    const updateJava = methods.find((m) => m.name === 'updateUser' && m.language === 'java');
    const updateXml = methods.find((m) => m.name === 'updateUser' && m.language === 'xml');
    const sqlFrag = methods.find((m) => m.name === 'userCols' && m.language === 'xml');
    expect(getByIdJava).toBeDefined();
    expect(getByIdXml).toBeDefined();
    expect(updateJava).toBeDefined();
    expect(updateXml).toBeDefined();
    expect(sqlFrag).toBeDefined();

    // XML statement qualified name must be `<namespace>::<id>` so the
    // synthesizer can match against the Java method's `<Class>::<method>`
    // suffix — this is the load-bearing contract between extractor + synthesis.
    expect(getByIdXml!.qualifiedName).toBe('com.example.dao.UserDAOMapper::getById');

    // Bridge: Java mapper method -> XML statement, kind 'calls'.
    const j2xGet = cg.getOutgoingEdges(getByIdJava!.id).find((e) => e.target === getByIdXml!.id);
    expect(j2xGet, 'Java getById should reach the XML <select id="getById">').toBeDefined();
    expect(j2xGet!.kind).toBe('calls');
    const j2xUpd = cg.getOutgoingEdges(updateJava!.id).find((e) => e.target === updateXml!.id);
    expect(j2xUpd, 'Java updateUser should reach the XML <update id="updateUser">').toBeDefined();

    // <include refid="userCols"/> inside <select> -> <sql id="userCols"> in same mapper.
    const incEdge = cg.getOutgoingEdges(getByIdXml!.id).find((e) => e.target === sqlFrag!.id);
    expect(incEdge, '<include refid="userCols"/> should reach the <sql> fragment').toBeDefined();

    cg.close();
  });

  it('binds @Value / @ConfigurationProperties to YAML + .properties keys (incl. relaxed binding)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-config-'));
    const javaDir = path.join(tmpDir, 'src/main/java/com/example');
    const resDir = path.join(tmpDir, 'src/main/resources');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n'
    );
    fs.writeFileSync(
      path.join(resDir, 'application.yml'),
      'app:\n' +
        '  cache:\n' +
        '    name:\n' +
        '      user-token: "example-service:auth:token"\n' +
        '    enabled: true\n' +
        'db:\n' +
        '  url: "jdbc:mysql://localhost/x"\n'
    );
    fs.writeFileSync(
      path.join(resDir, 'application.properties'),
      'app.retry-count=3\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'CacheConfig.java'),
      'package com.example;\n' +
        'import org.springframework.beans.factory.annotation.Value;\n' +
        'public class CacheConfig {\n' +
        '  @Value("${app.cache.name.user-token}") private String tokenCacheName;\n' +
        '  @Value("${app.cache.enabled:true}") private boolean enabled;\n' +
        '  // relaxed binding: java camelCase, properties kebab-case\n' +
        '  @Value("${app.retryCount}") private int retry;\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(javaDir, 'CacheProperties.java'),
      'package com.example;\n' +
        'import org.springframework.boot.context.properties.ConfigurationProperties;\n' +
        '@ConfigurationProperties(prefix = "app.cache")\n' +
        'public class CacheProperties { private boolean enabled; }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // YAML/properties leaf keys: one constant node per dotted path.
    const cfgKeys = cg
      .getNodesByKind('constant')
      .filter((n) => n.language === 'yaml' || n.language === 'properties');
    const cfgByQn = (qn: string) => cfgKeys.find((n) => n.qualifiedName === qn);
    expect(cfgByQn('app.cache.name.user-token')).toBeDefined();
    expect(cfgByQn('app.cache.enabled')).toBeDefined();
    expect(cfgByQn('db.url')).toBeDefined();
    expect(cfgByQn('app.retry-count')).toBeDefined();

    // @Value("${app.cache.name.user-token}") -> the YAML leaf key.
    const valueBindings = cg
      .getNodesByKind('constant')
      .filter((n) => n.id.startsWith('spring-value:'));
    const userToken = valueBindings.find((n) => n.name === 'app.cache.name.user-token');
    expect(userToken).toBeDefined();
    const userTokenEdges = cg.getOutgoingEdges(userToken!.id);
    const userTokenTarget = userTokenEdges.find((e) =>
      cfgKeys.some((c) => c.id === e.target && c.qualifiedName === 'app.cache.name.user-token'),
    );
    expect(userTokenTarget, '@Value should reference the YAML leaf key').toBeDefined();

    // Default-value form `${k:default}` — strip the `:default` and bind the key.
    const enabledBind = valueBindings.find((n) => n.name === 'app.cache.enabled');
    expect(enabledBind).toBeDefined();
    expect(cg.getOutgoingEdges(enabledBind!.id).some((e) => {
      const t = cfgByQn('app.cache.enabled');
      return t && e.target === t.id;
    })).toBe(true);

    // Relaxed binding: `app.retryCount` (camel) -> `app.retry-count` (kebab).
    const retryBind = valueBindings.find((n) => n.name === 'app.retryCount');
    expect(retryBind).toBeDefined();
    expect(cg.getOutgoingEdges(retryBind!.id).some((e) => {
      const t = cfgByQn('app.retry-count');
      return t && e.target === t.id;
    })).toBe(true);

    // @ConfigurationProperties(prefix="app.cache") -> a key under that prefix.
    const cpBindings = cg
      .getNodesByKind('constant')
      .filter((n) => n.id.startsWith('spring-cp:'));
    const cpAppCache = cpBindings.find((n) => n.name === 'app.cache');
    expect(cpAppCache).toBeDefined();
    const cpEdges = cg.getOutgoingEdges(cpAppCache!.id);
    expect(cpEdges.length).toBeGreaterThan(0);

    cg.close();
  });

  it('emits only a file node for non-MyBatis XML (pom.xml, beans.xml, log4j.xml)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-xml-non-mybatis-'));
    fs.writeFileSync(
      path.join(tmpDir, 'pom.xml'),
      '<project><groupId>x</groupId><artifactId>y</artifactId></project>\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'log4j.xml'),
      '<?xml version="1.0"?><Configuration><Loggers><Root level="info"/></Loggers></Configuration>\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    // No method nodes — non-mapper XML produces no symbols (just file rows).
    expect(cg.getNodesByKind('method').filter((n) => n.language === 'xml').length).toBe(0);
    cg.close();
  });

  it('resolves a `this.field.method()` call to a unique implementation class', async () => {
    // Standalone test of the extractor `this.` strip: even without Spring annotations,
    // `this.svc.run()` where `svc` is typed as a concrete class should route to that
    // class's method. This is the general Java fix, Spring is only one consumer.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-this-field-'));
    fs.writeFileSync(
      path.join(tmpDir, 'App.java'),
      'class Svc { public void run() { } }\n' +
        'class App {\n' +
        '  private Svc svc;\n' +
        '  public void go() { this.svc.run(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const go = methods.find((m) => m.name === 'go');
    const run = methods.find((m) => m.name === 'run');
    expect(go && run).toBeTruthy();

    const edge = cg.getOutgoingEdges(go!.id).find((e) => e.target === run!.id);
    expect(edge, '`this.svc.run()` should resolve to Svc.run').toBeDefined();

    cg.close();
  });
});

describe('JVM FQN imports — end-to-end', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves a Kotlin import when the file name differs from the class name', async () => {
    // Bar lives in Models.kt — the filesystem-based Java-style path lookup
    // (com/example/Bar.kt) misses this; only FQN-via-qualifiedName finds it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Models.kt'),
      'package com.example\n\nclass Bar {\n  fun greet(): String = "hi"\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.Bar\n\nclass App {\n  fun run() { Bar().greet() }\n}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const bar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::Bar');
    expect(bar, 'Bar should be extracted with package-qualified name').toBeDefined();

    const importNode = cg.getNodesByKind('import').find((n) => n.name === 'com.example.Bar');
    expect(importNode, 'import statement node should exist').toBeDefined();

    // The imports edge may originate from the import node OR from a parent
    // scope (file / namespace) — accept either, but require that an
    // imports-kind edge to Bar exists.
    const reachesBar = cg
      .getIncomingEdges(bar!.id)
      .find((e) => e.kind === 'imports');
    expect(reachesBar, 'an imports edge should resolve to Bar via FQN').toBeDefined();

    cg.close();
  });

  it('resolves a Kotlin top-level function import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Utils.kt'),
      'package com.example\n\nfun util(): Int = 42\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.util\n\nfun main() { util() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const util = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'com.example::util');
    expect(util, 'top-level util() should be extracted under com.example').toBeDefined();

    const edge = cg.getIncomingEdges(util!.id).find((e) => e.kind === 'imports');
    expect(edge, 'imports edge should reach the top-level function by FQN').toBeDefined();
  });

  it('resolves cross-language: Kotlin importing a Java class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'JavaBar.java'),
      'package com.example;\n\npublic class JavaBar {\n  public String greet() { return "hi"; }\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Caller.kt'),
      'package com.example.app\n\nimport com.example.JavaBar\n\nfun main() { JavaBar().greet() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const javaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::JavaBar');
    expect(javaBar, 'JavaBar should be extracted under com.example regardless of language').toBeDefined();

    const edge = cg.getIncomingEdges(javaBar!.id).find((e) => e.kind === 'imports');
    expect(edge, 'Kotlin caller should resolve its import to the Java class').toBeDefined();
  });

  it('disambiguates a class-name collision across packages', async () => {
    // Two `Bar` classes in different packages — each importer should reach
    // ITS Bar, not the other one. This is the central failure mode that
    // name-matcher alone cannot disambiguate.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'AlphaBar.kt'),
      'package com.example.alpha\n\nclass Bar { fun who() = "alpha" }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'BetaBar.kt'),
      'package com.example.beta\n\nclass Bar { fun who() = "beta" }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'CallerA.kt'),
      'package app\n\nimport com.example.alpha.Bar\n\nfun a() { Bar().who() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'CallerB.kt'),
      'package app\n\nimport com.example.beta.Bar\n\nfun b() { Bar().who() }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const alphaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.alpha::Bar');
    const betaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.beta::Bar');
    expect(alphaBar).toBeDefined();
    expect(betaBar).toBeDefined();
    expect(alphaBar!.id).not.toBe(betaBar!.id);

    // Each Bar receives exactly one imports edge — from its own caller.
    const alphaIncoming = cg.getIncomingEdges(alphaBar!.id).filter((e) => e.kind === 'imports');
    const betaIncoming = cg.getIncomingEdges(betaBar!.id).filter((e) => e.kind === 'imports');
    expect(alphaIncoming.length).toBeGreaterThan(0);
    expect(betaIncoming.length).toBeGreaterThan(0);

    // Sanity: the edges don't cross — alpha's incoming sources don't include
    // beta's filePath and vice versa.
    const sourceFiles = (edges: typeof alphaIncoming) =>
      edges.map((e) => cg.getNode(e.source)?.filePath).filter(Boolean);
    expect(sourceFiles(alphaIncoming).some((p) => p?.includes('CallerA.kt'))).toBe(true);
    expect(sourceFiles(betaIncoming).some((p) => p?.includes('CallerB.kt'))).toBe(true);
  });
});

describe('Java anonymous-class override synthesis — end-to-end', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges an abstract base method to overrides inside `new Base() { ... }`', async () => {
    // Mirrors guava Splitter: a factory returns `new BaseIter() {
    // @Override int separatorStart(...) { ... } }`. Without anon-class
    // extraction the override is invisible — Phase 5.5 interface-impl
    // has no class to bridge — and an agent investigating `BaseIter.separatorStart`
    // can't see its real implementation without reading the file.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anon-java-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Splitter.java'),
      'package com.example;\n' +
        '\n' +
        'abstract class BaseIter {\n' +
        '  abstract int separatorStart(int start);\n' +
        '}\n' +
        '\n' +
        'public class Splitter {\n' +
        '  public BaseIter make() {\n' +
        '    return new BaseIter() {\n' +
        '      @Override\n' +
        '      int separatorStart(int start) { return start + 1; }\n' +
        '    };\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // The anon class is extracted and contains the override.
    const anonClass = cg
      .getNodesByKind('class')
      .find((n) => /BaseIter\$anon@/.test(n.name));
    expect(anonClass, 'anonymous BaseIter subclass should be a class node').toBeDefined();

    const baseAbstract = cg
      .getNodesByKind('method')
      .find((n) => n.qualifiedName === 'com.example::BaseIter::separatorStart');
    const anonOverride = cg
      .getNodesByKind('method')
      .find(
        (n) =>
          n.name === 'separatorStart' &&
          n.qualifiedName.includes('$anon@') &&
          n.qualifiedName.startsWith('com.example::Splitter::make::')
      );
    expect(baseAbstract, 'base abstract method should be in the graph').toBeDefined();
    expect(anonOverride, 'anon-class override should be in the graph').toBeDefined();

    // Phase 5.5 interface-impl: the abstract method has a synthesized
    // `calls` edge to the anon override. Without this hop the agent
    // would have to Read the file to discover the implementation.
    const synthEdge = cg
      .getOutgoingEdges(baseAbstract!.id)
      .find((e) => e.target === anonOverride!.id && e.kind === 'calls');
    expect(synthEdge, 'BaseIter.separatorStart should bridge to anon.separatorStart').toBeDefined();
    expect(synthEdge!.provenance).toBe('heuristic');
    expect((synthEdge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe(
      'interface-impl'
    );

    cg.close();
  });
});
describe('Angular end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes NgModule declarations / imports / providers edges to their target classes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-ngmodule-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'ng-fixture',
        dependencies: { '@angular/core': '17.0.0', '@angular/common': '17.0.0' },
      })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/bookmark.service.ts'),
      `import { Injectable } from '@angular/core';\n` +
        `@Injectable({ providedIn: 'root' })\n` +
        `export class BookmarkService {\n` +
        `  list() { return []; }\n` +
        `}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/bookmarks.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-bookmarks', template: '<div>x</div>' })\n` +
        `export class BookmarksComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/shared.module.ts'),
      `import { NgModule } from '@angular/core';\n` +
        `@NgModule({})\n` +
        `export class SharedModule {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/bookmarks.module.ts'),
      `import { NgModule } from '@angular/core';\n` +
        `import { BookmarksComponent } from './bookmarks.component';\n` +
        `import { BookmarkService } from './bookmark.service';\n` +
        `import { SharedModule } from './shared.module';\n` +
        `@NgModule({\n` +
        `  declarations: [BookmarksComponent],\n` +
        `  imports: [SharedModule],\n` +
        `  providers: [BookmarkService],\n` +
        `})\n` +
        `export class BookmarksModule {}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const classes = cg.getNodesByKind('class');
    const bookmarksModule = classes.find((n) => n.name === 'BookmarksModule');
    const bookmarksComponent = classes.find((n) => n.name === 'BookmarksComponent');
    const bookmarkService = classes.find((n) => n.name === 'BookmarkService');
    const sharedModule = classes.find((n) => n.name === 'SharedModule');
    expect(bookmarksModule, 'BookmarksModule class node').toBeDefined();
    expect(bookmarksComponent, 'BookmarksComponent class node').toBeDefined();
    expect(bookmarkService, 'BookmarkService class node').toBeDefined();
    expect(sharedModule, 'SharedModule class node').toBeDefined();

    const outgoing = cg.getOutgoingEdges(bookmarksModule!.id);
    const synthesized = outgoing.filter((e) => e.provenance === 'heuristic');

    const declares = synthesized.find((e) => e.target === bookmarksComponent!.id);
    expect(declares, 'BookmarksModule → BookmarksComponent (declarations)').toBeDefined();
    expect(declares!.metadata?.synthesizedBy).toBe('angular-declarations');

    const imports = synthesized.find((e) => e.target === sharedModule!.id);
    expect(imports, 'BookmarksModule → SharedModule (imports)').toBeDefined();
    expect(imports!.metadata?.synthesizedBy).toBe('angular-imports');

    const providers = synthesized.find((e) => e.target === bookmarkService!.id);
    expect(providers, 'BookmarksModule → BookmarkService (providers)').toBeDefined();
    expect(providers!.metadata?.synthesizedBy).toBe('angular-providers');

    cg.close();
  });

  it('synthesizes <child-selector> → component edges from inline templates', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-selector-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'ng-sel', dependencies: { '@angular/core': '17.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/icon.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-icon', standalone: true, template: '<span></span>' })\n` +
        `export class IconComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/card.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `import { IconComponent } from './icon.component';\n` +
        `@Component({\n` +
        `  selector: 'app-card', standalone: true, imports: [IconComponent],\n` +
        `  template: '<div class="card"><app-icon></app-icon></div>',\n` +
        `})\n` +
        `export class CardComponent {}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const card = cg.getNodesByKind('class').find((n) => n.name === 'CardComponent');
    const icon = cg.getNodesByKind('class').find((n) => n.name === 'IconComponent');
    expect(card && icon).toBeTruthy();

    const sel = cg
      .getOutgoingEdges(card!.id)
      .find((e) => e.target === icon!.id && e.metadata?.synthesizedBy === 'angular-selector');
    expect(sel, 'CardComponent → IconComponent via <app-icon> in template').toBeDefined();
    expect(sel!.metadata?.via).toBe('app-icon');

    cg.close();
  });

  it('synthesizes templateUrl-based selector edges (.html sibling)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-tplurl-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'ng-tplurl', dependencies: { '@angular/core': '17.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/badge.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-badge', standalone: true, template: '<i></i>' })\n` +
        `export class BadgeComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/header.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `import { BadgeComponent } from './badge.component';\n` +
        `@Component({\n` +
        `  selector: 'app-header', standalone: true, imports: [BadgeComponent],\n` +
        `  templateUrl: './header.component.html',\n` +
        `})\n` +
        `export class HeaderComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/header.component.html'),
      `<header>\n  <h1>App</h1>\n  <app-badge></app-badge>\n</header>\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const header = cg.getNodesByKind('class').find((n) => n.name === 'HeaderComponent');
    const badge = cg.getNodesByKind('class').find((n) => n.name === 'BadgeComponent');
    expect(header && badge).toBeTruthy();

    const sel = cg
      .getOutgoingEdges(header!.id)
      .find((e) => e.target === badge!.id && e.metadata?.synthesizedBy === 'angular-selector');
    expect(sel, 'HeaderComponent → BadgeComponent via external templateUrl').toBeDefined();

    cg.close();
  });

  it('synthesizes attribute-directive [appHighlight] selector edges', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-attr-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'ng-attr', dependencies: { '@angular/core': '17.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/highlight.directive.ts'),
      `import { Directive } from '@angular/core';\n` +
        `@Directive({ selector: '[appHighlight]', standalone: true })\n` +
        `export class HighlightDirective {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/host.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `import { HighlightDirective } from './highlight.directive';\n` +
        `@Component({\n` +
        `  selector: 'app-host', standalone: true, imports: [HighlightDirective],\n` +
        `  template: '<p appHighlight>x</p>',\n` +
        `})\n` +
        `export class HostComponent {}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const host = cg.getNodesByKind('class').find((n) => n.name === 'HostComponent');
    const dir = cg.getNodesByKind('class').find((n) => n.name === 'HighlightDirective');
    expect(host && dir).toBeTruthy();

    const sel = cg
      .getOutgoingEdges(host!.id)
      .find((e) => e.target === dir!.id && e.metadata?.synthesizedBy === 'angular-selector');
    expect(sel, 'HostComponent → HighlightDirective via [appHighlight]').toBeDefined();
    expect(sel!.metadata?.via).toBe('[appHighlight]');

    cg.close();
  });

  it('synthesizes template-binding → owner-class-member edges (event / interpolation / structural)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-tpl-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'ng-tpl', dependencies: { '@angular/core': '17.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/form.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({\n` +
        `  selector: 'app-form', standalone: true,\n` +
        `  template: \`\n` +
        `    <h2>{{ userName }}</h2>\n` +
        `    <button (click)="onSubmit()" [disabled]="isDisabled">Save</button>\n` +
        `    <li *ngFor="let item of items">{{ item }}</li>\n` +
        `  \`,\n` +
        `})\n` +
        `export class FormComponent {\n` +
        `  userName = 'alice';\n` +
        `  items: string[] = [];\n` +
        `  isDisabled = false;\n` +
        `  onSubmit() { /* ... */ }\n` +
        `}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const form = cg.getNodesByKind('class').find((n) => n.name === 'FormComponent');
    expect(form, 'FormComponent class node').toBeDefined();

    const tplEdges = cg
      .getOutgoingEdges(form!.id)
      .filter((e) => e.metadata?.synthesizedBy === 'angular-template');

    // Collect the names of every node a template edge points at. The TS extractor
    // emits class fields as `method` (per typescript.ts methodTypes) — we union
    // every reasonable member kind to avoid being too narrow.
    const memberNodes = [
      ...cg.getNodesByKind('method'),
      ...cg.getNodesByKind('property'),
      ...cg.getNodesByKind('field'),
      ...cg.getNodesByKind('variable'),
    ];
    const targetNames = new Set<string>();
    for (const e of tplEdges) {
      const node = memberNodes.find((n) => n.id === e.target);
      if (node) targetNames.add(node.name);
    }
    expect(targetNames.has('onSubmit'), 'event binding → onSubmit').toBe(true);
    expect(targetNames.has('userName'), 'interpolation → userName').toBe(true);
    expect(targetNames.has('isDisabled'), 'property binding → isDisabled').toBe(true);
    expect(targetNames.has('items'), 'structural *ngFor → items').toBe(true);

    cg.close();
  });

  it('emits route nodes and route→component / route→lazy-module references end-to-end', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-routes-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'ng-routes',
        dependencies: { '@angular/core': '17.0.0', '@angular/router': '17.0.0' },
      })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/home.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-home', standalone: true, template: '<h1>home</h1>' })\n` +
        `export class HomeComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/admin.module.ts'),
      `import { NgModule } from '@angular/core';\n` +
        `@NgModule({})\n` +
        `export class AdminModule {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/app.routes.ts'),
      `import { Routes } from '@angular/router';\n` +
        `import { HomeComponent } from './home.component';\n` +
        `export const routes: Routes = [\n` +
        `  { path: '', component: HomeComponent },\n` +
        `  { path: 'admin', loadChildren: () => import('./admin.module').then(m => m.AdminModule) },\n` +
        `];\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    const root = routes.find((n) => n.name === '/');
    const admin = routes.find((n) => n.name === '/admin');
    expect(root, '/ route node').toBeDefined();
    expect(admin, '/admin route node').toBeDefined();

    const home = cg.getNodesByKind('class').find((n) => n.name === 'HomeComponent');
    const adminMod = cg.getNodesByKind('class').find((n) => n.name === 'AdminModule');
    expect(home && adminMod).toBeTruthy();

    const rootToHome = cg.getOutgoingEdges(root!.id).find((e) => e.target === home!.id);
    expect(rootToHome, 'route(/) → HomeComponent').toBeDefined();
    expect(rootToHome!.kind).toBe('references');

    const adminToMod = cg.getOutgoingEdges(admin!.id).find((e) => e.target === adminMod!.id);
    expect(adminToMod, 'route(/admin) → AdminModule (lazy)').toBeDefined();
    expect(adminToMod!.kind).toBe('references');

    cg.close();
  });

  it('joins nested children paths into a single route URL', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-children-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'ng-children',
        dependencies: { '@angular/core': '17.0.0', '@angular/router': '17.0.0' },
      })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    for (const name of ['AdminLayout', 'UsersComponent', 'ReportsComponent']) {
      const file = name.replace(/Component$|Layout$/, (s) => s === 'Layout' ? '.layout' : '.component').toLowerCase();
      fs.writeFileSync(
        path.join(tmpDir, 'src/app', `${file}.ts`),
        `import { Component } from '@angular/core';\n` +
          `@Component({ selector: 'x', standalone: true, template: '' })\n` +
          `export class ${name} {}\n`
      );
    }
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/app.routes.ts'),
      `import { Routes } from '@angular/router';\n` +
        `import { AdminLayout } from './adminlayout.layout';\n` +
        `import { UsersComponent } from './userscomponent.component';\n` +
        `import { ReportsComponent } from './reportscomponent.component';\n` +
        `export const routes: Routes = [\n` +
        `  {\n` +
        `    path: 'admin',\n` +
        `    component: AdminLayout,\n` +
        `    children: [\n` +
        `      { path: 'users', component: UsersComponent },\n` +
        `      { path: 'reports', component: ReportsComponent },\n` +
        `    ],\n` +
        `  },\n` +
        `];\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routeNames = cg.getNodesByKind('route').map((n) => n.name).sort();
    expect(routeNames).toEqual(['/admin', '/admin/reports', '/admin/users']);

    cg.close();
  });

  it('catches Angular 17 block syntax: @if / @for / @switch', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ng17-blocks-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { '@angular/core': '17.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/list.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'l', standalone: true, template: \`\n` +
        `  @if (loading) { <p>...</p> }\n` +
        `  @for (item of products; track item.id) { <li>{{ item.name }}</li> }\n` +
        `  @switch (mode) {\n` +
        `    @case ('a') { <a></a> }\n` +
        `    @default { <b></b> }\n` +
        `  }\n` +
        `\` })\n` +
        `export class ListComponent {\n` +
        `  loading = true;\n` +
        `  products: any[] = [];\n` +
        `  mode = 'a';\n` +
        `}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    const list = cg.getNodesByKind('class').find((n) => n.name === 'ListComponent')!;
    const edges = cg.getOutgoingEdges(list.id).filter((e) => e.metadata?.synthesizedBy === 'angular-template');

    const memberNodes = [
      ...cg.getNodesByKind('method'),
      ...cg.getNodesByKind('property'),
      ...cg.getNodesByKind('field'),
      ...cg.getNodesByKind('variable'),
    ];
    const captured = new Set<string>();
    for (const e of edges) {
      const n = memberNodes.find((m) => m.id === e.target);
      if (n) captured.add(n.name);
    }
    expect(captured.has('loading'), '@if(loading) → loading').toBe(true);
    expect(captured.has('products'), '@for(item of products) → products').toBe(true);
    expect(captured.has('mode'), '@switch(mode) → mode').toBe(true);

    cg.close();
  });

  it('catches @let v18 template variable expressions', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ng18-let-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { '@angular/core': '18.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/page.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'p', standalone: true, template: \`\n` +
        `  @let displayName = user.name;\n` +
        `  <h1>{{ displayName }}</h1>\n` +
        `\` })\n` +
        `export class PageComponent {\n` +
        `  user = { name: 'a' };\n` +
        `}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    const page = cg.getNodesByKind('class').find((n) => n.name === 'PageComponent')!;
    const edges = cg.getOutgoingEdges(page.id).filter((e) => e.metadata?.synthesizedBy === 'angular-template');
    const memberNodes = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('property'), ...cg.getNodesByKind('field'), ...cg.getNodesByKind('variable')];
    const captured = new Set<string>();
    for (const e of edges) {
      const n = memberNodes.find((m) => m.id === e.target);
      if (n) captured.add(n.name);
    }
    // `user` is the only class member referenced (displayName is a template-local).
    expect(captured.has('user'), '@let displayName = user.name → user').toBe(true);

    cg.close();
  });

  it('emits route → guard / resolver references for canActivate / canMatch / resolve', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ng-guards-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'p',
        dependencies: { '@angular/core': '17.0.0', '@angular/router': '17.0.0' },
      })
    );
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/auth.guard.ts'),
      `import { Injectable } from '@angular/core';\n` +
        `@Injectable({ providedIn: 'root' })\n` +
        `export class AuthGuard { canActivate() { return true; } }\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/role.guard.ts'),
      `import { Injectable } from '@angular/core';\n` +
        `@Injectable({ providedIn: 'root' })\n` +
        `export class RoleGuard { canActivate() { return true; } }\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/user.resolver.ts'),
      `import { Injectable } from '@angular/core';\n` +
        `@Injectable({ providedIn: 'root' })\n` +
        `export class UserResolver { resolve() { return null; } }\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/home.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'h', standalone: true, template: '' })\n` +
        `export class HomeComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app.routes.ts'),
      `import { Routes } from '@angular/router';\n` +
        `import { HomeComponent } from './home.component';\n` +
        `import { AuthGuard } from './auth.guard';\n` +
        `import { RoleGuard } from './role.guard';\n` +
        `import { UserResolver } from './user.resolver';\n` +
        `export const routes: Routes = [\n` +
        `  {\n` +
        `    path: 'home',\n` +
        `    component: HomeComponent,\n` +
        `    canActivate: [AuthGuard, RoleGuard],\n` +
        `    resolve: { user: UserResolver },\n` +
        `  },\n` +
        `];\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const route = cg.getNodesByKind('route').find((n) => n.name === '/home')!;
    const authGuard = cg.getNodesByKind('class').find((n) => n.name === 'AuthGuard')!;
    const roleGuard = cg.getNodesByKind('class').find((n) => n.name === 'RoleGuard')!;
    const userResolver = cg.getNodesByKind('class').find((n) => n.name === 'UserResolver')!;

    const out = cg.getOutgoingEdges(route.id);
    expect(out.find((e) => e.target === authGuard.id), 'route → AuthGuard').toBeDefined();
    expect(out.find((e) => e.target === roleGuard.id), 'route → RoleGuard').toBeDefined();
    expect(out.find((e) => e.target === userResolver.id), 'route → UserResolver').toBeDefined();

    // impact-style query: AuthGuard should know it's used by /home.
    expect(cg.getCallers(authGuard.id).length, 'callers(AuthGuard) ≥ 1').toBeGreaterThanOrEqual(1);

    cg.close();
  });

  it('synthesizes standalone-component imports edges (Angular v17+ shape)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-standalone-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'ng-standalone-fixture',
        dependencies: { '@angular/core': '17.0.0' },
      })
    );
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/icon.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-icon', standalone: true, template: '<span></span>' })\n` +
        `export class IconComponent {}\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/app/page.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `import { IconComponent } from './icon.component';\n` +
        `@Component({\n` +
        `  selector: 'app-page', standalone: true,\n` +
        `  imports: [IconComponent],\n` +
        `  template: '<app-icon></app-icon>',\n` +
        `})\n` +
        `export class PageComponent {}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const classes = cg.getNodesByKind('class');
    const page = classes.find((n) => n.name === 'PageComponent');
    const icon = classes.find((n) => n.name === 'IconComponent');
    expect(page).toBeDefined();
    expect(icon).toBeDefined();

    const edge = cg
      .getOutgoingEdges(page!.id)
      .find((e) => e.target === icon!.id && e.provenance === 'heuristic');
    expect(edge, 'PageComponent → IconComponent (standalone imports)').toBeDefined();
    expect(edge!.metadata?.synthesizedBy).toBe('angular-imports');

    cg.close();
  });
});
