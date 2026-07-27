extension (s: String)
  def doubleUp: String = concat(s, s)
  def tripleUp: String = concat2(s, concat3(s, s))

extension (t: Int) { 
  def bracedA: Int = callA(t)
  def bracedB: Int = callB(t)
}

extension [A](xs: List[A]) def secondOpt: Option[A] = xs.drop(1).headOption
extension (t: Int) {
  def bracedA: Int = callA(t)
  def bracedB: Int = callB(t)
}
extension (t: Int) {
  def bracedA: Int = callA(t)
}
