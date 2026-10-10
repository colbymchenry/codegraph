import type { SceneNode, SceneEdge } from './graph-scene';

/** Shared occupancy grid. Runs in a cancellable Worker, never once per edge on the UI thread. */
export function routeScene(nodes: Pick<SceneNode, 'id'|'x'|'y'|'width'|'height'>[], edges: Pick<SceneEdge,'id'|'source'|'target'>[]) {
  if (!nodes.length) return {};
  const margin = 48;
  const left = Math.min(...nodes.map(n=>n.x))-margin, top = Math.min(...nodes.map(n=>n.y))-margin;
  const spanX = Math.max(...nodes.map(n=>n.x+n.width))-left+margin;
  const spanY = Math.max(...nodes.map(n=>n.y+n.height))-top+margin;
  // A large circular layout has a mostly empty centre. Keep memory bounded while
  // retaining enough resolution for the 48px cards and their obstacle padding.
  const step = (Math.ceil(spanX/16)+1)*(Math.ceil(spanY/16)+1) > 2_000_000 ? 32 : 16;
  const width = Math.ceil((Math.max(...nodes.map(n=>n.x+n.width))-left+margin)/step)+1;
  const height = Math.ceil((Math.max(...nodes.map(n=>n.y+n.height))-top+margin)/step)+1;
  if (width*height > 2_000_000) throw new Error('布局跨度过大，请恢复布局或缩小范围。 Layout span exceeds routing budget.');
  const blocked = new Uint8Array(width*height), byId = new Map(nodes.map(n=>[n.id,n]));
  const index = (x:number,y:number)=>y*width+x;
  for (const n of nodes) for(let y=Math.ceil((n.y-top-6)/step);y<=Math.floor((n.y+n.height-top+6)/step);y++)
    for(let x=Math.ceil((n.x-left-6)/step);x<=Math.floor((n.x+n.width-left+6)/step);x++) blocked[index(x,y)]=1;
  const exits = (n:typeof nodes[number]) => {
    const cx=n.x+n.width/2,cy=n.y+n.height/2;
    const result = [
      {x:Math.ceil((n.x+n.width+12-left)/step),y:Math.round((cy-top)/step),horizontal:true},
      {x:Math.floor((n.x-12-left)/step),y:Math.round((cy-top)/step),horizontal:true},
      {x:Math.round((cx-left)/step),y:Math.ceil((n.y+n.height+12-top)/step),horizontal:false},
      {x:Math.round((cx-left)/step),y:Math.floor((n.y-12-top)/step),horizontal:false},
    ];
    return result.filter(p=>p.x>=0&&p.y>=0&&p.x<width&&p.y<height&&!blocked[index(p.x,p.y)]).map(p=>({
      id:index(p.x,p.y), stub: (p.horizontal?[left+p.x*step,cy]:[cx,top+p.y*step]) as [number,number]
    }));
  };
  const ports = new Map(nodes.map(n=>[n.id,exits(n)]));
  const visited=new Uint32Array(blocked.length),distance=new Float64Array(blocked.length),parent=new Int32Array(blocked.length);
  let stamp=0;
  const routes:Record<string,[number,number][]>={};
  for(const edge of edges) {
    if(edge.source===edge.target||!byId.has(edge.source)||!byId.has(edge.target)) continue;
    const starts=ports.get(edge.source)!,ends=ports.get(edge.target)!;
    if(!starts.length||!ends.length) throw new Error('节点间距不足，无法避障；请恢复布局。 Nodes overlap routing ports; restore layout.');
    ++stamp;
    const goals=new Set(ends.map(p=>p.id)),heap:{id:number;cost:number;g:number}[]=[];
    const h=(id:number)=>Math.min(...ends.map(p=>Math.abs(id%width-p.id%width)+Math.abs(Math.floor(id/width)-Math.floor(p.id/width))));
    // Prefer progress toward the goal for equal A* scores, avoiding breadth-first
    // expansion across the empty centre of a ring. IDs make ties deterministic.
    const order=(a:typeof heap[number],b:typeof heap[number])=>a.cost-b.cost || b.g-a.g || a.id-b.id;
    function push(item:typeof heap[number]) { let i=heap.length;heap.push(item);while(i>0){const p=(i-1)>>1;if(order(heap[p]!,item)<=0)break;heap[i]=heap[p]!;i=p;}heap[i]=item; }
    function pop(){const first=heap[0]!,last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&order(heap[c+1]!,heap[c]!)<0)c++;if(order(heap[c]!,last)>=0)break;heap[i]=heap[c]!;i=c;}heap[i]=last;}return first;}
    for(const start of starts){visited[start.id]=stamp;distance[start.id]=0;parent[start.id]=-1;push({id:start.id,g:0,cost:h(start.id)});}
    let found=-1,loops=0;
    while(heap.length&&loops++<100_000){const item=pop(),id=item.id;if(item.g!==distance[id])continue;if(goals.has(id)){found=id;break;}
      const x=id%width,y=Math.floor(id/width);
      for(const next of [x+1<width?id+1:-1,x>0?id-1:-1,y+1<height?id+width:-1,y>0?id-width:-1]){
        if(next<0||blocked[next])continue;const d=item.g+1;
        if(visited[next]!==stamp||d<distance[next]!){visited[next]=stamp;distance[next]=d;parent[next]=id;push({id:next,g:d,cost:d+h(next)});}
      }
    }
    if(found<0) throw new Error('当前布局没有可用的避障通道，请恢复布局或缩小范围。 No clear routing corridor in this layout.');
    const chain:number[]=[];for(let id=found;id>=0;id=parent[id]!)chain.push(id);chain.reverse();
    const points:[number,number][]=[starts.find(p=>p.id===chain[0])!.stub,...chain.map(id=>[left+id%width*step,top+Math.floor(id/width)*step] as [number,number]),ends.find(p=>p.id===found)!.stub];
    routes[edge.id]=points.filter((p,i)=>!i||p[0]!==points[i-1]![0]||p[1]!==points[i-1]![1]).filter((p,i,list)=>!i||i===list.length-1||!((p[0]===list[i-1]![0]&&p[0]===list[i+1]![0])||(p[1]===list[i-1]![1]&&p[1]===list[i+1]![1])));
  }
  return routes;
}
