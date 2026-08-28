object Handlers {
  def handler(): Unit = ()
  def other(): Unit = ()
  def wire(): Unit = {
    register(handler)
    registerEta(other _)
    val stored = handler
    obj.cb = other
    this.cb = cb
    register(missing)
  }
  val topStored = handler
  var cb: () => Unit = other
}
object H2 {
  def alpha(): Unit = ()
  def beta(): Unit = ()
  def gamma(): Unit = ()
  def delta(): Unit = ()
  def wire(): Unit = {
    val stored = alpha
    obj.cb = beta
    val eta = gamma _
    sink.handler = sink.handler
  }
  val listStored = List(delta)
}
