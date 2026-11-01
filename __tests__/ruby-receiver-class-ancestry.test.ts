/**
 * What a Ruby receiver reaches through its class's ancestors. They are read
 * the way Ruby reads them: the superclass and the mixins found by constant
 * lookup, the module mixed in last asked first, and a class's own class
 * methods apart from what its instances answer. By bare names, `ActiveRecord::Base`
 * was every `Base` in rails: `human.name` went to Journey's `Node#name` and
 * `company.has_attribute?` to the `has_attribute?` of a `ClassMethods` module.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  // A class's methods from a nested module it includes.
  'lib/mapper.rb': `module ActionDispatch
  module Routing
    class Mapper
      module HttpHelpers
        def get(*paths)
          paths
        end
      end

      module Base
        def match(*paths)
          paths
        end
      end

      include Base
      include HttpHelpers
    end
  end
end
`,
  'test/routes_test.rb': `class RoutesTest
  attr_reader :mapper

  def setup
    @mapper = ActionDispatch::Routing::Mapper.new
  end

  def test_get
    mapper.get "/hello"
    mapper.match "/hello"
  end
end
`,
  // A namesake of the superclass.
  'lib/journey.rb': `module ActionDispatch
  module Journey
    class Client
      def get(path)
        path
      end

      def match(path)
        path
      end
    end

    module Nodes
      class Node
        def name
          "node"
        end
      end

      class Base < Node
      end
    end
  end
end
`,
  'lib/active_record.rb': `module ActiveSupport
  module Concern
  end
end

module ActiveRecord
  module Persistence
    extend ActiveSupport::Concern

    module ClassMethods
      def create(attributes)
        new
      end
    end

    def save
      true
    end

    def save!
      true
    end
  end

  module Reflection
    def self.create(macro, name)
      macro
    end
  end

  module Transactions
    extend ActiveSupport::Concern

    def save
      super
    end
  end

  module Querying
    def count_by_sql(sql)
      sql
    end
  end

  module AttributeMethods
    extend ActiveSupport::Concern

    module ClassMethods
      def has_attribute?(attr_name)
        true
      end
    end

    def has_attribute?(attr_name)
      false
    end
  end

  module QueryCache
    module ClassMethods
      def cache
        yield
      end
    end
  end

  class Base
    extend QueryCache::ClassMethods
    extend Querying
    include Persistence
    include Reflection
    include Transactions
    include AttributeMethods
  end
end
`,
  'test/models.rb': `class Human < ActiveRecord::Base
end

class Company < ActiveRecord::Base
end

class Holder
  class Inner
    include ActiveRecord::Transactions
  end
end
`,
  'test/base_test.rb': `class BaseTest
  def test_name
    human = Human.new
    human.name
  end

  def test_named_receiver(human)
    human.name
  end

  def test_has_attribute
    company = Company.new
    company.has_attribute?("id")
  end

  def test_mixed_in_last(company)
    company.save
  end

  def test_only_mixin(company)
    company.save!
  end

  def test_class_method
    Company.create(name: "x")
    Company.count_by_sql("x")
  end

  def test_nested_mixin(holder)
    holder.save
  end
end
`,
  // What a method of the class around the call hands back.
  'lib/jar.rb': `module ActionDispatch
  class Cookies
    module ChainedCookieJars
      def signed
        self
      end
    end

    class CookieJar
      include ChainedCookieJars

      def self.build(request, cookies)
        jar = new(request)
        jar.update(cookies)
        jar
      end

      def delete(name)
        name
      end
    end
  end

  module TestProcess
    def cookies
      @cookie_jar ||= Cookies::CookieJar.build(@request, @request.cookies)
    end

    def session
      @request.session
    end

    def fresh_jar
      Cookies::CookieJar.new(@request)
    end

    def open_for(request)
      Cookies::CookieJar.new(request)
    end
  end
end

class TestCase
  include ActionDispatch::TestProcess
end

class Mailbox
  def delete(name)
    name
  end
end
`,
  'test/cookies_test.rb': `class CookiesTest < TestCase
  class Session
    def clear
    end
  end

  def test_signed
    cookies.signed[:favorite]
    cookies.delete(:favorite)
  end

  def test_shadowed(cookies)
    cookies.delete(:favorite)
  end

  def test_block
    [].each { |cookies| cookies.delete(:favorite) }
  end

  def test_assigned
    cookies = {}
    cookies.delete(:favorite)
  end

  def test_unmade
    session.clear
  end

  def test_fresh
    fresh_jar.delete(:favorite)
  end

  def test_argument
    open_for.delete(:favorite)
  end
end
`,
  // A core class's method names.
  'lib/cookies.rb': `module Sinatra
  module Cookies
    class Jar
      def empty?
        true
      end
    end
  end
end
`,
  'lib/tossing.rb': `class CookieTossing
  def bad_cookies
    @bad_cookies ||= []
  end

  def accepts?
    bad_cookies.empty?
  end
end
`,
  'lib/server.rb': `module IntegrationHelper
  class BaseServer
    def installed?
      true
    end
  end
end
`,
  'lib/record.rb': `module Records
  module ActiveRecord
    module Persistence
      def new_record?
        true
      end
    end
  end
end
`,
  'lib/checks.rb': `class Checks
  def run(server, record)
    server.installed?
    record.new_record?
  end
end
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-ancestry-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function callees(caller: string, ref: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string; m: string | null }> } } } }).db;
  const rows = db.getDb().prepare(`
    SELECT t.qualified_name q, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(caller);
  return rows.filter((r) => JSON.parse(r.m ?? '{}').refName === ref).map((r) => r.q);
}

describe('a Ruby receiver named after a class', () => {
  it('reaches a module the class includes, however the module is written', () => {
    expect(callees('RoutesTest::test_get', 'mapper.get')).toEqual(['ActionDispatch::Routing::Mapper::HttpHelpers::get']);
    expect(callees('RoutesTest::test_get', 'mapper.match')).toEqual(['ActionDispatch::Routing::Mapper::Base::match']);
  });

  it('reaches no namesake of the superclass', () => {
    expect(callees('BaseTest::test_name', 'human.name')).toEqual([]);
    expect(callees('BaseTest::test_named_receiver', 'human.name')).toEqual([]);
  });

  it('asks the module mixed in last first', () => {
    expect(callees('BaseTest::test_mixed_in_last', 'company.save')).toEqual(['ActiveRecord::Transactions::save']);
    expect(callees('BaseTest::test_only_mixin', 'company.save!')).toEqual(['ActiveRecord::Persistence::save!']);
  });

  it('reads a class nested in another as that class alone', () => {
    expect(callees('BaseTest::test_nested_mixin', 'holder.save')).toEqual([]);
  });
});

describe('a Ruby value of a known class', () => {
  it('answers with an instance method, not one a ClassMethods module gives the class', () => {
    expect(callees('BaseTest::test_has_attribute', 'company.has_attribute?')).toEqual(['ActiveRecord::AttributeMethods::has_attribute?']);
  });
});

describe('a call on a Ruby class', () => {
  it('reaches what a Concern gives it, and what it extends', () => {
    expect(callees('BaseTest::test_class_method', 'Company.create')).toEqual(['ActiveRecord::Persistence::ClassMethods::create']);
    expect(callees('BaseTest::test_class_method', 'Company.count_by_sql')).toEqual(['ActiveRecord::Querying::count_by_sql']);
  });
});

describe('a bare Ruby name of a method that hands back one class', () => {
  it('calls that class, through what its ancestry includes', () => {
    expect(callees('CookiesTest::test_signed', 'cookies.signed')).toEqual(['ActionDispatch::Cookies::ChainedCookieJars::signed']);
    expect(callees('CookiesTest::test_signed', 'cookies.delete')).toEqual(['ActionDispatch::Cookies::CookieJar::delete']);
    expect(callees('CookiesTest::test_fresh', 'fresh_jar.delete')).toEqual(['ActionDispatch::Cookies::CookieJar::delete']);
  });

  it('says nothing of a name the calling method binds itself', () => {
    expect(callees('CookiesTest::test_shadowed', 'cookies.delete')).toEqual([]);
    expect(callees('CookiesTest::test_block', 'cookies.delete')).toEqual([]);
    expect(callees('CookiesTest::test_assigned', 'cookies.delete')).toEqual([]);
  });

  it('says nothing of a method that takes arguments, or names no class', () => {
    expect(callees('CookiesTest::test_argument', 'open_for.delete')).toEqual([]);
    expect(callees('CookiesTest::test_unmade', 'session.clear')).toEqual(['CookiesTest::Session::clear']);
  });
});

describe('a Ruby core method name on a value', () => {
  it('is no method of a class the receiver shares a module word with', () => {
    expect(callees('CookieTossing::accepts?', 'bad_cookies.empty?')).toEqual([]);
  });

  it('leaves other predicates to the receiver word', () => {
    expect(callees('Checks::run', 'server.installed?')).toEqual(['IntegrationHelper::BaseServer::installed?']);
    expect(callees('Checks::run', 'record.new_record?')).toEqual(['Records::ActiveRecord::Persistence::new_record?']);
  });
});
