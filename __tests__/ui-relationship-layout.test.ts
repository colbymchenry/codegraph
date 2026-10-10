import { describe, it, expect } from 'vitest';
import { layoutRelationships, type RelationshipLayoutInput } from '../ui/src/lib/relationship-layout';
import { calculateRenderLayout } from '../ui/src/lib/graph-layout-runner';
import { routeScene } from '../ui/src/lib/graph-routing';

const modes = ['force', 'concentric', 'circular'] as const;
function fixture(count: number): RelationshipLayoutInput {
  return { nodes: Array.from({length:count},(_,i)=>({id:`n${i}`,width:200,height:48})), groups:[],
    relations:Array.from({length:count},(_,i)=>Array.from({length:Math.min(5,count-1)},(_,j)=>({id:`e${i}:${j}`,source:`n${i}`,target:`n${(i+j+1)%count}`}))).flat() };
}
describe('relationship layouts', () => {
  it.each(modes)('%s is deterministic, handles isolates/self loops and leaves relations intact', async mode => {
    const input=fixture(9);input.nodes.push({id:'isolated',width:400,height:96});
    input.relations.push({id:'loop',source:'n0',target:'n0'});
    const before=structuredClone(input),positions=await layoutRelationships(input,mode);
    expect(input).toEqual(before); expect(await layoutRelationships(input,mode)).toEqual(positions);
    expect(Object.keys(positions)).toHaveLength(input.nodes.length);
    for(const a of input.nodes)for(const b of input.nodes)if(a.id!==b.id){
      const p=positions[a.id]!,q=positions[b.id]!;
      expect(p.x+a.width+40<=q.x || q.x+b.width+40<=p.x || p.y+a.height+40<=q.y || q.y+b.height+40<=p.y).toBe(true);
    }
    expect(await layoutRelationships({nodes:[],relations:[],groups:[]},mode)).toEqual({});
    expect(await layoutRelationships({nodes:[input.nodes[0]!],relations:[],groups:[]},mode)).toEqual({n0:{x:48,y:48}});
  });
  it('puts a hub inside concentric rings and circular nodes on one ring', async()=>{
    const input=fixture(8);input.relations=input.nodes.slice(1).map(n=>({id:n.id,source:'n0',target:n.id}));
    const concentric=await layoutRelationships(input,'concentric');
    const center=concentric.n0!,radii=input.nodes.slice(1).map(n=>Math.hypot(concentric[n.id]!.x-center.x,concentric[n.id]!.y-center.y));
    expect(Math.max(...radii)-Math.min(...radii)).toBeLessThan(.001);
    expect(Math.min(...radii)).toBeGreaterThan(200);
    const circular=Object.values(await layoutRelationships(input,'circular'));
    const x=circular.reduce((s,p)=>s+p.x,0)/8,y=circular.reduce((s,p)=>s+p.y,0)/8;
    const ring=circular.map(p=>Math.hypot(p.x-x,p.y-y));
    expect(Math.max(...ring)-Math.min(...ring)).toBeLessThan(.001);
  });
  it.each(modes)('%s reserves separate bounds for groups',async mode=>{
    const input=fixture(10);input.groups=[{id:'a',members:['n0','n1','n2','n3']},{id:'b',members:['n4','n5','n6']}];
    const p=await layoutRelationships(input,mode);
    const box=(ids:string[])=>({left:Math.min(...ids.map(id=>p[id]!.x))-20,right:Math.max(...ids.map(id=>p[id]!.x+200))+20,top:Math.min(...ids.map(id=>p[id]!.y))-32,bottom:Math.max(...ids.map(id=>p[id]!.y+48))+20});
    const a=box(input.groups[0]!.members),b=box(input.groups[1]!.members);
    expect(a.right<b.left || b.right<a.left || a.bottom<b.top || b.bottom<a.top).toBe(true);
  });
  it.each(modes)('%s supports 400 nodes / 2000 edges including obstacle routes',async mode=>{
    const input=fixture(400),start=performance.now();
    const positions=await calculateRenderLayout('relationships',input,{mode}) as Record<string,{x:number;y:number}>;
    const layoutMs=performance.now()-start;
    const routes=routeScene(input.nodes.map(n=>({...n,...positions[n.id]!})),input.relations);
    expect(Object.keys(positions)).toHaveLength(400);expect(Object.keys(routes)).toHaveLength(2000);
    console.info(`${mode} 400/2000: layout ${Math.round(layoutMs)}ms, routes ${Math.round(performance.now()-start-layoutMs)}ms`);
  },20000);
  it('rejects oversized data before layout even when groups hide all nodes',async()=>{
    const input=fixture(401);input.groups=[{id:'all',members:input.nodes.map(n=>n.id)}];
    await expect(calculateRenderLayout('relationships',input,{mode:'force'})).rejects.toThrow('400');
    await expect(calculateRenderLayout('relationships',fixture(2),{mode:'invalid'})).rejects.toThrow('Unknown');
  });
});
