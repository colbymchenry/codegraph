import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';

// Robustness of the MyBatis / iBatis mapper extractor. Four shapes the regex
// scanner previously mishandled, all reported and diagnosed by @ESPINS in #1182:
//   1. single-quoted attribute values,
//   2. tags that live inside XML comments,
//   3. iBatis 2 `<sqlMap>` files (zero statement coverage before),
//   4. two statements that share a qualifiedName *and* a start line colliding
//      on the node id (silent statement loss at the DB layer).
// The quoting and comment suites below follow @ESPINS's fix-mybatis-quotes-comments
// branch; the iBatis and collision suites cover the regex-only path taken here
// (no parser dependency).

const methodNodes = (xml: string, file = 'FooMapper.xml') =>
  extractFromSource(file, xml).nodes.filter((n) => n.kind === 'method');

const methodNames = (xml: string, file = 'FooMapper.xml') =>
  methodNodes(xml, file).map((n) => n.qualifiedName);

describe('MyBatis extractor — attribute quoting', () => {
  it('accepts a single-quoted namespace', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      '<select id="getById">SELECT 1</select></mapper>';
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });

  it('accepts a single-quoted statement id', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      "<select id='getById'>SELECT 1</select></mapper>";
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });

  it('accepts a single-quoted <include refid>', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<sql id="cols">id, name</sql>' +
      "<select id='getById'>SELECT <include refid='cols'/> FROM t</select>" +
      '</mapper>';
    const refs = extractFromSource('FooMapper.xml', xml).unresolvedReferences.map(
      (r) => r.referenceName
    );
    expect(refs).toContain('com.example.FooMapper::cols');
  });

  it('reads single-quoted resultType / parameterType into the signature', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      "<select id='getById' resultType='User' parameterType='int'>SELECT 1</select>" +
      '</mapper>';
    const sig = methodNodes(xml).find((n) => n.name === 'getById')?.signature;
    expect(sig).toContain('result=User');
    expect(sig).toContain('param=int');
  });

  it('handles mixed single- and double-quoted attributes in one file', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      "<select id='getById' resultType='User'>SELECT 1</select>" +
      '<update id="touch" parameterType="User">UPDATE t SET x=1</update>' +
      '</mapper>';
    expect(methodNames(xml)).toEqual([
      'com.example.FooMapper::getById',
      'com.example.FooMapper::touch',
    ]);
  });

  it('still accepts double-quoted attributes (regression guard)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT 1</select></mapper>';
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });
});

describe('MyBatis extractor — XML comments', () => {
  const result = (xml: string) => extractFromSource('FooMapper.xml', xml);

  it('does not emit a node for a statement inside a comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<!-- <select id="dead">SELECT 1</select> -->' +
      '<select id="live">SELECT 2</select></mapper>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('live');
    expect(names).not.toContain('dead');
  });

  it('does not follow an <include> inside a comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT 1 <!-- <include refid="cols"/> --></select>' +
      '</mapper>';
    const refs = result(xml).unresolvedReferences.map((r) => r.referenceName);
    expect(refs).not.toContain('com.example.FooMapper::cols');
  });

  it('keeps the correct startLine for a statement after a multi-line comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">\n' +
      '<!--\n' +
      '  a commented-out block\n' +
      '  spanning several lines\n' +
      '-->\n' +
      '<select id="getById">SELECT 1</select>\n' +
      '</mapper>\n';
    const stmt = result(xml).nodes.find((n) => n.name === 'getById');
    expect(stmt).toBeDefined();
    // The <select> is on the 6th line of the document.
    expect(stmt!.startLine).toBe(6);
  });

  it('treats <!-- and --> inside CDATA as data, not comment delimiters', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<![CDATA[<!--]]>' +
      '<select id="live">SELECT 1</select>' +
      '<![CDATA[-->]]>' +
      '</mapper>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('live');
  });

  it('does not crash on an unterminated comment (blanks to end of file)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="before">SELECT 1</select>' +
      '<!-- unterminated, swallowing a <select id="after">SELECT 2</select>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('before');
    expect(names).not.toContain('after');
  });
});

