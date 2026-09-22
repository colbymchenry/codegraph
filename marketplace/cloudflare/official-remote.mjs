// Authenticated operator-only adapter; never included in the public Worker.
// Credentials are consumed only by an explicitly confirmed remote apply command.
import {AwsClient} from 'aws4fetch';
export function remoteBindings(target,credentials,transport=fetch) {
  if(!credentials.d1Token||!credentials.r2AccessKeyId||!credentials.r2SecretAccessKey)throw Error('Remote apply requires privately configured D1 API and bucket-scoped R2 credentials');
  const queryUrl=`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`;
  let verified;
  async function verifyBindings() {
    verified??=(async()=>{
      const response=await transport(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${target.workerName}/settings`,{headers:{Authorization:'Bearer '+credentials.d1Token},signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw Error('Cannot verify deployed Worker bindings; no import performed');
      const data=await response.json(),bindings=data.result?.bindings;
      if(!data.success||!Array.isArray(bindings)||!bindings.some(b=>b.name==='DB'&&b.type==='d1'&&b.id===target.databaseId)||!bindings.some(b=>b.name==='PACKAGES'&&b.type==='r2_bucket'&&b.bucket_name===target.bucket))throw Error('Reviewed target does not match deployed Worker D1/R2 bindings; no import performed');
    })();
    return verified;
  }
  async function query(sql,params=[]) {
    await verifyBindings();
    const response=await transport(queryUrl,{method:'POST',headers:{Authorization:'Bearer '+credentials.d1Token,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('Authenticated D1 query failed (HTTP '+response.status+'); inspect target/permissions');
    const data=await response.json();
    if(!data.success||data.result?.length!==1||!data.result[0].success)throw Error('D1 statement rejected; inspect registry conflicts/schema before retrying');
    return data.result[0];
  }
  function prepare(sql,params=[]) {return {bind:(...values)=>prepare(sql,values),all:()=>query(sql,params),run:()=>query(sql,params),first:async column=>{const row=(await query(sql,params)).results[0];return row?(column?row[column]:row):null;}};}
  const signer=new AwsClient({accessKeyId:credentials.r2AccessKeyId,secretAccessKey:credentials.r2SecretAccessKey,service:'s3',region:'auto',retries:0});
  async function object(method,key,body) {
    await verifyBindings();
    if(!/^packages\/sha256\/[a-f0-9]{64}$/.test(key))throw Error('Unexpected official object key');
    const url=`https://${target.accountId}.r2.cloudflarestorage.com/${target.bucket}/${key}`;
    const signed=await signer.sign(url,{method,body,headers:method==='PUT'?{'If-None-Match':'*','Content-Type':'application/vnd.codegraph.extension+json'}:{}});
    return transport(signed,{signal:AbortSignal.timeout(30000)});
  }
  return {db:{prepare},bucket:{
    async get(key){const response=await object('GET',key);if(response.status===404)return null;if(!response.ok)throw Error('Authenticated R2 read failed (HTTP '+response.status+')');return {arrayBuffer:()=>response.arrayBuffer()};},
    async put(key,bytes,options){if(options?.onlyIf?.etagDoesNotMatch!=='*')throw Error('R2 official import requires conditional creation');const response=await object('PUT',key,bytes);if(response.status===412)return null;if(!response.ok)throw Error('Authenticated R2 conditional upload failed (HTTP '+response.status+')');return {};}
  }};
}
