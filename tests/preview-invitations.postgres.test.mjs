import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {createPreviewInvitationAdminRouter} from '../preview-invitations.js';

// Real PostgreSQL schema and HTTP router on a disposable CI localhost database.
// Never run this test against Neon, production or a remote PostgreSQL server.
test('preview-only operator can invalidate a stranded invitation without disclosing its token',async t=>{
  const db=process.env.TEST_DATABASE_URL;
  if(!db){t.skip('Requires disposable PostgreSQL service');return;}
  let parsed;
  try{parsed=new URL(db);}catch{throw Error('Invalid CI test PostgreSQL URL');}
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||
     parsed.pathname!=='/social_test')
    throw Error('Refusing to touch any database other than localhost/social_test');
  const pool=new pg.Pool({connectionString:db,ssl:false});
  const auth=req=>req.get('x-admin-key')==='ci-preview-test-only';
  const preview=express();
  preview.use('/v1',createPreviewInvitationAdminRouter(pool,auth,{mode:'preview'}));
  const production=express();
  production.use('/v1',createPreviewInvitationAdminRouter(pool,auth,{mode:'production'}));
  const listen=app=>new Promise(resolve=>{
    const server=app.listen(0,'127.0.0.1',()=>resolve(server));
  });
  const previewServer=await listen(preview),productionServer=await listen(production);
  const origin=server=>'http://127.0.0.1:'+server.address().port;
  const call=async(server,method,path,allowed=true)=>{
    const response=await fetch(origin(server)+path,{
      method,headers:allowed?{'x-admin-key':'ci-preview-test-only'}:{},
      signal:AbortSignal.timeout(8000)
    });
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  let id;
  try{
    const secret='soci_'+randomBytes(32).toString('hex');
    const fingerprint=createHash('sha256').update(secret).digest('hex');
    const inserted=await pool.query(
      "INSERT INTO agent_invites(secret_hash,expires_at) VALUES($1,now()+interval '1 hour') RETURNING id::text",
      [fingerprint]);
    id=inserted.rows[0].id;
    assert.equal((await call(previewServer,'GET','/v1/admin/invitations',false)).status,403);
    assert.equal((await call(previewServer,'DELETE','/v1/admin/invitations/'+id,false)).status,403);
    assert.equal((await call(productionServer,'GET','/v1/admin/invitations')).status,404);
    assert.equal((await call(productionServer,'DELETE','/v1/admin/invitations/'+id)).status,404);
    const listing=await call(previewServer,'GET','/v1/admin/invitations');
    assert.equal(listing.status,200);
    assert.equal(listing.headers.get('cache-control'),'no-store');
    const item=listing.body.invitations.find(x=>x.id===id);
    assert.ok(item,'Only preview operator can see the active invitation UUID');
    assert.ok(item.created_at&&item.expires_at);
    assert.deepEqual(Object.keys(item).sort(),['created_at','expires_at','id']);
    assert.ok(!JSON.stringify(listing.body).includes(secret));
    assert.ok(!JSON.stringify(listing.body).includes(fingerprint));
    assert.equal((await call(previewServer,'DELETE','/v1/admin/invitations/not-a-uuid')).status,400);
    const removed=await call(previewServer,'DELETE','/v1/admin/invitations/'+id);
    assert.equal(removed.status,200);
    assert.equal(removed.headers.get('cache-control'),'no-store');
    assert.equal(removed.body.status,'invalidated');
    assert.equal(removed.body.id,id);
    assert.equal((await call(previewServer,'DELETE','/v1/admin/invitations/'+id)).status,404);
    const after=await call(previewServer,'GET','/v1/admin/invitations');
    assert.ok(!after.body.invitations.some(x=>x.id===id));
    const stored=await pool.query(
      'SELECT secret_hash,consumed_at,expires_at FROM agent_invites WHERE id=$1',[id]);
    assert.equal(stored.rowCount,1,'Audit row must be retained, not deleted');
    assert.ok(stored.rows[0].consumed_at,'Invalidation sets the existing terminal marker');
    assert.ok(stored.rows[0].expires_at>new Date(),'Expiry remains original');
    const attempted=await pool.query(
      'UPDATE agent_invites SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id',[id]);
    assert.equal(attempted.rowCount,0,'Invalidated invitation can never be redeemed');
  }finally{
    if(id)await pool.query('DELETE FROM agent_invites WHERE id=$1',[id]);
    await new Promise(resolve=>previewServer.close(resolve));
    await new Promise(resolve=>productionServer.close(resolve));
    await pool.end();
  }
});
