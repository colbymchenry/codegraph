object ObjectFirst {
  def create(): ObjectFirst = new ObjectFirst
}
class ObjectFirst {
  def instance(): Int = 1
}
trait TraitFirst {
  def value(): Int = 1
}
object TraitFirst {
  def factory(): Int = 2
}
object Live extends TraitFirst {
  def run(): Int = value()
}
case object Empty

def scope(): Int = {
  object Local {
    def localMethod(): Int = 3
  }
  Local.localMethod()
}
