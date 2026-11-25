// Torture header for the C++ kernel walker (R7a) — include guard, forward
// declarations (skipped, #1093), extern "C" prototypes, header templates,
// and a UE-reflection-shaped class recovered by the hoisted preParse.
#ifndef TORTURE_HPP
#define TORTURE_HPP

class Forward;
struct Opaque;

extern "C" {
int c_bridge(int value);
}

/// Reusable clamp helper.
template <typename T>
T clamp_value(T v, T lo, T hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

class MYLIB_API Meter : public Forward {
public:
  UPROPERTY(BlueprintReadOnly)
  int Reading;
  FORCEINLINE int Peek() const { return Reading; }
  void Calibrate(int target);
  Forward *owner();
};

inline void Meter::Calibrate(int target) { Reading = clamp_value(target, 0, 100); }

#endif
