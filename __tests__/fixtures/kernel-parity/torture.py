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
