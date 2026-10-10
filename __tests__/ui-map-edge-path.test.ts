import { describe, expect, it } from 'vitest';
import { mapEdgePath } from '../ui/src/lib/map-edge-path';

describe('架构边路径', () => {
  it.each([
    ['curve', 'M10.1,20.1 C10.1,60.1 90,60.1 90,100'],
    ['straight', 'M10.1,20.1 L90,100'],
  ] as const)('%s 保持端口并将坐标四舍五入到一位小数', (style, expected) => {
    const points = { source: { x: 10.06, y: 20.14 }, target: { x: 90.04, y: 100.02 } };
    expect(mapEdgePath(points, style)).toBe(expected);
  });

  it.each(['curve', 'straight'] as const)('%s 回边始终从源出发到目标结束', style => {
    const path = mapEdgePath({ source: { x: -5, y: 180 }, target: { x: 30, y: 20 } }, style);
    expect(path.startsWith('M-5,180 ')).toBe(true);
    expect(path.endsWith('30,20')).toBe(true);
  });
});
