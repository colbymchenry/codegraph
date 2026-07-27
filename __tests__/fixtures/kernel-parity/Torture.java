/**
 * Java torture fixture — exercises every Java extraction path the kernel
 * ports: package namespace, imports, javadoc, annotations, inheritance,
 * fields/constants, enums, anonymous classes, method references, static
 * member reads, fluent chains, Lombok synthesis, value refs + shadowing.
 */
package com.example.torture;

import java.util.List;
import java.util.Map;
import static java.util.Objects.requireNonNull;
import com.example.other.OtherClass;
import lombok.Data;

/** Javadoc for the service. */
@Service
@Component("torture")
public class TortureService extends BaseService implements Runnable, AutoCloseable {
  /** A shared constant table (value-ref target). */
  public static final Map<String, Integer> RETRY_LIMITS = Map.of("a", 1);
  private static final String API_BASE = "https://example.test";
  protected int count = 0;
  private final List<String> names;
  int packagePrivate, secondDeclarator;

  /** Ctor javadoc. */
  public TortureService(List<String> names) {
    this.names = requireNonNull(names);
    register(this::onEvent);
    queue(TortureService::compute);
    queue(OtherClass::handle);
    Runnable r = () -> helper(RETRY_LIMITS);
    executor.submit(new Runnable() {
      @Override
      public void run() {
        helper(RETRY_LIMITS);
      }
    });
  }

  @Override
  @Deprecated
  public void run() {
    Config cfg = ConfigLoader.getInstance().load();
    this.registry.lookup("x");
    helper(Direction.UP);
    String base = API_BASE;
    int max = Limits.MAX_VALUE;
    new StringBuilder(16).append(base);
  }

  private static Config helper(Object arg) {
    return new Config();
  }

  private void onEvent() {}
  private static void compute() {}

  public void shadowed() {
    String API_BASE = "local"; // shadows the class constant
    log(API_BASE);
  }

  enum Direction {
    UP,
    DOWN;

    Direction opposite() {
      return this == UP ? DOWN : UP;
    }
  }

  interface Listener {
    void onChange(TortureService svc);
  }
}

@Data
class LombokBean {
  private String name;
  private boolean isActive;
  private final int id;
  private static int counter;
  private String toString; // taken: no synthetic toString field collision

  public String getName() { return name; } // explicit getter — never overridden
}

@lombok.Getter
@lombok.extern.slf4j.Slf4j
@Builder
class LombokBuilderBean {
  private List<String> items;
}

interface Shape extends Comparable<Shape>, Cloneable {
  double area();
}

@interface Marker {
  String value() default "";
}
