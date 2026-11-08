import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deploymentSettings, mcpOriginAllowed } from '../deployment-env.js';

const production='postgresql://owner:prod-secret@prod-compute.example.org/neondb?sslmode=require';
const preview='postgresql://guest:preview-secret@isolated-compute.example.org/neondb?sslmode=require';

test('production and local configurations retain existing behavior',()=>{
  const prod=deploymentSettings({
    VERCEL_ENV:'production',DATABASE_URL:production,ADMIN_KEY:'production-admin',PGSSL:'true'
  });
  assert.equal(prod.databaseUrl,production);
  assert.equal(prod.adminKey,'production-admin');
  assert.equal(prod.mode,'production');
  const local=deploymentSettings({DATABASE_URL:'postgresql://localhost/db',ADMIN_KEY:'dev'});
  assert.equal(local.databaseUrl,'postgresql://localhost/db');
  assert.equal(local.adminKey,'dev');
});


test('hosted Vercel targets fail closed instead of accepting production secrets without an explicit environment',()=>{
  const base={VERCEL:'1',DATABASE_URL:production,ADMIN_KEY:'production-admin'};
  for(const env of [
    base,{...base,VERCEL_ENV:'staging'}, {...base,VERCEL_ENV:'development'},
    {DATABASE_URL:production,ADMIN_KEY:'production-admin',VERCEL_URL:'social-agent-room-preview.vercel.app'}
  ])assert.throws(()=>deploymentSettings(env),/Unsafe hosted environment/);
  const explicitProduction=deploymentSettings({...base,VERCEL_ENV:'production'});
  assert.equal(explicitProduction.databaseUrl,production);
  const safePreview=deploymentSettings({...base,VERCEL_ENV:'preview',SOCIAL_PREVIEW_DATABASE_URL:preview});
  assert.equal(new URL(safePreview.databaseUrl).hostname,'isolated-compute.example.org');
  const localhost=deploymentSettings({DATABASE_URL:'postgresql://localhost/db',ADMIN_KEY:'dev'});
  assert.equal(localhost.mode,'local');
});

test('preview refuses to fall back to the shared production DATABASE_URL',()=>{
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,ADMIN_KEY:'production-admin'
  }),/PostgreSQL URL is required/);
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:production
  }),/database endpoint matches/);
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:'postgresql://different:credentials@prod-compute.example.org/another'
  }),/database endpoint matches/,'Different users and database names do not make the same server safe');
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:'postgresql://preview:pass@localhost/neondb'
  }),/local database address/);
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:'https://not-a-database.example.org'
  }),/PostgreSQL URL/);
});

test('previews use only explicit isolated credentials, with administrative endpoints disabled by default',()=>{
  const isolated=deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:preview,ADMIN_KEY:'production-admin'
  });
  assert.equal(new URL(isolated.databaseUrl).hostname,'isolated-compute.example.org');
  assert.equal(isolated.adminKey,undefined,'Production ADMIN_KEY is ignored by preview runtime');
  assert.equal(isolated.previewIsolated,true);
  assert.throws(()=>deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:preview,ADMIN_KEY:'production-admin',
    SOCIAL_PREVIEW_ADMIN_KEY:'production-admin'
  }),/administrator secret is shared/);
  const separatelyAuthorized=deploymentSettings({
    VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:preview,ADMIN_KEY:'production-admin',
    SOCIAL_PREVIEW_ADMIN_KEY:'different-preview-admin'
  });
  assert.equal(separatelyAuthorized.adminKey,'different-preview-admin');
});

test('real Express server refuses unsafe Vercel previews before opening a database Pool',()=>{
  const env={
    ...process.env,
    SOCIAL_TEST_MODE:'1',VERCEL_ENV:'preview',DATABASE_URL:production,
    ADMIN_KEY:'production-admin',
    PGSSL:'false'
  };
  delete env.SOCIAL_PREVIEW_DATABASE_URL;
  delete env.SOCIAL_PREVIEW_ADMIN_KEY;
  const script="await import('./server.js'); process.stdout.write('UNEXPECTED_STARTUP')";
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:new URL('../',import.meta.url).pathname,env,encoding:'utf8',timeout:10000
  });
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/PostgreSQL URL is required/);
  assert.doesNotMatch(run.stdout,/UNEXPECTED_STARTUP/);
  assert.doesNotMatch(run.stderr,/prod-secret|production-admin/,
    'Fail-closed error must not log credentials');
});

test('real preview Express server uses its isolated DB URL and refuses a production admin key',async()=>{
  const env={
    ...process.env,
    SOCIAL_TEST_MODE:'1',VERCEL_ENV:'preview',DATABASE_URL:production,
    SOCIAL_PREVIEW_DATABASE_URL:preview,ADMIN_KEY:'production-admin',
    PGSSL:'false'
  };
  delete env.SOCIAL_PREVIEW_ADMIN_KEY;
  const script=`
    import assert from 'node:assert/strict';
    const { app, pool }=await import('./server.js');
    assert.equal(new URL(pool.options.connectionString).hostname,'isolated-compute.example.org');
    assert.equal(pool.options.ssl.rejectUnauthorized,true);
    const server=await new Promise(resolve=>{
      const s=app.listen(0,'127.0.0.1',()=>resolve(s));
    });
    try{
      const response=await fetch('http://127.0.0.1:'+server.address().port+
        '/v1/admin/invitations',{method:'POST',headers:{
          'x-admin-key':'production-admin','content-type':'application/json'
        },body:JSON.stringify({expires_in_hours:24})});
      assert.equal(response.status,403);
    }finally{
      await new Promise(resolve=>server.close(resolve));
      await pool.end();
    }
    process.stdout.write('SAFE_PREVIEW_CONFIRMED');
  `;
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:new URL('../',import.meta.url).pathname,env,encoding:'utf8',timeout:10000
  });
  assert.equal(run.status,0,(run.stderr||run.stdout).slice(0,2000));
  assert.match(run.stdout,/SAFE_PREVIEW_CONFIRMED/);
});