describe('MyBatis extractor — duplicate-id collision (#1182 gap 4)', () => {
  it('keeps both statements of a same-line vendor-split databaseId pair', () => {
    // Two <select>s share qualifiedName `…::findUser` AND a start line. The node
    // id previously hashed only (path, kind, qualifiedName, startLine), so both
    // hashed identically and INSERT OR REPLACE dropped one at the DB layer. The
    // extractor pushes both regardless, so the collision shows up as *identical
    // ids* here — assert the ids are now distinct.
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="findUser" databaseId="oracle">SELECT 1 FROM dual</select>' +
      '<select id="findUser" databaseId="mysql">SELECT 1</select>' +
      '</mapper>';
    const nodes = methodNodes(xml).filter((n) => n.name === 'findUser');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(2);
    // qualifiedName is intentionally unchanged (the Java↔XML bridge keys on it).
    expect(nodes.every((n) => n.qualifiedName === 'com.example.FooMapper::findUser')).toBe(true);
    // The databaseId keeps the two signatures distinguishable.
    expect(nodes.map((n) => n.signature).sort()).toEqual([
      'SELECT databaseId=mysql',
      'SELECT databaseId=oracle',
    ]);
  });
});

describe('iBatis 2 <sqlMap> coverage (#1182 gap 3)', () => {
  it('extracts statements from a namespaced <sqlMap>', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE sqlMap PUBLIC "-//iBATIS.com//DTD SQL Map 2.0//EN" "http://ibatis.apache.org/dtd/sql-map-2.dtd">\n' +
      '<sqlMap namespace="Account">\n' +
      '  <select id="getById" resultClass="Account">SELECT * FROM account WHERE id = #id#</select>\n' +
      '  <insert id="insert" parameterClass="Account">INSERT INTO account (id) VALUES (#id#)</insert>\n' +
      '</sqlMap>\n';
    expect(methodNames(xml, 'Account.xml')).toEqual(['Account::getById', 'Account::insert']);
  });

  it('splits a namespace-less DAO.method id on the last dot', () => {
    const xml =
      '<sqlMap>\n' +
      '  <select id="Account.getById" resultClass="Account">SELECT 1</select>\n' +
      '</sqlMap>\n';
    const node = methodNodes(xml, 'Account.xml').find((n) => n.name === 'getById');
    expect(node).toBeDefined();
    expect(node!.qualifiedName).toBe('Account::getById');
  });

  it('recognizes iBatis <statement> and <procedure> verbs', () => {
    const xml =
      '<sqlMap namespace="Account">' +
      '<statement id="runIt">SELECT 1</statement>' +
      '<procedure id="callIt">{ call do_it() }</procedure>' +
      '</sqlMap>';
    expect(methodNames(xml, 'Account.xml').sort()).toEqual(['Account::callIt', 'Account::runIt']);
  });

  it('resolves an <include> to a <sql> fragment inside the sqlMap', () => {
    const xml =
      '<sqlMap namespace="Account">' +
      '<sql id="cols">id, name</sql>' +
      '<select id="getById">SELECT <include refid="cols"/> FROM account</select>' +
      '</sqlMap>';
    const refs = extractFromSource('Account.xml', xml).unresolvedReferences.map(
      (r) => r.referenceName
    );
    expect(refs).toContain('Account::cols');
  });

  it('leaves the iBatis config root (<sqlMapConfig>) with no statement nodes', () => {
    const xml =
      '<sqlMapConfig>' +
      '<sqlMap resource="com/example/Account.xml"/>' +
      '</sqlMapConfig>';
    expect(methodNodes(xml, 'SqlMapConfig.xml')).toHaveLength(0);
  });
});
