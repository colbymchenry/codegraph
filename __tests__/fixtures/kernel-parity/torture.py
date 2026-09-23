"""Python torture fixture — decorators, self fn-refs, imports, shadowing."""
import os, sys
import os.path as osp
from collections import OrderedDict, defaultdict
from .relative import thing
from mypkg.handlers import target_cb

RETRY_LIMITS = {"a": 1}
API_BASE = "https://example.test"
x = compute(RETRY_LIMITS)


class Service(BaseService, mixins.LoggerMixin):
    """Class docs."""

    def __init__(self, registry):
        self.registry = registry
        register(self.on_event)
        queue(target_cb)

    @staticmethod
    def helper(arg):
        return transform(arg)

    async def run(self):
        cfg = self.registry.lookup("x")
        limit = RETRY_LIMITS
        obj.method_chain().deep(cfg)
        ", ".join(cfg)
        return await fetch(API_BASE)

    def on_event(self):
        pass


@app.route("/x")
def view():
    def inner():
        return API_BASE
    return inner()


def shadowed():
    API_BASE = "local"
    return API_BASE


handlers = {"recv": target_cb}
callbacks = [target_cb, view]

# Initializer walks attributed to the assigned name (#693).
INIT_EAGER = helper()
INIT_LAMBDA = lambda: target_cb()
INIT_MAP = {"a": helper()}
init_a, init_b = helper(), view()

# --- call receivers (#1683) ---------------------------------------------------
def bucket_chains(d, k, v):
    d.setdefault(k, []).append(v)
    d.items().get(k)
    make().run()
    (lambda: make)()().run()
    obj.make().run().again()


# --- non-call, non-identifier receivers (#66) ---------------------------------
def fabrication_shapes(rows_by_file, key):
    # Attribute chain and subscript. Each must keep its receiver text as a
    # qualifier — a bare `append`/`get` exact-matches an unrelated project
    # function of that name. (The call-chain shape lives in bucket_chains
    # above, which #1748 encodes as `<inner>().<method>` instead.)
    self_like = rows_by_file
    self_like.rows.append({"x": 1})
    rows_by_file[key].append(2)
    rows_by_file[key].get(key, None)
    return rows_by_file
