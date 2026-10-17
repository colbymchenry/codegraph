import { describe,it,expect } from 'vitest';
import { routeScene } from '../ui/src/lib/graph-routing';

describe('shared obstacle routing',()=>{
  it('routes around an intervening box, deterministically',()=>{
    const nodes=[{id:'a',x:0,y:100,width:120,height:50},{id:'obstacle',x:180,y:40,width:120,height:180},{id:'b',x:360,y:100,width:120,height:50}];
    const edges=[{id:'ab',source:'a',target:'b'}];
    const result=routeScene(nodes,edges);expect(result).toEqual(routeScene(nodes,edges));
    const points=result.ab!;expect(points.length).toBeGreaterThan(2);
    for(let i=1;i<points.length;i++){
      const a=points[i-1]!,b=points[i]!;
      expect(a[0]===b[0]||a[1]===b[1]).toBe(true);
      const crosses=a[0]===b[0]?a[0]>180&&a[0]<300&&Math.max(a[1],b[1])>40&&Math.min(a[1],b[1])<220:a[1]>40&&a[1]<220&&Math.max(a[0],b[0])>180&&Math.min(a[0],b[0])<300;
      expect(crosses).toBe(false);
    }
  });
  it('handles the full 400 node / 2000 edge fixture within the shared grid budget',()=>{
    const nodes=Array.from({length:400},(_,i)=>({id:`n${i}`,x:i%20*270,y:Math.floor(i/20)*150,width:200,height:48}));
    const edges=nodes.flatMap((n,i)=>Array.from({length:5},(_,j)=>({id:`${i}:${j}`,source:n.id,target:`n${(i+j+1)%400}`})));
    const start=performance.now(),routes=routeScene(nodes,edges);
    expect(Object.keys(routes)).toHaveLength(2000);
    expect(performance.now()-start).toBeLessThan(5000);
  });
  it('rejects unreasonable manual spans before allocating a huge grid',()=>{
    expect(()=>routeScene([{id:'a',x:0,y:0,width:100,height:100},{id:'b',x:1e9,y:1e9,width:100,height:100}],[])).toThrow('routing budget');
  });
});
