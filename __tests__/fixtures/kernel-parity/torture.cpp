/// Torture fixture for the C++ kernel walker (R7a) — namespaces (incl. C++17
/// nested + anonymous), out-of-line Cls::method defs, templates + template
/// bases, operator definitions, stack construction, local fn-ptrs, UE-macro
/// shapes THROUGH the hoisted preParse, using-aliases, access specifiers,
/// static-member value reads, and the cpp call shapes. Must parse ERROR-FREE
/// post-preParse or the kernel arm defers (spaced operator CALL SITES live in
/// torture-defer.cpp — they produce ERROR nodes by design).
#include <vector>
#include "widget_base.hpp"

namespace app {

/** Engine config (docstring). */
class Config {
public:
  int retries;
  void apply();
  int helper_count() const { return 2; }

private:
  int secret;
};

void Config::apply() { retries = helper_count(); }

namespace detail {
struct Counter {
  int value;
  Counter *next;
};
}  // namespace detail

int detail_probe() { return 1; }

}  // namespace app

namespace app::net {
class Session {
public:
  void open();
  virtual ~Session() {}
};
void Session::open() {}
}  // namespace app::net

namespace {
int hidden_helper() { return 3; }
}  // namespace

template <typename T>
class Base {
public:
  T item;
};

template <typename T>
class Box : public Base<T> {
public:
  T get() const { return value_; }
  T unwrap();

private:
  T value_;
};

template <typename T>
T Box<T>::unwrap() {
  return value_;
}

class Derived : public Base<int>, private app::Config {
public:
  Derived() : total_(0) {}
  int total() const { return total_; }

private:
  int total_;
};

struct Vec2 {
  float x, y;
  Vec2 operator+(const Vec2 &o) const { return {x + o.x, y + o.y}; }
  explicit operator bool() const { return x != 0 || y != 0; }
  Vec2 origin();
};

enum class Mode : unsigned char { Off, On };
enum Legacy { LEGACY_A, LEGACY_B };
typedef struct {
  int id;
} packet_t;
using Handle = app::Config;

// UE-macro shapes — every one below is recovered by the hoisted preParse
// (export macro, reflection markup, inline specifier, API member prefix).
class MYMODULE_API Widget : public app::Config {
public:
  UPROPERTY(EditAnywhere, Category = "State")
  float Health;
  FORCEINLINE float GetHealth() const { return Health; }
  ENGINE_API virtual void Tick(float Delta);
};

void Widget::Tick(float Delta) { Health += Delta; }

Config GlobalConfig;
int build_number = 7;

template <typename T>
T compute_seed(T v) {
  return v + 1;
}

float drive_helper(float v) { return v; }

Widget *make_widget() { return new Widget(); }

float drive() {
  Widget local;
  app::Config cfg;
  Vec2 a{1, 2};
  Vec2 b(a);
  Vec2 c2(1.5f, 2.5f);
  float f = a.x + b.y + c2.x;
  make_widget()->Tick(0.5f);
  auto kernel = &compute_seed<float>;
  if (f > 1) {
    kernel = &drive_helper;
  }
  float r = kernel(f);
  int flags = GlobalConfig.retries;
  Mode m = Mode::Off;
  int leg = LEGACY_A;
  app::detail_probe();
  compute_seed<int>(2);
  auto mp = &app::Config::apply;
  (void)mp;
  (void)m;
  return r + f + flags + leg;
}
