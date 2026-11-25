package a.b {
  class Nested1 { def nm(): Int = 1 }
}
trait SelfTyped { self: Nested1 =>
  def stm(): Int = 2
}
class Outer2 {
  type Member = List[Int]
  object InnerObj { val IC = 1 }
  class InnerCls { def icm(): Int = 2 }
}
private[b] class QualPriv
class `Weird Name` { def `strange def`(): Int = 3 }
val multiA, multiB = 5
class CurryCall {
  def run(): Unit = {
    curried(1)(2)
    Foo(1).bar()
    Foo(1)(2)
    new Widget(make())
  }
}
class A extends Base(1)(2) { def m(): Int = 1 }
import single
import a.b
object Uni {
  val note = "ééé €€ 😀 end"
  def afteré(): Int = { helperé() }
}
