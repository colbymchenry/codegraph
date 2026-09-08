object Config {
  val RETRY_MAX = 3
  val TIMEOUT_MS = 500
  val SHARED_TABLE = Map("a" -> 1)
  val count = 9
}
val TOP_LIMIT = 99
class Reader {
  def readTop(): Int = TOP_LIMIT + 1
  def readBoth(): Int = {
    val RETRY_MAX = 9
    RETRY_MAX + Config.TIMEOUT_MS
  }
  def readInterp(): String = s"limit $TIMEOUT_MS and ${SHARED_TABLE}"
  def readCount(): Int = count
}
object Config2 {
  val TIMEOUT_MS = 1
}
