/** KDoc for the file's package. */
package com.example.torture

import com.example.other.OtherClass
import com.example.util.helper
import com.example.wild.*
import com.example.alias.LongName as Short

// line comment run 1
// line comment run 2
fun topLevel(x: Int, s: String): WidgetK {
    val local = x + 1
    return WidgetK(local)
}

/** KDoc on extension fn. */
fun WidgetK.extend(n: Int): Int {
    render()
    return n
}

fun <T> List<T>.genericExt(): T = first()

fun com.example.Qualified.qext() {}

suspend fun suspender(): Unit { helper() }

private internal fun visFn() {}

fun inferred() = helper()

fun nullableRet(): WidgetK? = null

fun lambdaRet(): (Int) -> Unit = { }

expect fun platformThing(): Int

actual fun actualThing(): Int = 1

tailrec fun tailer(n: Int): Int = if (n <= 0) 0 else tailer(n - 1)

infix fun Int.pow(e: Int): Int = this

operator fun WidgetK.plus(o: WidgetK): WidgetK = this

val topVal: Int = 3
var topVar = "s"
const val TOP_CONST = 99
val topDelegated by lazy { WidgetK(1) }
val (destA, destB) = makePair()
val withGetter: Int
    get() = 42

class WidgetK(val size: Int, private var name: String = defaultName()) {
    val area: Int = size * size
    var label: String? = null
    val computed: Int
        get() = size * 2

    init {
        val initLocal = 5
        register(initLocal)
    }

    constructor(s: String) : this(s.length) {
        log(s)
    }

    fun render(): Unit {
        draw(size)
    }

    fun chainInner(): WidgetK = this

    companion object {
        val SHARED = WidgetK(0)
        const val COMPANION_CONST = 7
        fun create(): WidgetK = WidgetK(1)
    }

    companion object Named { }
}

data class DataK(val a: Int, val b: String)

abstract class AbstractK {
    abstract fun impl(): Int
}

open class OpenBase(n: Int) {
    open fun over() {}
}

class SubK(n: Int) : OpenBase(n), Drawable, Comparable<SubK> {
    override fun over() {}
    override fun compareTo(other: SubK): Int = 0
    override fun draw() {}
}

class QualifiedSuper : com.example.deep.RemoteBase() { }

class DelegatedImpl(d: Drawable) : Drawable by d

interface Drawable {
    fun draw()
    fun outline(): Int = 1
    val prop: Int get() = 2
}

sealed class SealedOp {
    object Add : SealedOp()
    data class Mul(val f: Int) : SealedOp()
}

sealed interface SealedIface

enum class Color {
    RED, GREEN, BLUE
}

enum class Http(val code: Int) {
    OK(200) {
        override fun label(): String = "ok"
    },
    ERR(500) {
        override fun label(): String = "err"
    };

    abstract fun label(): String
    fun common(): Int = code
    companion object {
        fun of(c: Int): Http = OK
    }
}

object Registry {
    val instances = mutableListOf<WidgetK>()
    var count = 0
    const val REG_CONST = 1
    fun register(w: WidgetK) { instances.add(w) }
}

annotation class MyMarker(val why: String = "")

@MyMarker
class Annotated {
    @JvmStatic
    fun jvmStatic() {}

    @Deprecated("gone", ReplaceWith("new"))
    fun old() {}

    @field:JvmField
    val fielded: Int = 1

    @get:MyMarker
    val got: Int = 2
}

typealias Handler = (Int) -> Unit
typealias WidgetList = List<WidgetK>

expect class PlatformFile {
    fun path(): String
}

actual class ActualFile {
    actual fun path(): String = "/"
}

actual typealias PlatformClock = java.time.Clock

fun caller() {
    val w = WidgetK(1)
    w.render()
    this.toString()
    super.hashCode()
    Registry.register(w)
    Registry.count
    Color.RED
    com.example.Fq.CONST_READ
    WidgetK.create().render()
    Foo.getInstance().bar()
    lowerFactory().chain()
    w.chainInner().render()
    "literal".uppercase()
    5.toString()
    listOf(1, 2).size
    w.label?.length
    w.label!!.length
    helper()
    Short.static()
    val fn: Handler = { i -> println(i) }
    fn(3)
    (fn)(4)
    run { helper() }
    listOf(1).forEach { it + 1 }
    w.let { it.render() }
    generic<Int>(1)
    register(::topLevel)
    register(OtherClass::handle)
    register(w::render)
    register(this::caller)
    obtain(String::class)
    val m = ::caller
    val bound = w::render
    val s = "interp $topVal and ${w.render()} end"
    val multi = """raw $topVal"""
    when (w.size) {
        1 -> helper()
        else -> draw(0)
    }
    if (topVal > 1) { helper() }
    for (i in 1..3) { draw(i) }
    fun localFn(): Int = 5
    localFn()
    class LocalClass {
        fun lm() {}
    }
    object LocalObj {
        fun om() {}
    }
    val anon = object : Drawable {
        override fun draw() { helper() }
    }
    anon.draw()
    label@ for (i in 1..2) { break@label }
    val backtick = `weird name`()
}

fun `weird name`(): Int = 1

fun trailing(block: (Int) -> Int): Int = block(1)

fun useTrailing() {
    trailing { it * 2 }
    trailing() { it * 3 }
}

fun defaults(a: Int = compute(), b: String = "x") {}

fun varargFn(vararg xs: Int) {}

fun destructuringBody(p: Pair<Int, Int>) {
    val (x, y) = p
    draw(x + y)
}

fun assignRefs() {
    Registry.count = 5
    Registry.count += 1
}

fun nullish(x: WidgetK?) {
    x?.render()
    val l = x ?: WidgetK(0)
}

fun stringsEdge() {
    val a = "quote \" and dollar ${'$'} done"
}

fun labeledLambda() {
    listOf(1).forEach loop@{ if (it == 0) return@loop }
}

fun whereClause(): Int where Int : Comparable<Int> = 1
