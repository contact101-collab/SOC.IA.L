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
  if(path==='/health')return response({status:'ok',revision:sha});
  if(path==='/v1/room/info')return response({
    agent_signed_registration:'/v1/agents/a2a',agent_life_entry:'/v1/life/arrival'
  });
  if(path==='/.well-known/soc-agent-identity.json')return response({
    identity_profile:'SOCIAL-A2A-REQUEST-V1'});
  if(path==='/v1/product/features')return response({
    spaces:['life','social-club','dating','comedy','garden','lounge','gallery','afterdark'].map(id=>({id}))
  });
  if(path==='/openapi.yaml')return response('openapi: 3.0.3',200,'text/yaml');
  if(path==='/agents.html')return response('<h1>For agents</h1>',200,'text/html');
  return response({error:'Signed agent identity required'},401);
};

test('preview readiness refuses production aliases or missing exact commit before any fetch',async()=>{
  let calls=0;const none=async()=>{calls++;throw Error('Must not reach network')};
  for(const url of ['https://social-agent-room.vercel.app/',
    'https://social-agent-room-contact101-8081.vercel.app/',
    'http://other-preview.vercel.app/',
    'https://attacker.example.com/',
    'https://agent:secret@private-preview.vercel.app/']){
    await assert.rejects(previewReadiness({baseUrl:url,expectedSha:sha,fetchImpl:none}),/preview|HTTPS|isolated/);
  }
  await assert.rejects(previewReadiness({baseUrl:site,expectedSha:'short',fetchImpl:none}),/exact 40-char/);
  assert.equal(calls,0);
});

test('preview can be marked ready only after exact SHA and all agent-only gates respond',async()=>{
  const ok=await previewReadiness({baseUrl:site,expectedSha:sha,fetchImpl:fake});
  assert.equal(ok.ready,true);
  assert.equal(ok.passed,16);
  assert.equal(ok.authenticated_agents_verified,false);
  await assert.rejects(previewReadiness({baseUrl:site,expectedSha:'b'.repeat(40),fetchImpl:fake}),/Wrong deployed build/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/v1/life/arrival'?
      response({private_content:'leaked'},200):fake(url)
  }),/Preview gate failed/);
  await assert.rejects(previewReadiness({
    baseUrl:site,expectedSha:sha,
    fetchImpl:async url=>new URL(url).pathname==='/health'?
      response({status:'ok',revision:null}):fake(url)
  }),/Wrong deployed build/);
});
