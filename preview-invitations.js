import express from 'express';

// Operator-only recovery for stranded invitation records in an isolated preview.
// The API lists UUIDs and timestamps, NEVER invite tokens, hashes or agent data.
// Production cannot access these routes even with a valid production admin key.
const inviteUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safe=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

export function createPreviewInvitationAdminRouter(pool,adminAllowed,{mode}={},limiter=(_req,_res,next)=>next()){
  const router=express.Router();
  const guarded=(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(mode!=='preview')return res.status(404).json({error:'Not found'});
    if(!adminAllowed(req))return res.status(403).json({error:'Administrator authorization required'});
    next();
  };
  router.get('/admin/invitations',limiter,guarded,safe(async(_req,res)=>{
    const result=await pool.query(
      'SELECT id::text,created_at,expires_at FROM agent_invites '+
      'WHERE consumed_at IS NULL AND expires_at>now() '+
      'ORDER BY created_at ASC,id ASC LIMIT 50');
    res.json({scope:'preview-operator-only',invitations:result.rows,
      truncated:result.rows.length===50,
      notice:'Metadata only. No invitation tokens or secret hashes are returned.'});
  }));
  router.delete('/admin/invitations/:id',limiter,guarded,safe(async(req,res)=>{
    if(!inviteUuid.test(req.params.id))return res.status(400).json({error:'Invalid invitation UUID'});
    // Existing schema has a single terminal marker: consumed_at. Reuse it
    // for manual invalidation (NOT proof that an agent redeemed the token).
    // Retain the record and secret hash for audit; never delete anything.
    // Redemption and invalidation race atomically on the same row.
    const result=await pool.query(
      'UPDATE agent_invites SET consumed_at=now() WHERE id=$1::uuid '+
      'AND consumed_at IS NULL AND expires_at>now() RETURNING id::text',
      [req.params.id]);
    if(!result.rowCount)return res.status(404).json({error:'No active invitation with this ID'});
    res.json({id:result.rows[0].id,status:'invalidated',
      warning:'consumed_at is a shared terminal marker; it does not prove redemption'});
  }));
  return router;
}
