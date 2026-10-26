/* Parity fixture for #1838 in C: function-like macros as `constant` nodes
 * at file scope and inside a body, an object-like define that is NOT a node,
 * and the call refs the macro invocations still record. */
#define TRACE_POINT(value) ((void)(value))
#define VERSION 7
#define MAX(a, b) ((a) > (b) ? (a) : (b))

static int helper(int x) { return x; }

int exercise(int value) {
  TRACE_POINT(value);
#define LOCAL_TRACE(v) ((void)(v))
  LOCAL_TRACE(1);
  return MAX(helper(value), VERSION);
}
