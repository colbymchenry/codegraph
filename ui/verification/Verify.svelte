<script lang="ts">
  import GraphCanvas from '../src/components/graph/GraphCanvas.svelte';
  import type { GraphScene } from '../src/lib/graph-scene';
  import MapView from '../src/views/MapView.svelte';
  import FlowView from '../src/views/FlowView.svelte';
  import ScreensView from '../src/views/ScreensView.svelte';
  import StepsView from '../src/views/StepsView.svelte';
  import { setGraphAdapter } from '../src/lib/adapter';
  import { mockAdapter } from './fixtures';
  import { screen, link, payload } from './screens';
  import type { WireStepsPayload } from '../src/lib/wire';
  let view = $state(new URL(location.href).searchParams.get('view'));
  const {adapter}=mockAdapter();
  if(new URL(location.href).searchParams.has('hub')) {
    const originalMap=adapter.map;
    adapter.map=async request=>{const data=await originalMap(request);const names=['cmd','dbagent','testcase','cross','common','component','initialize','logagent','logic','snapshot','config'];
      const modules=names.map((name,i)=>({...data.modules[0]!,id:`src/${name}`,label:name,files:12+i*3,symbols:123+i*417}));
      const pairs=names.filter(n=>n!=='cross').map(n=>['cross',n]);pairs.push(['common','cross'],['initialize','cross'],['logic','cross'],['config','config']);
      return {...data,modules,links:pairs.map(([source,target],i)=>({...data.links[0]!,source:`src/${source}`,target:`src/${target}`,count:2+i*17}))};};
  }
  const targets=['/','/登录','/工作台','/项目设置','/详情'];
  adapter.screens=async()=>payload(targets.map(screen),[link('/','/登录'),link('/登录','/工作台','authenticated'),link('/工作台','/项目设置','isAdmin'),link('/工作台','/详情'),link('/详情','/工作台','back')]);
  const steps:WireStepsPayload={anchor:{id:'anchor',kind:'function',name:'登录请求',qualifiedName:'login',file:'src/login.ts',line:1,endLine:20,language:'typescript',test:false},ambiguous:[],project:'fixture',steps:['anchor','findUser','signToken','reply200','reply401'].map((id,i)=>({id,kind:i?'effect':'anchor',anchor:i===0,node:null,label:id,sub:'静态调用关系',depth:i,cut:null})),links:[['anchor','findUser'],['findUser','signToken'],['signToken','reply200'],['findUser','reply401']].map(([from,to],i)=>({id:`real:${i}`,from:from!,to:to!,kind:'calls',via:[],when:'',label:'calls',synthesized:false,uncertain:false,sites:[]})),program:{root:[{kind:'step',step:'findUser'},{kind:'fork',form:'if',on:'user.isValid',arms:[{when:'user.isValid',ends:'reply',body:[{kind:'step',step:'signToken'},{kind:'step',step:'reply200'}]},{when:'!user.isValid',not:true,ends:'reply',body:[{kind:'step',step:'reply401'}]}]}],truncated:0},defaultView:'order',depth:8,limit:120,through:false,truncated:{steps:0,hubs:0,chrome:0},index:{lastIndexedAt:null,edges:4,files:1},timing:{elapsedMs:1}};
  adapter.steps=async()=>steps;setGraphAdapter(adapter);
  const count = Number(new URL(location.href).searchParams.get('nodes') ?? 12);
  let selected = $state<string|null>(null);
  const ids = Array.from({length:count},(_,i)=>`src/module-${i}`);
  const scene = $derived<GraphScene>({kind:'map',groups:[],nodes:ids.map((id,i)=>({id,label:`模块 ${i} / module-${i}`,sub:'123 符号 · 12 文件',kind:'module',x:60+i%Math.ceil(Math.sqrt(count))*270,y:100+Math.floor(i/Math.ceil(Math.sqrt(count)))*150,width:200,height:48,selected:id===selected,draggable:true})),relations:ids.flatMap((id,i)=>Array.from({length:Math.min(5,count-1)},(_,j)=>({id:`${i}:${j}`,source:id,target:ids[(i+j+1)%count]!}))),edges:ids.flatMap((id,i)=>Array.from({length:Math.min(5,count-1)},(_,j)=>({id:`${i}:${j}`,source:id,target:ids[(i+j+1)%count]!,label:'1',width:1.5,originalIds:[`${i}:${j}`]})))});
</script>
{#if view}
  <nav>{#each ['map','flow','screens','steps'] as item}<a href={`?view=${item}`} onclick={e=>{e.preventDefault();history.pushState(null,'',`?view=${item}`);view=item;}}>{item}</a>{/each}<button onclick={()=>document.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark')}>明暗主题</button></nav>
  <main>{#key view}{#if view==='map'}<MapView root="src" depth={1} tests={false}/>{:else if view==='flow'}<FlowView from="handleCallback" to="decodeJwt" symbols={null} trailParam={null}/>{:else if view==='screens'}<ScreensView/>{:else}<StepsView anchor="anchor" symbol={null} depth={8} through={false} reading={null}/>{/if}{/key}</main>
{:else}<GraphCanvas {scene} {selected} onSelect={id=>selected=id}/>{/if}
<style>nav{height:44px;display:flex;align-items:center;gap:24px;padding:0 20px}main{position:absolute;inset:44px 0 0;display:flex;flex-direction:column}main :global(.graph-shell){flex:1;min-height:0}</style>
