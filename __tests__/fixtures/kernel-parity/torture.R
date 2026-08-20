# Kernel↔wasm R parity torture fixture — every hook branch, extractCall shape,
# and known-gap behavior from docs/design/r-kernel-port-checklist.md. Parses
# CLEAN (no ERROR/MISSING) — deferral shapes live in the test file, and the
# CRLF variant is derived in-memory by kernel-r-parity.test.ts.

#' Roxygen title for top_fn (dropped — R nodes never carry docstrings)
#' @param a first
top_fn <- function(a, b = 2, ...) {
  a + b
}

# plain comment run above eq_fn (also dropped)
# second line
eq_fn = function(x) x * 2

lam <- \(x) x + 1

gfun <<- function() 0

(function(x) x * 3) -> trpl

function(y) y - 1 -> ghost

MAX_RETRIES <- 3L
A.CONST = 2.5
lower_var <- "hello"
dotted.var <- 1
x2 <<- 4
9 -> right_var
10 ->> RIGHT.CONST
chain_a <- chain_b <- 5

nester <- function(x) {
  inner <- function(y) {
    innermost <- function(z) z + 1
    innermost(y)
  }
  CAPS_LOCAL <- 99
  z <- inner(x)
  log_it(z)
  z
}

if (TRUE) f_in_if <- function() 1
{
  hidden_var <- 42
  braced_fn <- function() 2
}

top_call(nested_call(1))
x %>% p_one() %>% p_two()
z |> p_three()
res <- data %>% p_four()

# --- imports -----------------------------------------------------------------
library(dplyr)
require(stats)
requireNamespace("jsonlite")
loadNamespace("tools")
source("helpers.R")
source(file.path("R", "dyn.R"))
library()
suppressPackageStartupMessages(library(quietpkg))
base::library(magrittr)
library(help = docpkg)
requireNamespace(quietly = TRUE, package = "namedpkg")
library("")
pkg::fn_q(1)
pkg:::fn_h(2)
use_it <- function() {
  library(inside_fn)
  fn_q(3)
}

# --- classes -----------------------------------------------------------------
setClass("Patient", representation(name = "character"), contains = "Person")

setGeneric("describe", function(obj) standardGeneric("describe"))

setMethod("describe", "Patient", function(obj) {
  fmt(obj)
})

Account <- setRefClass("Account",
  fields = list(balance = "numeric"),
  contains = "BaseAccount",
  methods = list(
    deposit = function(x) {
      balance <<- balance + x
      audit(x)
    },
    withdraw = function(x) balance <<- balance - x
  ))

Stack <- R6Class("Stack",
  inherit = AbstractCollection,
  public = list(
    items = NULL,
    push = function(x) {
      self$items <- c(self$items, x)
      invisible(self)
    }
  ),
  private = list(
    validate_it = function() TRUE
  ),
  active = list(
    size = function() length(private$items)
  ))

GeomX <- ggproto("GeomX", Geom,
  extra_param = "no",
  draw_panel = function(data, panel) {
    render_geom(data)
  }
)

methods::setClass("QualClass", contains = "QBase")
R6::R6Class("QualR6", public = list(qm = function() do_q()))
Gen <- R6Class(GenName, public = list(gm = function() 1))
BadGG <- ggproto(NULL, Geom, draw_key = function(x) render_key(x))
NoInherit <- R6Class("NoInherit", inherit = pkg::Parent)
factory <- function() {
  Local <- setRefClass("LocalCls", methods = list(lm = function() lcall()))
  Local
}
Empty <- R6Class("Empty", public = list())
Pos <- setRefClass("PosCls", methods = list(function() 1))
s3.method <- print.myclass <- NULL
print.data.frame2 <- function(x, ...) {
  format_it(x)
}
env$attached <- function(x) side_call(x)
"strname" <- function() 1
setMethod("show", signature("Cls"), function(object) cat_it(object))
setGeneric("area")
setValidity("Cls", function(object) TRUE)
Late <- R6Class("Late",
  public = list(pm = function() p_call()),
  inherit = LateBase)

# --- call zoo & lhs shapes ---------------------------------------------------
"strassign" <- 6
x[1] <- 7
attr(x, "who") <- 8
names(x) <- c("a")
obj$field <- 9
obj@slot <- 10
assign("via_assign", 11)
delayedAssign("lazy_one", compute_it())
makeActiveBinding("active_one", function() 1, environment())
obj$meth(3)
lst$a$b(4)
o@s$m(5)
Negate(`%in%`)(6)
"strfn"(7)
(handler)(8)
lst[[1]](9)
`weird name` <- 12
`%+%` <- function(a, b) paste(a, b)
result <- if (cond) f_yes() else f_no()
for (i in seq_len(10)) body_call(i)
while (keep_going()) step_once()
repeat break
local({
  local_hidden <- 13
  local_fn <- function() 14
})
try(risky_call())
Recall(1)
UseMethod("generic_dispatch")
do.call("dyn_target", list(1))
do.call(real_target, list(2))
match.fun("fun_by_name")(3)
stopifnot(is_ok(x))
on.exit(cleanup_fn())
invisible(NULL)

# --- return-as-named-node, duplicates, right-assign in a body ----------------
f <- function(x) {
  if (x > 0) return(g(x))
  h(x)
}
ret_val <- return
setMethod("area", "Sq", area_impl)
require(pkg2, quietly = TRUE)
dupline <- function() 1; dupline <- function() 2
dup_var <- 1; dup_var <- 2
runner <- function() {
  fetch() -> got
  got
}
dt[, b := compute_b(a)]

# --- parse-clean battery shapes (must NOT defer) -----------------------------
rs <- r"(no \escape here)"
rs2 <- r"#(one "quoted" bit)#"
plot(1, )
sliced <- x[1, ]
piped <- x |> f_ph(y = _)

# --- UTF-16 columns ----------------------------------------------------------
msg <- "héllo 🎉"
emoji_caller <- function() after_emoji("🎉🎉", target_fn())
