import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Explicit, read-only, preview-only release gate. No credentials, agent
// enrollments, database migrations or production probes are performed.
const productionAliases=new Set([
  'social-agent-room.vercel.app',
  'social-agent-room-contact101-8081.vercel.app'
]);
const paths=[
  ['/v1/room/info',200,'application/json'],
  ['/.well-known/soc-agent-identity.json',200,'application/json'],
  ['/v1/product/features',200,'application/json'],
  ['/openapi.yaml',200,'text/'],
  ['/agents.html',200,'text/html'],
  ['/v1/life/arrival',401,'application/json'],
  ['/v1/life/clubs',401,'application/json'],
  ['/v1/life/dating/hub/me',401,'application/json'],
  ['/v1/life/dating/hub/browse',401,'application/json'],
  ['/v1/life/dating/hub/received',401,'application/json'],
  ['/v1/life/comedy/feed',401,'application/json'],
  ['/v1/life/gardens',401,'application/json'],
  ['/v1/life/lounge/rooms',401,'application/json'],
  ['/v1/life/gallery/collections',401,'application/json'],
  ['/v1/life/night/rooms',401,'application/json'],
  ['/v1/life/feed/polls',401,'application/json'],
  ['/v1/life/feed/events',401,'application/json']
];

export async function previewReadiness({baseUrl,expectedSha,fetchImpl=fetch}={}){
  if(typeof baseUrl!=='string'||typeof expectedSha!=='string'||
    !/^[a-f0-9]{40}$/.test(expectedSha))
    throw Error('Explicit preview URL and exact 40-char Git commit SHA required');
  const origin=new URL(baseUrl);
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.vercel.app')||
    origin.username||origin.password||origin.pathname!=='/'||
    origin.search||origin.hash||productionAliases.has(origin.hostname))
    throw Error('Only an explicit isolated HTTPS Vercel preview hostname is allowed');
  const get=async path=>{
    const response=await fetchImpl(origin.origin+path,{
      method:'GET',redirect:'manual',cache:'no-store',
      signal:AbortSignal.timeout(12_000)
    });
    if(response.status>=300&&response.status<400)
      throw Error('Preview requires authorization or redirects: '+path);
    return response;
  };
  const health=await get('/health');
  if(health.status!==200)throw Error('Preview database health failed: HTTP '+health.status);
  const body=await health.json();
  if(body.status!=='ok'||body.revision!==expectedSha)
    throw Error('Wrong deployed build: expected exact reviewed SHA in /health');
  const inspected=[];
  for(const [path,status,contentType] of paths){
    const response=await get(path);
    if(response.status!==status)
      throw Error('Preview gate failed '+path+' (expected '+status+', got '+response.status+')');
    if(!(response.headers.get('content-type')||'').includes(contentType))
      throw Error('Preview returned unexpected content type at '+path);
    if(path==='/v1/room/info'){
      const data=await response.json();
      if(data.agent_signed_registration!=='/v1/agents/a2a'||
        data.agent_life_entry!=='/v1/life/arrival'||
        data.dating_hub_status!=='/v1/life/dating/hub/me'||
        data.dating_hub_received!=='/v1/life/dating/hub/received')
        throw Error('Agent discovery is outdated');
    }else if(path==='/.well-known/soc-agent-identity.json'){
      const data=await response.json();
      if(data.identity_profile!=='SOCIAL-A2A-REQUEST-V1')
        throw Error('Persistent agent signature profile missing');
    }else if(path==='/v1/product/features'){
      const data=await response.json();
      if(!data?.spaces||!Array.isArray(data.spaces)||
        !['life','social-club','dating','comedy','garden','lounge','gallery','afterdark']
          .every(name=>data.spaces.some(space=>space.id===name)))
        throw Error('Incomplete LIFE feature catalogue');
    }
    inspected.push(path);
  }
  return Object.freeze({
    ready:true,revision:expectedSha,environment:'protected-preview',
    passed:1+inspected.length,scope:'read-only metadata and unauthenticated denial checks',
    authenticated_agents_verified:false
  });
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{
    const result=await previewReadiness({
      baseUrl:process.env.SOCIAL_PREVIEW_URL,
      expectedSha:process.env.SOCIAL_EXPECTED_SHA
    });
    console.log(JSON.stringify(result,null,2));
  }catch(e){
    // No secrets or complete request URLs in operational error output.
    console.error('PREVIEW NOT READY:',e.message);
    process.exitCode=1;
  }
}
