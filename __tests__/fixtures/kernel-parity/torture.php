<?php

declare(strict_types=1);

namespace App\Services;

use App\Contracts\Logger;
use App\Contracts\Cache as CacheAlias;
use Countable;
use function App\Helpers\format_id;
use const App\Config\MAX_TRIES;
use App\Models\{User, Post as PostAlias, Sub\Deep};

require 'lib/plain.php';
require_once('lib/parens.php');
include 'lib/inc.php';
include_once 'lib/inc_once.php';
require __DIR__ . '/dynamic.php';

const TOP_LEVEL_MAX = 10;

// non-ASCII before a symbol: café ünïcode line
function top_helper(?Logger $log, User|PostAlias $u, Logger&Countable $lc, (Foo&Bar)|Baz $dnf, \App\Models\User $qual, string $s, int ...$rest): UserModel
{
    top_body_call();
    return new UserModel();
}

/** Doc for Documented. */
#[Registry(param: Logger::class)]
class Documented extends BaseThing implements HasColor, \JsonSerializable
{
    use SoftDeletes, Notify\Deeper;
    use ConflictA, ConflictB {
        ConflictA::greet insteadof ConflictB;
        ConflictB::greet as protected greetB;
    }

    const MULTI_A = 1, MULTI_B = 2;
    final public const int TYPED_MAX = 5;

    public ?Logger $logger, $fallback;
    private CacheAlias|string $union;
    protected static iterable $registry;
    public readonly int $count;
    var $legacy;
    final public Foo $finalTyped;

    public function __construct(private Logger $promoted, protected string $name = 'x', ICache $plain = new NullMailer())
    {
    }

    /** Doc over attribute. */
    #[Route('/x')]
    public function withAttr(): void
    {
    }

    public static function make(): static
    {
        return new static();
    }

    public function selfRet(): self
    {
        return $this;
    }

    public function nullableRet(): ?Logger
    {
        return null;
    }

    public function unionRet(): Foo|Bar
    {
        return new Foo();
    }

    protected function callsZoo($x, User $u, $obj, $var, $cls, $arr, $a)
    {
        helper();
        \App\Helpers\format_id(1);
        App\Helpers\other(2);
        $x->m1();
        $this->m2();
        $this->prop->m3();
        $this->a->b->m4();
        $obj->prop->m5();
        UserModel::query();
        self::sHelper();
        static::sHelper();
        parent::pHelper();
        $var::vm();
        \Qual\Cls::qm();
        UserModel::factory($x)->where('a');
        $this->factory($x)->go();
        foo()->fluent();
        $a?->maybe()->chained();
        "chain"->upper();
        $fn = 'x';
        $fn();
        ($x)('arg');
        strlen(...);
        $this->m2(...);
        Cls::sm(...);
        new UserModel();
        new \App\Models\User();
        new Models\User(1);
        new static();
        new self();
        new parent();
        new $cls();
        $anon = new class extends BaseAnon implements IAnon {
            public function anonMethod(): void
            {
                inner_anon_call();
            }
        };
        new Widget(make_arg());
        $m = match ($x) {
            1 => one_case(),
            default => other_case(),
        };
        $$x = 5;
        $interp = "{$this->x} and $u prefix";
        $here = <<<EOT
          heredoc {$this->y} text
        EOT;
        $now = <<<'EOT'
          nowdoc plain
        EOT;
        echo SomeCls::CONST_READ;
        $clsName = UserModel::class;
        $propRead = UserModel::$conn;
        $rel = self::REL_CONST;
        $qualRead = \Qual\Cls::QCONST;
        $suit = Suit::Hearts;
    }

    public function nester($arr, $x): void
    {
        function innerNamed(): void
        {
            inner_call();
        }
        if (!class_exists('Poly')) {
            class Poly
            {
                const POLY_MAX = 3;

                public function pm(): void
                {
                    poly_call();
                }
            }
        }
        $c = function () use (&$x) {
            closure_call();
        };
        $a = fn ($v) => arrow_call($v);
        usort($arr, 'cmp_items');
        array_map('App\Svc\namespaced_fn', $arr);
        call_user_func([$this, 'm2']);
        call_user_func([UserModel::class, 'sm']);
        call_user_func(['Cls', 'sm']);
        register_shutdown_function('Cls::shutdown');
        $x->map('not_captured');
        plain_call('not_a_hof_string');
    }

    public function reader(): int
    {
        $sum = MULTI_A + TYPED_MAX;
        $s = "interp TYPED_MAX read: {$this->x} MULTI_B";
        $varOccurrence = $MULTI_A;
        return $sum + self::TYPED_MAX;
    }
}

interface Shape extends Base1, Base2, \Qual\Base3
{
    public function area(): float;

    const SHAPE_KIND = 'geo';
}

trait SoftDeletes
{
    const TRAIT_CONST = 1;

    public function restore(): void
    {
        $this->doRestore();
    }
}

enum Suit: string implements HasColor
{
    case Hearts = 'H';
    case Spades = 'S';

    const ENUM_MAX = 4;

    public function color(): string
    {
        return enum_color($this);
    }
}

enum Pure
{
    case A;
    case B;
}

abstract class AbstractBase
{
    abstract protected function hook(): void;
}
