package com.example.torture

import com.example.other.OtherClass
import com.example.multi.{Alpha, Beta}
import com.example.wild._
import com.example.star.*
import com.example.alias.{LongName => Short}

/** Scaladoc for topLevel — kept? */
def topLevel(a: Int): WidgetS = new WidgetS(a)

// line one
// line two
def lineDoc(): Int = 1

def curried(a: Int)(b: String)(implicit ord: Ordering[Int]): Int = a

def genericDef[A: Numeric, B <: BoundT](x: A): B = ???

def inferredRet(a: Int) = a + 1

def unitRet(): Unit = ()

def genericLeak[T](t: T): T = t

def qualRet(w: WidgetS): com.example.other.Remote = ???

private def privTop(): Int = 1

@main def entry(): Unit = topLevel(1)

@deprecated("gone", "1.0") def old(): Int = 0

val topVal: Int = 3
var topVar = 4
lazy val topLazy = compute()
val (tupA, tupB) = (1, 2)
val Some(extracted) = Option(9)
val SHARED_TABLE: Map[String, Int] = Map.empty
val topInit = WidgetS.create()

class WidgetS(val size: Int, label: String = defaultLabel()) extends BaseW(size) with Drawable with Ordered[WidgetS] {
  val cachedName: String = "w"
  var mutable = 0
  private val secret = 3
  @volatile var annotatedField: Int = 0

  def this() = this(0, "d")

  def render(): RenderResult = {
    val local = helperR(size)
    Registry.register(this)
    new RenderResult(local)
  }

  def +(other: WidgetS): WidgetS = new WidgetS(size + other.size)

  def compare(that: WidgetS): Int = size - that.size

  @inline def fast(): Int = 1

  protected def hook(): Unit = ()
}

object WidgetS {
  val DEFAULT_SIZE = 10
  def create(): WidgetS = new WidgetS(DEFAULT_SIZE, "c")
  def readDefault(): Int = DEFAULT_SIZE + 1
}

case class DataS(x: Int, y: String = mkY())

case object SingletonS extends MarkerT

abstract class AbsS {
  def abstractM(): Int
  def concrete(): Int = abstractM() + 1
}

trait Drawable {
  def draw(): Unit
  def area(): Double = 0.0
  val traitVal: Int = 7
}

sealed trait Shape
object Circle extends Shape
class Square extends Shape

trait MarkerT

class DelegatedImpl(d: Drawable) extends Drawable {
  def draw(): Unit = d.draw()
}

enum Http {
  case Ok, NotFound
  case Custom(code: Int)
  def describe(): String = s"code"
}

enum Planet(mass: Double) {
  case Earth extends Planet(5.9)
  case Mars extends Planet(0.6)
}

given intOrd: Ordering[WidgetS] = new Ordering[WidgetS] {
  def compare(a: WidgetS, b: WidgetS): Int = a.size - b.size
}

given String = "anon"

extension (s: String)
  def doubleUp: String = concat(s, s)
  def tripleUp: String = concat(s, concat(s, s))

extension [A](xs: List[A]) def secondOpt: Option[A] = xs.drop(1).headOption

implicit class RichIntS(val i: Int) {
  def twice: Int = i * 2
}

type WidgetList = List[WidgetS]
opaque type Meters = Double

object CallSites {
  def run(w: WidgetS): Unit = {
    helper(1)
    w.render()
    WidgetS(1)
    WidgetS.create().render()
    lowerFactory().chain()
    a.b.method3()
    this.mine()
    super.hashCode()
    "lit".toUpperCase()
    5.toString()
    genericCall[Int](1)
    val n2 = new Ordering[Int] { def compare(p: Int, q: Int): Int = p - q }
    val s1 = s"plain $topVal and ${w.render()} end"
    val e1 = registerCb(handler _)
    val e2 = handler _
    registerCb(handler)
    val r1 = list map transform
    val r2 = 1 :: rest
    w match {
      case ws: WidgetS => use(ws)
      case _ => ()
    }
    for { x <- xs; y <- ys if y > 0 } yield combineXY(x, y)
  }
  def mine(): Int = 1
  def handler(): Unit = ()
  def localHost(): Int = {
    def innerFn(k: Int): Int = k * 2
    val lam = (q: Int) => q + 1
    class LocalClass { def lm(): Int = 3 }
    object LocalObj { def om(): Int = 4 }
    innerFn(lam(1)) + helperCall()
  }
}

object StaticReads {
  def reads(): Unit = {
    val c1 = Registry.count
    val c2 = Http.Ok
    val c3 = com.example.Fq.CONST_READ
    Registry.count = 5
    process(Registry.count)
    Registry.register(null)
  }
}

package object utilpkg {
  def pkgHelper(): Int = 1
  val pkgShared = 2
}
