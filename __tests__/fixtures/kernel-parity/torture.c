/* Torture fixture for the C kernel walker (R7a) — exercises every c-path
 * branch of the checklist: fn-ptr tables, typedef enum/struct, file-scope
 * consts incl. multi-declarator, the macro-prototype misparse skip,
 * value-refs (+ shadow prune), the leading-attr-macro preParse blank, and
 * the C call shapes. Must parse ERROR-FREE post-preParse or the kernel arm
 * defers. */
#include <stdio.h>
#include <sys/socket.h>
#include "local_ops.h"

/** Retry budget for the poller. */
static const int MAX_RETRIES = 3;
static const int LOW_WATER = 2, HIGH_WATER = 8;
static int counter = 0;
static const char *BANNER = "torture";

/* Bare identifier declarators are the macro-prototype misparse shape and are
 * skipped by design (uninit scalars are the accepted loss). */
int bare_global;
MYLIB_API config_handle;

/* Leading attribute macro — blanked by preParseCSource (#1211), so the real
 * name survives on both arms. */
SEC_ATTR UINT32 masked_entry(VOID) { return 0; }

typedef enum { STATE_IDLE, STATE_RUNNING, STATE_DONE } run_state_t;

typedef struct {
  int fd;
  void (*on_recv)(int);
} conn_t;

typedef struct conn_pool conn_pool_t;

typedef int (*cb_t)(int);

enum wire_flags { WIRE_A = 1, WIRE_B = 2 };

struct packet {
  int len;
  unsigned char body[64];
  struct packet *next;
  cb_t *async_cb;
};

/** Sum helper (docstring). */
static int add(int a, int b) { return a + b; }

static int cb_a(int x) { return add(x, 1); }
static int cb_b(int x) { return add(x, 2); }

/* fn-ptr table at file scope — the ungated 'list' capture positions. */
static cb_t DISPATCH_TABLE[] = { cb_a, cb_b };

static void handle_recv(int fd);

/* struct initializer — the ungated 'value' capture positions. */
static const struct handler_ops OPS = { .recv = handle_recv, .flags = WIRE_A };

static void handle_recv(int fd) {
  struct packet pkt;
  pkt.len = fd;
  printf("fd=%d retries=%d\n", fd, MAX_RETRIES);
}

/* Local shadow of a file-scope const — the shadow prune drops HIGH_WATER as a
 * value-ref target while LOW_WATER stays live. */
static int shadowed_reader(void) {
  int HIGH_WATER = 99;
  return HIGH_WATER + LOW_WATER;
}

static int use_table(int idx, int v) {
  cb_t fn = DISPATCH_TABLE[idx];
  int r = (*fn)(v);
  conn_t c = { 1, 0 };
  c.on_recv(r);
  return counter + r;
}

static void spawn_workers(void) {
  register_handler(cb_a);
  signal_connect(&cb_b);
}
