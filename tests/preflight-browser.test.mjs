import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const script=await readFile(new URL('../public/preflight.js',import.meta.url),'utf8');
const sha='a'.repeat(40);
const approvedHost='social-agent-room-git-fix-rc6-dating-age-f0e136-contact101-8081.vercel.app';
const result=(body,status=200,mime='application/json')=>
  new Response(typeof body==='string'?body:JSON.stringify(body),
    {status,headers:{'content-type':mime}});
const privatePaths=new Set([
  '/v1/life/arrival','/v1/life/clubs','/v1/life/dating/hub/me',
  '/v1/life/dating/hub/browse','/v1/life/dating/hub/received',
  '/v1/life/comedy/feed','/v1/life/gardens','/v1/life/lounge/rooms',
  '/v1/life/gallery/collections','/v1/life/night/rooms',
  '/v1/life/feed/polls','/v1/life/feed/events'
]);
const baseline=async path=>{
  if(path==='/ready')return result({status:'ok',service:'SOC·IA·L',schema_ready:true,schema_tables:51,expected_tables:51,schema_columns:30,expected_columns:30,schema_indexes:8,expected_indexes:8,revision:sha});
  if(path==='/v1/room/info')return result({
    agent_signed_registration:'/v1/agents/a2a',
    agent_identity_recovery:'/v1/agents/a2a/recover',
    agent_life_entry:'/v1/life/arrival',
    life_public_directory:'/v1/life/directory'
  });
  if(path==='/.well-known/soc-agent-identity.json')return result({
    identity_profile:'SOCIAL-A2A-REQUEST-V1',recovery:'/v1/agents/a2a/recover'});
  if(path==='/v1/product/features')return result({spaces:[
    'life','social-club','dating','comedy','garden','lounge','gallery','afterdark',
    'factory','lab','academy','market','council'
  ].map(id=>({id}))});
  if(path==='/v1/life/directory')return result({
    kind:'public-capability-directory',
    notices:{metadata_only:true,no_private_content:true},
    places:['social-feed','social-club','dating-hub','comedy-club',
      'garden','lounge','gallery','after-dark'].map(id=>({
        id,access:'authenticated-agent'
      }))
  });
  if(path==='/openapi.yaml')return result('openapi: 3.0.3',200,'text/yaml');
  if(path==='/agents.html')return result(
    '<a href="local-mcp.mjs">26 MCP tools</a><script src="/operator.js"></script><script src="/preflight.js"></script>',
    200,'text/html');
  if(path==='/operator.js')return result(
    'const a="/v1/admin/onboarding-status", b="/v1/admin/invitations";',
    200,'text/javascript');
  if(path==='/v1/admin/onboarding-status')return result({error:'Forbidden'},403);
  if(privatePaths.has(path))return result({error:'Signed agent required'},401);
  throw Error('Unexpected unreviewed path '+path);
};
function createDOM({host=approvedHost,fetchImpl=baseline,clipboardImpl}={}){
  const controls=new Map();
  const makeElement=tag=>({
    tagName:tag.toUpperCase(),className:'',textContent:'',value:'',
    children:[],dataset:{},disabled:false,listeners:{},
    setAttribute(name,value){this[name]=value;},
    append(...nodes){this.children.push(...nodes);},
    replaceChildren(...nodes){this.children=[...nodes];},
    addEventListener(name,fn){this.listeners[name]=fn;},
    focus(){this.focused=true;},
    select(){this.selected=true;}
  });
  for(const id of ['preflight-run','preflight-results','preflight-summary',
    'preflight-progress','preflight-revision','preflight-expected-sha',
    'preflight-copy','preflight-report','preflight-report-status']){
    controls.set(id,makeElement('div'));
  }
  const seen=[];
  const fetch=async(path,options)=>{
    seen.push({path,options});
    return fetchImpl(path,options);
  };
  vm.runInNewContext(script,{
    document:{
      getElementById:id=>controls.get(id)||null,
      createElement:makeElement
    },
    location:{protocol:'https:',hostname:host},
    navigator:{clipboard:{writeText:clipboardImpl||(async()=>{throw Error('Clipboard blocked');})}},
    fetch,Response,AbortController,setTimeout,clearTimeout
  },{timeout:1500});
  const get=id=>controls.get('preflight-'+id);
  return {get,seen,run:async()=>get('run').listeners.click(),
    copy:async()=>get('copy').listeners.click()};
}
test('browser inspector verifies all 21 preview checks via GET only with an exact SHA',async()=>{
  const page=createDOM();
  page.get('expected-sha').value=sha;
  await page.run();
  assert.equal(page.seen.length,21);
  assert.equal(page.seen.filter(x=>x.options.method!=='GET').length,0);
  assert.equal(page.seen.filter(x=>x.options.redirect!=='manual').length,0);
  assert.equal(page.seen.filter(x=>x.options.credentials!=='same-origin').length,0);
  assert.equal(page.get('summary').dataset.status,'pass');
  assert.match(page.get('summary').textContent,/21 \/ 21/);
  assert.equal(page.get('revision').textContent,'Deployment revision: '+sha);
  assert.equal(page.get('run').disabled,false);
  const rows=page.get('results').children.filter(c=>c.className.startsWith('preflight-row'));
  assert.equal(rows.length,21);
  assert.equal(rows.filter(c=>c.className.includes('pass')).length,21);
  assert.equal(page.seen.filter(x=>x.path==='/v1/admin/invitations').length,0);
});
test('browser inspector reports unconfirmed SHA and fails closed on wrong revision',async()=>{
  const page=createDOM();
  await page.run();
  assert.equal(page.get('summary').dataset.status,'warn');
  assert.match(page.get('progress').textContent,/1 to confirm/);
  page.get('expected-sha').value='b'.repeat(40);
  await page.run();
  assert.equal(page.get('summary').dataset.status,'fail');
  const rows=page.get('results').children.filter(c=>c.className.startsWith('preflight-row'));
  assert.equal(rows.filter(c=>c.className.includes('fail')).length,1);
  assert.equal(page.seen.length,42);
});
test('browser inspector rejects an incomplete database schema even if HTTP reports 200',async()=>{
  const page=createDOM({fetchImpl:async path=>path==='/ready'?
    result({status:'ok',service:'SOC·IA·L',schema_ready:false,schema_tables:23,expected_tables:51,revision:sha}):baseline(path)});
  page.get('expected-sha').value=sha;
  await page.run();
  assert.equal(page.get('summary').dataset.status,'fail');
  const rows=page.get('results').children.filter(c=>c.className.startsWith('preflight-row'));
  assert.equal(rows.filter(c=>c.className.includes('fail')).length,1);
});
test('browser inspector refuses all requests outside approved preview domain',async()=>{
  let calls=0;
  const malicious=async()=>{calls++;throw Error('unexpected network')};
  for(const host of ['social-agent-room.vercel.app',
    'social-agent-room-contact101-8081.vercel.app',
    'other-team.preview.vercel.app','social-agent-room-attacker.example.net']){
    const page=createDOM({host,fetchImpl:malicious});
    assert.equal(page.get('run').disabled,true);
    await page.run();
    assert.equal(page.seen.length,0);
  }
  assert.equal(calls,0);
});
test('browser inspector exposes failures instead of treating SSO redirects or private leaks as passing',async()=>{
  const fake=async path=>{
    if(path==='/v1/life/arrival')return result({private_posts:[]},200);
    if(path==='/agents.html')return new Response(null,{status:302,
      headers:{location:'https://vercel.com/login'}});
    return baseline(path);
  };
  const page=createDOM({fetchImpl:fake});
  page.get('expected-sha').value=sha;
  await page.run();
  assert.equal(page.get('summary').dataset.status,'fail');
  const rows=page.get('results').children.filter(c=>c.className.startsWith('preflight-row'));
  assert.equal(rows.filter(c=>c.className.includes('fail')).length,2);
  assert.match(page.get('progress').textContent,/2 failed/);
});
test('browser inspector rejects malformed revision before issuing any requests',async()=>{
  const page=createDOM();
  page.get('expected-sha').value='not-a-sha';
  await page.run();
  assert.equal(page.seen.length,0);
  assert.match(page.get('summary').textContent,/Invalid Git revision/);
});


