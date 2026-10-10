<script lang="ts">
  import { graphText } from '../../lib/graph-copy';
  let { nodes, edges, edgesExact = true }: { nodes: number; edges: number; edgesExact?: boolean } = $props();
</script>
<div role="status"><h2>{graphText('请缩小图谱范围', 'Narrow the graph scope')}</h2><p>{graphText(`当前 ${nodes} 个节点、${edgesExact ? edges : edges > 0 ? `${edges}+` : '未知'} 条边。画布上限为 400 个节点、2000 条边；请选择更小目录、降低深度或更换起点。`, `This scope has ${nodes} nodes and ${edgesExact ? edges : edges > 0 ? `${edges}+` : 'unknown'} edges. The canvas allows 400 nodes and 2,000 edges. Choose a smaller root, reduce depth, or change the anchor.`)}</p></div>
<style>div{padding:40px;max-width:560px}h2{font:600 16px var(--sans)}p{color:var(--ink-2);font:13px/1.6 var(--sans)}</style>
