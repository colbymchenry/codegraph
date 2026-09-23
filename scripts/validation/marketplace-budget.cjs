// Auditable projection, not a load test or account invoice prediction.
const fs=require('node:fs'),path=require('node:path');
const rows=[15000,30000].map(downloads=>{
 const sourceViews=downloads,metadata=downloads*6,assets=downloads*4,uploads=30;
 const requests=downloads+sourceViews+metadata+assets+uploads;
 // 26 ms is the largest of three hosted 8 MiB downloads, 9 ms largest captured catalog read.
 // Asset 2 ms is a stated planning allowance, not a new measurement. Upload 379 ms measured once.
 const cpuMs=(downloads+sourceViews)*26+metadata*9+assets*2+uploads*379;
 return {downloads,sourceViews,metadataRequests:metadata,assetRequests:assets,uploads,workerRequests:requests,cpuMs,workerAllowancePercent:{requests:requests/10000000*100,cpu:cpuMs/30000000*100},r2ClassB:downloads+sourceViews+uploads,r2ClassA:uploads,
 d1ReadRowsCurrentUpper:metadata*18+(downloads+sourceViews)*2+assets+uploads*1000,
 d1ReadRows1000ReleaseUpper:metadata*1001+(downloads+sourceViews)*2+assets+uploads*1000,
 maxMonthlyPackageTransferGB:(downloads+sourceViews)*8388608/1e9,
 storageAfter30MaxSizeUploadsBytes:17484420+uploads*8388608,
 workerMarginalUSDIfAllowancesAlreadyExhausted:requests/1e6*0.30+cpuMs/1e6*0.02};
});
const output={date:'2026-09-23',basePlanUSD:5,periodDays:30,assumptions:'One source view, six API reads and four conservatively Worker-charged asset requests per download; thirty maximum-size uploads. No cache savings. Existing restored snapshot unchanged, no new provider copies.',rows,limitations:['Account-wide allowances and unrelated workloads unknown','Taxes, paid logs, abuse, background polling, backups and future storage growth excluded','CPU samples are not throughput or peak-memory proof','R2 billable units round up; marginal fractional arithmetic is not an exact invoice'],sources:['https://developers.cloudflare.com/workers/platform/pricing/','https://developers.cloudflare.com/r2/pricing/','https://developers.cloudflare.com/d1/platform/pricing/']};
const out=path.resolve(process.argv[2]||'.qa/source-budget/cost-model.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(rows,null,2));
