import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePreviewPilotTarget,runPreviewSignedPilot}
  from '../scripts/preview-signed-pilot.mjs';

const url='https://social-agent-room-sbg5t1d3i-contact101-8081.vercel.app/';
const sha='a'.repeat(40);
const adminKey='test-only-isolated-preview-admin-key';
const ready={status:'ok',environment:'preview',schema_ready:true,
  schema_tables:51,expected_tables:51,schema_columns:30,expected_columns:30,
  schema_indexes:8,expected_indexes:8,revision:sha};

test('pilot refuses production, cross-origin, URL credentials, unpinned releases',async()=>{
  let calls=0;
  const none=async()=>{calls++;throw Error('Must never fetch')};
  const unsafe=[
    'https://social-agent-room.vercel.app/',
    'https://social-agent-room-contact101-8081.vercel.app/',
    'https://not-social-agent-room-preview-contact101-8081.vercel.app/',
    'https://social-agent-room-preview-otherteam.vercel.app/',
    'https://social-agent-room-abc-contact101-8081.vercel.app/ready',
    'https://social-agent-room-abc-contact101-8081.vercel.app/?token=secret',
    'https://me:secret@social-agent-room-abc-contact101-8081.vercel.app/',
    'http://social-agent-room-abc-contact101-8081.vercel.app/'
  ];
  for(const baseUrl of unsafe){
    assert.throws(()=>validatePreviewPilotTarget({baseUrl,expectedSha:sha,adminKey}));
    await assert.rejects(runPreviewSignedPilot({
      baseUrl,expectedSha:sha,adminKey,fetchImpl:none
    }));
  }
  for(const expectedSha of ['short','A'.repeat(40),null]){
    assert.throws(()=>validatePreviewPilotTarget({baseUrl:url,expectedSha,adminKey}));
  }
  assert.throws(()=>validatePreviewPilotTarget({baseUrl:url,expectedSha:sha}));
  assert.equal(validatePreviewPilotTarget({baseUrl:url,expectedSha:sha,adminKey}),
    url.slice(0,-1));
  assert.equal(calls,0,'Bad destinations must fail before network access');
});

test('pilot refuses stale deployment before making any POST or admin request',async()=>{
  const requests=[];
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:url,expectedSha:sha,adminKey,
    fetchImpl:async(target,options)=>{
      requests.push({path:new URL(target).pathname,method:options.method});
      return Response.json({...ready,revision:'b'.repeat(40)});
    }
  }),/Deployment revision drift/);
  assert.deepEqual(requests,[{path:'/ready',method:'GET'}]);
});

test('pilot requires preview operator authorization before creating an invitation',async()=>{
  const requests=[];
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:url,expectedSha:sha,adminKey,
    fetchImpl:async(target,options)=>{
      const path=new URL(target).pathname;
      requests.push({path,method:options.method,redirect:options.redirect,
        credentials:options.credentials});
      assert.equal(options.redirect,'manual');
      assert.equal(options.credentials,'omit');
      if(path==='/ready')return Response.json(ready);
      if(path==='/v1/admin/onboarding-status')
        return Response.json({error:'Forbidden'},{status:403});
      throw Error('Unexpected mutation');
    }
  }),/Preview operator access returned HTTP 403/);
  assert.deepEqual(requests.map(x=>x.method),['GET','GET']);
});

test('pilot rejects authentication redirects rather than following them',async()=>{
  const calls=[];
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:url,expectedSha:sha,adminKey,
    fetchImpl:async(target,options)=>{
      calls.push(new URL(target).pathname);
      assert.equal(options.redirect,'manual');
      return new Response(null,{status:302,headers:{
        location:'https://vercel.com/login'
      }});
    }
  }),/refused authentication redirect/);
  assert.deepEqual(calls,['/ready']);
});

test('pilot refuses unexpected hosted environment without issuing invitations',async()=>{
  let requestCount=0;
  await assert.rejects(runPreviewSignedPilot({
    baseUrl:url,expectedSha:sha,adminKey,
    fetchImpl:async(target,options)=>{
      requestCount++;
      assert.equal(new URL(target).pathname,'/ready');
      assert.equal(options.method,'GET');
      return Response.json({...ready,environment:'production'});
    }
  }),/Production\/unknown environment rejected/);
  assert.equal(requestCount,1);
});
