object Registry {
  given regOrd: Ordering[Int] = new Ordering[Int] {
    def compare(a: Int, b: Int): Int = cmpHelper(a, b)
    val innerVal = 5
  }
  def member(): Int = 1
}
given topOrd: Ordering[Long] = new Ordering[Long] {
  def compare(a: Long, b: Long): Int = cmpTop(a, b)
  val topInnerVal = 6
}
class BodyStmt(size: Int) {
  require(size > 0)
  logInit(this)
  val fnField = (x: Int) => runLam(x)
}
object Boot extends App {
  bootUp()
  def local(): Unit = ()
}
object NamedArgs {
  def cbTarget(): Unit = ()
  def sink(): Unit = {
    wire(cb = cbTarget)
    forward(cb = cb)
  }
}
