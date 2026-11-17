/**
 * Which of several Ruby classes of one name a bare constant means. Ruby's
 * lookup finds it from where it is written: the namespaces around it, then
 * the ancestors of the innermost one, then the top level. And a test suite's
 * classes exist only in that suite's runs: rails' activemodel tests load their
 * own `Topic`, never activerecord's `Topic < ActiveRecord::Base`, whose
 * `validates_length_of` they took. A reference to the constant and a call on
 * it choose the same class.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'activemodel/lib/active_model/validations.rb': `module ActiveModel
  module Validations
    extend ActiveSupport::Concern

    included do
      extend HelperMethods
    end

    module ClassMethods
      def validates_with(*args)
        args
      end
    end

    module HelperMethods
      def validates_length_of(*attr_names)
        attr_names
      end
    end

    def valid?
      true
    end
  end
end
`,
  'activemodel/test/models/topic.rb': `class Topic
  include ActiveModel::Validations
end
`,
  'activemodel/test/cases/length_validation_test.rb': `require "models/topic"

class LengthValidationTest
  def test_length
    Topic.validates_length_of(:title, is: 5)
    Topic.validates_with(:title)
  end
end
`,
  'activerecord/lib/active_record/validations.rb': `module ActiveRecord
  module Validations
    module ClassMethods
      def validates_length_of(*attr_names)
        attr_names
      end
    end

    def valid?
      true
    end
  end

  class Base
    extend Validations::ClassMethods
    include Validations
  end
end
`,
  'activerecord/test/models/topic.rb': `class Topic < ActiveRecord::Base
end
`,
  'activerecord/test/cases/length_validation_test.rb': `require "models/topic"

class ActiveRecordLengthTest
  def test_length
    Topic.validates_length_of(:title, is: 5)
  end
end
`,
  // A namesake nested in a test, nearer by folder to the other tests than
  // the top-level `Topic`.
  'activerecord/test/cases/serialized_attribute_test.rb': `class SerializedAttributeTest
  class Topic < ActiveRecord::Base
    def self.serialized
      true
    end
  end

  def test_nested
    Topic.serialized
  end
end
`,
  // A constant of a module the class includes.
  'activerecord/test/cases/migration/helper.rb': `module Migration
  module TestHelper
    class TestModel < ActiveRecord::Base
      def self.reset_column_information
        nil
      end
    end
  end
end
`,
  'activerecord/test/cases/migration/compatibility_test.rb': `module Migration
  class CompatibilityTest
    class TestModel < ActiveRecord::Base
      def self.reset_column_information
        nil
      end
    end
  end
end
`,
  'activerecord/test/cases/migration/column_attributes_test.rb': `module Migration
  class ColumnAttributesTest
    include TestHelper

    def test_reset
      TestModel.reset_column_information
    end
  end
end
`,
  // A bare call in an instance method, with two methods of the name up the
  // class's ancestors: `Behavior#render` comes before the `RenderingHelper`
  // that `Behavior` includes.
  'actionview/lib/action_view/helpers.rb': `module ActionView
  module Helpers
    module RenderingHelper
      def render(options = {})
        options
      end
    end

    include RenderingHelper
  end
end
`,
  'actionview/lib/action_view/test_case.rb': `module ActionView
  class TestCase
    module Behavior
      include ActionView::Helpers

      def render(options = {})
        options
      end
    end

    include Behavior
  end
end
`,
  'actionview/test/template/test_case_test.rb': `module ActionView
  class TestCase
    module SharedTests
    end
  end

  class AssertionsTest < ActionView::TestCase
    def render_from_helper
      render(plain: "foo")
    end
  end
end
`,
  // A receiver named after a class, and a namesake in another suite's tests
  // that ActiveRecord answers for.
  'activerecord/lib/active_record/attribute_methods.rb': `module ActiveRecord
  module AttributeMethods
    def attributes
      {}
    end
  end

  class Base
    include AttributeMethods
  end
end
`,
  'activerecord/test/models/attachment.rb': `class Attachment < ActiveRecord::Base
end
`,
  'actiontext/lib/action_text/attachment.rb': `module ActionText
  class Attachment
    def to_html
      ""
    end
  end
end
`,
  'actiontext/lib/action_text/trix_attachment.rb': `module ActionText
  class TrixAttachment
    class << self
      def from_attributes(attributes)
        new(attributes)
      end
    end

    def initialize(attributes)
      @attributes = attributes
    end

    def attributes
      @attributes
    end
  end
end
`,
  'actiontext/test/unit/trix_attachment_test.rb': `class ActionText::TrixAttachmentTest
  def test_previewable
    assert_attachment_attribute(attachment(previewable: ""), "previewable", false)
  end

  def assert_attachment_attribute(attachment, name, value)
    attachment.attributes[name]
  end

  def attachment(**attributes)
    ActionText::TrixAttachment.from_attributes(attributes)
  end
end
`,
  // A module's own method, and a namesake in another suite's test double.
  'activerecord/lib/active_record.rb': `module ActiveRecord
  def self.after_all_transactions_commit(&block)
    yield
  end
end
`,
  'activejob/test/cases/enqueue_after_transaction_commit_test.rb': `class EnqueueAfterTransactionCommitTest
  class FakeActiveRecord
    def after_all_transactions_commit(&block)
      yield
    end
  end
end
`,
  'activerecord/test/cases/transactions_test.rb': `class TransactionTest
  def test_after_all_transactions_commit
    ActiveRecord.after_all_transactions_commit { nil }
  end
end
`,
  // A class the application defines: the test app's is nearer than a guide's
  // script, and neither runs with the library.
  'actionmailbox/app/models/action_mailbox/inbound_email/routable.rb': `module ActionMailbox
  class InboundEmail
    module Routable
      def route
        ApplicationMailbox.route self
      end
    end
  end
end
`,
  'actionmailbox/test/dummy/app/mailboxes/application_mailbox.rb': `class ApplicationMailbox
  def self.route(email)
    email
  end
end
`,
  'guides/bug_report_templates/action_mailbox.rb': `class ApplicationMailbox
  def self.route(email)
    email
  end
end
`,
  // A module a library reopens, and another suite reopens nearer.
  'activesupport/lib/active_support/i18n_railtie.rb': `module I18n
  class Railtie
  end
end
`,
  'actionmailer/spec/i18n_spec.rb': `module I18n
  def self.spec_helper
    nil
  end
end
`,
  'actionmailer/test/base_test.rb': `class MailerBaseTest
  def with_translation
    I18n.backend
  end
end
`,
  // A call on `self.class` of a name a library's test helper declares and
  // another suite's test double too.
  'activesupport/lib/active_support/testing/setup_and_teardown.rb': `module ActiveSupport
  module Testing
    module SetupAndTeardown
      module AroundCallbackSupport
        def send(*args)
          super
        end
      end
    end
  end
end
`,
  'actionpack/test/support/fake_transport.rb': `class FakeTransport
  def send(*args)
    args
  end
end
`,
  'activemodel/test/cases/teardown_test.rb': `class TeardownTest
  def teardown
    self.class.send(:remove_const, :Person)
  end
end
`,
  // A bare call production code makes, of a name a test helper declares
  // nearer to it and one other library declares farther off.
  'foo/lib/foo/runner.rb': `module Foo
  module Runner
    def self.run
      frobnicate(1)
    end
  end
end
`,
  'foo/test/support/frob_helper.rb': `module FrobHelper
  def frobnicate(x)
    x
  end
end
`,
  'bar/lib/bar/frob.rb': `module Bar
  module Frob
    def frobnicate(x)
      x
    end
  end
end
`,
  // A library's own code in a folder named `test`.
  'railties/lib/rails/commands/test/test_command.rb': `module Rails
  module Command
    class TestCommand
      def self.perform(*args)
        args
      end
    end
  end
end
`,
  'railties/test/commands/test_test.rb': `class TestCommandTest
  def test_perform
    Rails::Command::TestCommand.perform(1)
  end
end
`,
  // A suite with no class of the name.
  'railties/test/engine_test.rb': `class EngineTest
  def test_topic
    Topic.validates_length_of(:title)
  end
end
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-namesakes-'));
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

type Db = { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string; f: string; m: string | null }> } } };

function targets(kind: 'calls' | 'references', caller: string, ref: string): string[] {
  const db = (cg as unknown as { db: Db }).db;
  const rows = db.getDb().prepare(`
    SELECT t.qualified_name q, t.file_path f, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = ? AND s.qualified_name = ?`).all(kind, caller);
  return [...new Set(rows.filter((r) => kind === 'references' ? r.q.split('::').pop() === ref : JSON.parse(r.m ?? '{}').refName === ref)
    .map((r) => `${r.q} @${r.f}`))];
}

describe('a call on a Ruby class several test suites declare', () => {
  it('reaches what the calling suite\'s class answers, through its concern\'s included block', () => {
    expect(targets('calls', 'LengthValidationTest::test_length', 'Topic.validates_length_of'))
      .toEqual(['ActiveModel::Validations::HelperMethods::validates_length_of @activemodel/lib/active_model/validations.rb']);
    expect(targets('calls', 'LengthValidationTest::test_length', 'Topic.validates_with'))
      .toEqual(['ActiveModel::Validations::ClassMethods::validates_with @activemodel/lib/active_model/validations.rb']);
  });

  it('still reaches the other suite\'s ancestors from that suite', () => {
    expect(targets('calls', 'ActiveRecordLengthTest::test_length', 'Topic.validates_length_of'))
      .toEqual(['ActiveRecord::Validations::ClassMethods::validates_length_of @activerecord/lib/active_record/validations.rb']);
  });

  it('reaches nothing from a suite that declares no such class', () => {
    expect(targets('calls', 'EngineTest::test_topic', 'Topic.validates_length_of')).toEqual([]);
  });

  it('reaches a library\'s code in a `lib/…/test/` folder, which is no suite', () => {
    expect(targets('calls', 'TestCommandTest::test_perform', 'Rails::Command::TestCommand.perform'))
      .toEqual(['Rails::Command::TestCommand::perform @railties/lib/rails/commands/test/test_command.rb']);
  });
});

describe('a bare Ruby constant', () => {
  it('is the class nested around it, else the top-level one, whatever is nearer by folder', () => {
    expect(targets('calls', 'SerializedAttributeTest::test_nested', 'Topic.serialized'))
      .toEqual(['SerializedAttributeTest::Topic::serialized @activerecord/test/cases/serialized_attribute_test.rb']);
    expect(targets('references', 'ActiveRecordLengthTest::test_length', 'Topic'))
      .toEqual(['Topic @activerecord/test/models/topic.rb']);
  });

  it('is a constant of a module its class includes', () => {
    expect(targets('calls', 'Migration::ColumnAttributesTest::test_reset', 'TestModel.reset_column_information'))
      .toEqual(['Migration::TestHelper::TestModel::reset_column_information @activerecord/test/cases/migration/helper.rb']);
  });

  it('is referenced as the class a call on it reaches', () => {
    expect(targets('references', 'LengthValidationTest::test_length', 'Topic'))
      .toEqual(['Topic @activemodel/test/models/topic.rb']);
    expect(targets('references', 'EngineTest::test_topic', 'Topic')).toEqual([]);
  });

  it('is no class of a program the reference may not be part of', () => {
    expect(targets('references', 'ActionMailbox::InboundEmail::Routable::route', 'ApplicationMailbox')).toEqual([]);
  });

  it('is the library\'s module, though another suite reopens it nearer', () => {
    expect(targets('references', 'MailerBaseTest::with_translation', 'I18n'))
      .toEqual(['I18n @activesupport/lib/active_support/i18n_railtie.rb']);
  });
});

describe('a Ruby receiver named after a class', () => {
  it('is no class of another test suite', () => {
    expect(targets('calls', 'ActionText::TrixAttachmentTest::assert_attachment_attribute', 'attachment.attributes'))
      .not.toContain('ActiveRecord::AttributeMethods::attributes @activerecord/lib/active_record/attribute_methods.rb');
  });

  it('still reaches the one method of the name it names once another suite\'s is out', () => {
    expect(targets('calls', 'TransactionTest::test_after_all_transactions_commit', 'ActiveRecord.after_all_transactions_commit'))
      .toEqual(['ActiveRecord::after_all_transactions_commit @activerecord/lib/active_record.rb']);
  });

  it('is no guess at the one method of the name left once another suite\'s is out', () => {
    expect(targets('calls', 'TeardownTest::teardown', 'self.class.send')).toEqual([]);
  });
});

describe('a bare Ruby call nothing types', () => {
  it('is no guess at the one method left when a test suite\'s are out of the running', () => {
    expect(targets('calls', 'Foo::Runner::run', 'frobnicate')).toEqual([]);
  });
});

describe('a bare Ruby call in an instance method', () => {
  it('runs the method the first of the class\'s ancestors declares', () => {
    expect(targets('calls', 'ActionView::AssertionsTest::render_from_helper', 'render'))
      .toEqual(['ActionView::TestCase::Behavior::render @actionview/lib/action_view/test_case.rb']);
  });
});
