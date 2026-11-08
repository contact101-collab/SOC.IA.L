import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Manual, strictly read-only preview release gate. It NEVER uses the
// administrator key or registers a participant, and refuses production.
const productionAliases=new Set([
  'social-agent-room.vercel.app',
  'social-agent-room-contact101-8081.vercel.app'
]);
const eightLifePlaces=new Set([
  'social-feed','social-club','dating-hub','comedy-club',
  'garden','lounge','gallery','after-dark'
]);
const paths=[
  ['/v1/room/info',200,'application/json'],
  ['/.well-known/soc-agent-identity.json',200,'application/json'],
  ['/v1/product/features',200,'application/json'],
  ['/v1/life/directory',200,'application/json'],
  ['/openapi.yaml',200,'text/'],
  ['/agents.html',200,'text/html'],
  ['/operator.js',200,'javascript'],
  ['/v1/admin/onboarding-status',403,'application/json'],
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

const expectedHost=hostname=>
  /^social-agent-room-[a-z0-9-]+-contact101-8081\.vercel\.app$/.test(hostname) &&
  !productionAliases.has(hostname);

export async function previewReadiness({
  baseUrl,expectedSha,oidcToken,fetchImpl=fetch
}={}){
  if(typeof baseUrl!=='string'||typeof expectedSha!=='string'||
    !/^[a-f0-9]{40}$/.test(expectedSha))
    throw Error('Explicit preview URL and exact 40-char Git commit SHA required');
  let origin;
  try{origin=new URL(baseUrl);}catch{throw Error('Invalid Vercel preview URL');}
  if(origin.protocol!=='https:'||!expectedHost(origin.hostname)||
    origin.port||origin.username||origin.password||origin.pathname!=='/'||
    origin.search||origin.hash)
    throw Error('Only an isolated HTTPS SOC·IA·L preview hostname is allowed');
  if(oidcToken!==undefined&&(typeof oidcToken!=='string'||
    oidcToken.length<20||oidcToken.length>10000||
    !/^[A-Za-z0-9_.-]+$/.test(oidcToken)))
    throw Error('Invalid temporary Vercel OIDC token');
  const headers={accept:'application/json',
    ...(oidcToken?{'x-vercel-trusted-oidc-idp-token':oidcToken}:{})};
  const get=async path=>{
    const response=await fetchImpl(origin.origin+path,{
      method:'GET',redirect:'manual',cache:'no-store',
      credentials:'omit',headers,
      signal:AbortSignal.timeout(12_000)
    });
    if(response.status>=300&&response.status<400)
      throw Error('Preview requires authorization or redirects at '+path);
    return response;
  };
  const health=await get('/ready');
  if(health.status!==200)throw Error('Preview database/schema readiness failed: HTTP '+health.status);
  if(!(health.headers.get('content-type')||'').includes('application/json'))
    throw Error('Expected JSON readiness status');
  const body=await health.json();
  if(body.status!=='ok'||body.environment!=='preview'||body.schema_ready!==true||body.schema_tables!==51||body.expected_tables!==51)
    throw Error('Preview schema incomplete: all 51 canonical tables required');
  if(body.revision!==expectedSha)
    throw Error('Wrong deployed build: expected exact reviewed SHA in /ready');
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
        data.agent_identity_recovery!=='/v1/agents/a2a/recover'||
        data.agent_life_entry!=='/v1/life/arrival'||
        data.life_public_directory!=='/v1/life/directory')
        throw Error('Agent discovery is outdated');
    }else if(path==='/.well-known/soc-agent-identity.json'){
      const data=await response.json();
      if(data.identity_profile!=='SOCIAL-A2A-REQUEST-V1'||
        data.recovery!=='/v1/agents/a2a/recover')
        throw Error('Persistent agent identity or recovery discovery missing');
    }else if(path==='/v1/product/features'){
      const data=await response.json();
      if(!Array.isArray(data?.spaces)||
        !['life','social-club','dating','comedy','garden','lounge','gallery','afterdark']
          .every(name=>data.spaces.some(space=>space.id===name)))
        throw Error('Incomplete LIFE feature catalogue');
    }else if(path==='/v1/life/directory'){
      const data=await response.json();
      if(data.kind!=='public-capability-directory'||
        data.notices?.metadata_only!==true||
        data.notices?.no_private_content!==true||
        !Array.isArray(data.places)||data.places.length!==8||
        new Set(data.places.map(p=>p.id)).size!==8||
        !data.places.every(p=>eightLifePlaces.has(p.id)&&
          p.access==='authenticated-agent'))
        throw Error('Public LIFE directory is missing or leaks its access contract');
    }else if(path==='/agents.html'){
      const html=await response.text();
      if(!html.includes('local-mcp.mjs')||!html.includes('26 MCP tools')||
        !html.includes('operator.js'))
        throw Error('Deployed agent gateway lacks first-contact integrations');
    }else if(path==='/operator.js'){
      const code=await response.text();
      if(!code.includes('/v1/admin/onboarding-status')||
        !code.includes('/v1/admin/invitations'))
        throw Error('Deployed operator gateway lacks protected controls');
    }
    inspected.push(path);
  }
  return Object.freeze({
    ready:true,revision:expectedSha,environment:'protected-preview',
    passed:1+inspected.length,
    scope:'public read-only metadata, static portal and denied unauthorized access',
    authenticated_agents_verified:false,
    operator_credentials_used:false,
    invitation_or_post_created:false
  });
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{
    const result=await previewReadiness({
      baseUrl:process.env.SOCIAL_PREVIEW_URL,
      expectedSha:process.env.SOCIAL_EXPECTED_SHA,
      oidcToken:process.env.VERCEL_OIDC_TOKEN||undefined
    });
    console.log(JSON.stringify(result,null,2));
  }catch(e){
    // Never print bearer tokens, invitation values or request headers.
    console.error('PREVIEW NOT READY:',e.message);
    process.exitCode=1;
  }
}
