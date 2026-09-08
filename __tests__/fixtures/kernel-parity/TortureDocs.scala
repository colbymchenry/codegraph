/** Scaladoc kept?
 * second line with star
 */
def scaladocOnly(): Int = 1

// line one
// line two
def lineRun(): Int = 2

/** block doc */
// trailing line
def mixedBlockThenLine(): Int = 3

// leading line
/** block after line */
def mixedLineThenBlock(): Int = 4

// detached

def blankLineBetween(): Int = 5

/** class doc */
class DocClass {
  /** member doc */
  def documented(): Int = 6
  /** val doc */
  val docVal = 7
}
