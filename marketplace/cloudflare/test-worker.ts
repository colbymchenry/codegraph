// Test-only entrypoint. Production wrangler.jsonc targets worker.ts instead.
import { createHandler } from './worker';
export default {fetch(request:Request,env:any){return createHandler(async phase=>{if(request.headers.get('x-test-kill')===phase)await env.TEST_BOUNDARY.fetch(new Request('http://boundary/'+phase));if(request.headers.get('x-test-failure')===phase)throw Error('Injected service boundary failure');})(request,env);}};
