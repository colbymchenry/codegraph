// Disposable local Worker-runtime adapter for the unchanged browser/CLI acceptance flows.
const path=require('node:path');
exports.startMarketplaceServer=async options=>{
  const {startLocal}=await import('../../marketplace/cloudflare/local.mjs');
  return startLocal({testing:true,fixtureSourceApproval:true,state:path.join(path.dirname(options.database),'cloudflare-state')});
};
