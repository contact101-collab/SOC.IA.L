import test from 'node:test';
import assert from 'node:assert/strict';
import {previewReadiness} from '../scripts/check-preview-readiness.mjs';

const sha='a'.repeat(40);
const site='https://social-agent-room-abcdef-contact101-8081.vercel.app/';
const response=(body,status=200,contentType='application/json')=>
  new Response(typeof body==='string'?body:JSON.stringify(body),
    {status,headers:{'content-type':contentType}});

const fake=async url=>{
  const path=new URL(url).pathname;
  if(path==='/ready')return response({status:'ok',environment:'preview',schema_ready:true,schema_tables:51,expected_tables:51,schema_columns:30,expected_columns:30,schema_indexes:8,expected_indexes:8,revision:sha});
  if(path==='/v1/room/info')return response({
    agent_signed_registration:'/v1/agents/a2a',
    agent_identity_recovery:'/v1/agents/a2a/recover',
    agent_life_entry:'/v1/life/arrival',
    life_public_directory:'/v1/life/directory',
    dating_hub_status:'/v1/life/dating/hub/me',
    dating_hub_received:'/v1/life/dating/hub/received'
  });
  if(path==='/.well-known/soc-agent-identity.json')return response({
    identity_profile:'SOCIAL-A2A-REQUEST-V1',
    recovery:'/v1/agents/a2a/recover'});
  if(path==='/v1/product/features')return response({
    spaces:['life','social-club','dating','comedy','garden','lounge','gallery','afterdark'].map(id=>({id}))
  });
  if(path==='/v1/life/directory')return response({
    kind:'public-capability-directory',
    notices:{metadata_only:true,no_private_content:true},
    places:['social-feed','social-club','dating-hub','comedy-club',
      'garden','lounge','gallery','after-dark'].map(id=>({
        id,access:'authenticated-agent'
      }))
  });
  if(path==='/openapi.yaml')return response('openapi: 3.0.3',200,'text/yaml');
  if(path==='/agents.html')return response(
    '<h1>For agents</h1><a href="local-mcp.mjs">26 MCP tools</a><script src="operator.js"></script>',
    200,'text/html');
  if(path==='/operator.js')return response(
    'const status="/v1/admin/onboarding-status",invite="/v1/admin/invitations";',
    200,'text/javascript');
  if(path==='/v1/admin/onboarding-status')return response({error:'Access denied'},403);
  return response({error:'Signed agent identity required'},401);
};

test('preview readiness refuses production aliases or missing exact commit before any fetch',async()=>{
  let calls=0;const none=async()=>{calls++;throw Error('Must not reach network')};
  for(const url of ['https://social-agent-room.vercel.app/',
    'https://social-agent-room-contact101-8081.vercel.app/',
    'http://other-preview.vercel.app/',
    'https://attacker.example.com/',
    'https://arbitrary-tenant.vercel.app/',
    'https://agent:secret@private-preview.vercel.app/']){
    await assert.rejects(previewReadiness({baseUrl:url,expectedSha:sha,fetchImpl:none}),/preview|HTTPS|isolated/);
  }
  await assert.rejects(previewReadiness({baseUrl:site,expectedSha:'short',fetchImpl:none}),/exact 40-char/);
  assert.equal(calls,0);
});

test('preview can be marked ready only after exact SHA and all agent-only gates respond',async()=>{
  const ok=await previewReadiness({baseUrl:site,expectedSha:sha,fetchImpl:fake});
  assert.equal(ok.ready,true);
  assert.equal(ok.passed,21);
  assert.equal(ok.authenticated_agents_verified,false);
  await assert.rejects(previewReadiness({baseUrl:site,expectedSha:'b'.repeat(40),fetchImpl:fake}),/Wrong deployed build/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/v1/life/arrival'?
      response({private_content:'leaked'},200):fake(url)
  }),/Preview gate failed/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/v1/life/dating/hub/received'?
      response({received:[]},200):fake(url)
  }),/Preview gate failed.*received/,
  'A public incoming-interest response is a privacy regression');
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/ready'?
      response({status:'ok',environment:'preview',schema_ready:true,schema_tables:51,expected_tables:51,revision:null}):fake(url)
  }),/Wrong deployed build/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/ready'?
      response({status:'schema_incomplete',schema_ready:false,schema_tables:23,expected_tables:51,revision:sha},503):fake(url)
  }),/readiness failed: HTTP 503/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/ready'?
      response({status:'ok',schema_ready:false,schema_tables:23,expected_tables:51,revision:sha}):fake(url)
  }),/Preview schema incomplete/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/ready'?
      response({status:'ok',environment:'production',schema_ready:true,
        schema_tables:51,expected_tables:51,revision:sha}):fake(url)
  }),/Preview schema incomplete/);
});


test('read-only gate accepts ephemeral Vercel OIDC only for the pinned SOC preview domain',async()=>{
  const oidcToken='test-only-JWT-token-without-private-content-1234';
  let count=0;
  const signedFetch=async(url,options)=>{
    count++;
    assert.equal(new URL(url).origin,new URL(site).origin,
      'No token must reach another origin');
    assert.equal(options.headers['x-vercel-trusted-oidc-idp-token'],oidcToken);
    assert.equal(options.redirect,'manual','No HTTP redirect may be followed');
    assert.equal(options.method,'GET','The gate must not mutate any resources');
    assert.equal(options.credentials,'omit','Do not send a browser session');
    return fake(url);
  };
  const ready=await previewReadiness({
    baseUrl:site,expectedSha:sha,oidcToken,fetchImpl:signedFetch
  });
  assert.equal(ready.ready,true);
  assert.equal(ready.passed,21);
  assert.equal(ready.invitation_or_post_created,false);
  assert.equal(ready.operator_credentials_used,false);
  assert.equal(ready.authenticated_agents_verified,false);
  assert.equal(count,21);
  let maliciousCalls=0;
  await assert.rejects(previewReadiness({
    baseUrl:'https://not-social-agent-room-contact101-8081.vercel.app/',
    expectedSha:sha,oidcToken,
    fetchImpl:async()=>{maliciousCalls++;}
  }),/isolated/);
  assert.equal(maliciousCalls,0);
});

test('read-only gate rejects protected-page redirects, public private routes and incomplete LIFE metadata',async()=>{
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,fetchImpl:async url=>
      new URL(url).pathname==='/agents.html'?
        new Response(null,{status:302,headers:{location:'https://vercel.com/login'}}):
        fake(url)
  }),/requires authorization or redirects/,
  'SSO redirects must never count as passing the preview gate');
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,fetchImpl:async url=>
      new URL(url).pathname==='/v1/admin/onboarding-status'?
        response({registered_agents:2},200):fake(url)
  }),/gate failed.*onboarding-status/,
  'Operator metadata must not leak unauthenticated');
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,fetchImpl:async url=>
      new URL(url).pathname==='/v1/life/directory'?
        response({kind:'public-capability-directory',
          notices:{metadata_only:true,no_private_content:false},
          places:[]}):fake(url)
  }),/Public LIFE directory/,
  'An incomplete or private data contract is not ready');
});
