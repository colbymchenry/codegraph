# frozen_string_literal: true
require "json"
require "sidekiq/fetch"
require_relative "../shared/helper"
require %q(pct/lib)
require :sym_form
Kernel.require "some/lib"
require "interp/#{RUBY_VERSION}"

TOP_LIMIT = 100
RETRY_MAX = 3
lower_conf = "x"
top_var = compute_default
m1, m2 = 3, 4
counter ||= 0
@ivar_top = 1
$global_top = 2
X_WITH_NEW = Widget.new
WORDS = %w[alpha beta]

module Outer
  module Inner
    class Deep < Base
      before_action :hooked
      def greet; end
    end
  end
end

module A::B
  A_B_CONST = 5
end

class TopDoc; end

class Bare; end

class A::B::C
  def compact_method; end
end

class ExprSuper < Struct.new(:a)
end

class ScopedSuper < A::B::C
end

# Class docs line one.
# Class docs line two.
class Documented < BaseThing
  include Comparable
  include Helpers, Sortable
  extend self
  prepend Memoizer
  Foo.include Bar
  include dynamic_mod()

  CLASS_LIMIT = 9
  not_extracted = 1

  attr_accessor :name, :email
  attr_reader :created_at
  alias_method :handle, :name
  alias fast_name name

  define_method :dyn do
    invisible_call
  end

  before_action :hooked_here
  skip_before_action :check_thing, only: [:index]
  around_create :wrap_it
  rescue_from ArgumentError, with: :render_404
  validates :name
  validate :custom_check
  helper_method :help_me
  set_callback :save, :before, :cb_sym

  def self.build(arg)
    helper_build(arg)
  end

  class << self
    def singleton_style
      reset_cache
    end
  end

  def done?; end
  def save!; end
  def value=(v); end

  def visible_before; end

  private

  def still_public_after_bare_private; end

  private :some_sym

  def now_private; end

  private def inner_public; end

  def also_private; end

  public def public_again; end

  def after_public_def; end

  protected

  def bare_protected_is_invisible_so_still_public; end

  def target_cb; end

  def wire(list, button)
    register(method(:target_cb))
    register(&method(:target_cb))
    register(method(:missing_cb))
    store = method(:target_cb)
    list.each(&:map_sym)
  end

  def calls_zoo(cb, lower, neg, other, deep, obj, h)
    reset
    compute(1)
    puts "hi"
    done? ? cleanup_now : 0
    helper unless finished?
    compute rescue nil
    self.own_method
    @name.upcase
    @@class_var.inspect
    $global.freeze
    "literal".upcase
    5.times { beep }
    [1, 2].sum
    Klass.static_call
    NS::Klass.other_call
    RETRY_MAX.times
    Widget.new
    NS::Widget.new
    lower.new
    chained.first_call.second_call
    Widget.create(cb).save
    deep&.safe_call
    neg&.!= other
    obj.attr = 1
    obj.attr2 &&= refresh
    h[:k] = 2
    puts "#{@name.upcase} interp"
    body = <<~SQL
      select #{col_name.downcase}
    SQL
    yield
    lam = lambda { inner_lambda_call }
    pr = proc { inner_proc_call }
    arrow = ->(a) { arrow_call(a) }
  end

  def flow_control(list)
    begin
      begin_stmt_call
    rescue ArgumentError => e
      rescue_stmt_call
    else
      else_stmt_call
    ensure
      ensure_stmt_call
    end
    case list
    when Array then when_then_call
    end
    while list.any? do
      while_body_call
      break
    end
    if list
      then_call
    end
  end

  def body_requires
    require "in/body"
    Kernel.require "other/lib"
  end

  def container_method
    def nested_def; end
    class InnerClass; end
    module InnerMod
      def mod_method; end
    end
    nested_def
  end

  def reader_one
    TOP_LIMIT + CLASS_LIMIT
  end

  def reader_two
    a = RETRY_MAX
    b = TOP_LIMIT
    lower_conf
  end

  def shadower
    lower_conf = "y"
    lower_conf.upcase
  end
end

# Doc for documented_fn.
# Second line.
def documented_fn; end

=begin
Block comment body.
* star line
-- dash line
=end
def block_doc_fn; end

# lost doc
private def priv_doc_fn; end

def self.top_singleton
  singleton_body_call
end

def obj.weird_singleton; end

__END__
raw data trailer here
