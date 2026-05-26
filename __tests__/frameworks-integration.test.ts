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
