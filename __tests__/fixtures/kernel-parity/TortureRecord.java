package com.example.records;

import java.util.List;
import lombok.Builder;

/** A 2-D point. */
public record Point(int x, int y) implements Comparable<Point>, Shape {
    public static final Point ORIGIN = new Point(0, 0);
    private static int created;

    public Point {
        if (x < 0) throw new IllegalArgumentException("x");
        created++;
    }

    public Point(int v) { this(v, v); }

    /** Explicit accessor — no implicit one is minted. */
    public int x() { return x; }

    public double norm() { return Math.sqrt(x * x + y * y); }

    @Override
    public int compareTo(Point o) { return Double.compare(norm(), o.norm()); }

    record Inner(String name, List<String> tags) {
        String first() { return tags.get(0); }
    }
}

record Pair<A, B>(A first, B second) {
    A left() { return first; }
}

@Builder
record Config(@Deprecated String host, int[] ports, java.util.Map<String, Integer> limits, String... rest) {}

interface Shape { double norm(); }

class Client {
    private Point.Inner inner;

    String use(Point p, Pair<String, Integer> pr) {
        record Local(int n) { int twice() { return n * 2; } }
        Local l = new Local(3);
        Config c = Config.builder().build();
        return inner.first() + p.y() + pr.left() + l.twice() + c.host() + Point.ORIGIN.norm();
    }
}