test('MCP preview Origin policy accepts only the actual same-origin SOC deployment',()=>{
  const previewHost='social-agent-room-lcotpogp2-contact101-8081.vercel.app';
  const branchHost='social-agent-room-git-fix-rc6-dating-age-f0e136-contact101-8081.vercel.app';
  const previewMode={mode:'preview'};
  assert.equal(mcpOriginAllowed('https://'+previewHost,previewHost,previewMode),true);
  assert.equal(mcpOriginAllowed('https://'+branchHost,branchHost,previewMode),true);
  assert.equal(mcpOriginAllowed(undefined,previewHost,previewMode),true,
    'Trusted non-browser agent runtimes do not send Origin');
  assert.equal(mcpOriginAllowed('https://'+previewHost,branchHost,previewMode),false,
    'Do not permit a different preview as a browser origin');
  assert.equal(mcpOriginAllowed('https://attacker.vercel.app','attacker.vercel.app',previewMode),false);
  assert.equal(mcpOriginAllowed('https://social-agent-room.evil.org','social-agent-room.evil.org',previewMode),false);
  assert.equal(mcpOriginAllowed('https://'+previewHost,previewHost,{mode:'production'}),false);
  assert.equal(mcpOriginAllowed('https://'+previewHost,previewHost,{mode:'local'}),false);
  assert.equal(mcpOriginAllowed('https://social-agent-room.vercel.app',
    'social-agent-room.vercel.app',previewMode),false,
    'A production Origin must never bypass a preview-only browser policy');
  assert.equal(mcpOriginAllowed('https://social-agent-room.vercel.app',
    'social-agent-room.vercel.app',{mode:'production'}),true);
  assert.equal(mcpOriginAllowed('https://social-agent-room.vercel.app',
    previewHost,{mode:'production'}),false);
  assert.equal(mcpOriginAllowed('https://social-agent-room-contact101-8081.vercel.app',
    'social-agent-room-contact101-8081.vercel.app',{mode:'production'}),true);
  assert.equal(mcpOriginAllowed('http://localhost:3000','localhost:3000',{mode:'local'}),true);
  assert.equal(mcpOriginAllowed('http://127.0.0.1:3000','127.0.0.1:3000',{mode:'local'}),true);
  assert.equal(mcpOriginAllowed('http://localhost:3000','127.0.0.1:3000',{mode:'local'}),false);
  assert.equal(mcpOriginAllowed('https://social-agent-room.vercel.app',
    'social-agent-room.vercel.app',{mode:'staging'}),false);
});

test('mounted MCP endpoint rejects foreign browser origins before authentication',()=>{
  const env={
    ...process.env,SOCIAL_TEST_MODE:'1',VERCEL_ENV:'preview',
    DATABASE_URL:production,SOCIAL_PREVIEW_DATABASE_URL:preview,
    PGSSL:'false'
  };
  const script=`
    import assert from 'node:assert/strict';
    const {app,pool}=await import('./server.js');
    const {request}=await import('node:http');
    const s=await new Promise(resolve=>{
      const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));
    });
    try{
      const host='social-agent-room-lcotpogp2-contact101-8081.vercel.app';
      // Node fetch owns Host; use node:http to simulate Vercel's actual Host.
      const attempt=(origin,hostname=host)=>new Promise((resolve,reject)=>{
        const headers={host:hostname,authorization:'Bearer definitely-invalid'};
        if(origin)headers.origin=origin;
        const req=request({host:'127.0.0.1',port:s.address().port,
          path:'/mcp',method:'GET',headers},res=>{
          res.resume();res.on('end',()=>resolve(res.statusCode));
        });
        req.on('error',reject);req.end();
      });
      assert.equal(await attempt('https://'+host),401,
        'Legitimate preview browser Origin may reach authentication');
      assert.equal(await attempt(null),401,
        'Signed Node MCP clients without Origin may reach authentication');
      assert.equal(await attempt('https://other-site.example'),403,
        'Unexpected browser Origin must be forbidden');
      assert.equal(await attempt('https://social-agent-room.vercel.app'),403,
        'Production browser Origin cannot be used on isolated previews');
      assert.equal(await attempt('https://social-agent-room-lcotpogp2-contact101-8081.vercel.app',
        'social-agent-room-something-else-contact101-8081.vercel.app'),403,
        'Origin and host must be identical');
    }finally{
      await new Promise(resolve=>s.close(resolve));
      await pool.end();
    }
    process.stdout.write('PREVIEW_MCP_ORIGIN_GUARD_PASS');
  `;
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:new URL('../',import.meta.url).pathname,env,encoding:'utf8',timeout:15000
  });
  assert.equal(run.status,0,(run.stderr||run.stdout).slice(0,2000));
  assert.match(run.stdout,/PREVIEW_MCP_ORIGIN_GUARD_PASS/);
});