test('21-check diagnostic report contains only bounded public metadata and is copied on demand',async()=>{
  const received=[];
  const page=createDOM({clipboardImpl:async value=>received.push(value),
    fetchImpl:async path=>{
      if(path==='/v1/room/info'){
        const body=await (await baseline(path)).json();
        // Even if a public endpoint mistakenly adds dangerous extra fields,
        // the export must never materialize or print them.
        body.authorization='SOC-PRIVATE-OPERATOR-KEY';
        body.private_agent_message='SOC-PRIVATE-MESSAGE';
        return result(body);
      }
      return baseline(path);
    }
  });
  assert.equal(page.get('copy').disabled,true);
  assert.equal(page.get('report').hidden,true);
  assert.equal(received.length,0);
  page.get('expected-sha').value=sha;
  await page.run();
  assert.equal(page.get('copy').disabled,false);
  assert.equal(page.get('report').hidden,false);
  const report=JSON.parse(page.get('report').value);
  assert.equal(report.schema,'SOCIAL_PREVIEW_PREFLIGHT_V1');
  assert.equal(report.expected_revision,sha);
  assert.equal(report.observed_revision,sha);
  assert.equal(report.totals.checked,21);
  assert.equal(report.totals.passed,21);
  assert.equal(report.verdict,'PASS');
  assert.equal(report.checks.length,21);
  assert.equal(report.preview_host,approvedHost);
  assert.ok(report.checks.every(x=>!('response_body' in x)&&
    !('headers' in x)&&typeof x.path==='string'&&x.path.startsWith('/')&&
    ['pass','warn','fail'].includes(x.result)));
  assert.ok(!page.get('report').value.includes('SOC-PRIVATE-OPERATOR-KEY'));
  assert.ok(!page.get('report').value.includes('SOC-PRIVATE-MESSAGE'));
  assert.ok(!page.get('report').value.includes('token'));
  // A user click is required before clipboard access.
  assert.equal(received.length,0);
  await page.copy();
  assert.deepEqual(received,[page.get('report').value]);
  assert.equal(page.seen.length,21,'Copying report must never trigger more API calls');
});

test('clipboard denial still exposes a selectable report for iPhone webviews',async()=>{
  const page=createDOM({clipboardImpl:async()=>{throw Error('Permission denied');}});
  page.get('expected-sha').value=sha;
  await page.run();
  await page.copy();
  assert.equal(page.get('report').selected,true);
  assert.equal(page.get('report').focused,true);
  assert.match(page.get('report-status').textContent,/manual/);
  assert.equal(page.seen.length,21);
});

test('re-running clears stale diagnostics, and a missing SHA can never claim PASS',async()=>{
  const page=createDOM();
  await page.run();
  const report=JSON.parse(page.get('report').value);
  assert.equal(report.verdict,'NOT_CONFIRMED');
  assert.equal(report.totals.unconfirmed,1);
  page.get('expected-sha').value='invalid';
  await page.run();
  assert.equal(page.get('copy').disabled,true);
  assert.equal(page.get('report').hidden,true);
  assert.equal(page.get('report').value,'');
  assert.equal(page.seen.length,21,'Invalid SHA must block new requests');
});
