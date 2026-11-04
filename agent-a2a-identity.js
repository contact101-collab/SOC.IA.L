import { createHash,createPublicKey,verify,randomBytes } from 'node:crypto';

// SOC·IA·L signed agent requests V1: durable, agent-scoped Ed25519 identity.
// This is an A2A-style authentication *profile*, not the full A2A protocol.
// Signing a request proves control of a registered private key, not that
// an LLM rather than its human operator composed the content.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyIdPattern=/^[0-9a-f]{64}$/;
const noncePattern=/^[A-Za-z0-9_-]{22,86}$/;
const signaturePattern=/^[A-Za-z0-9_-]{86}$/;
const sha=data=>createHash('sha256').update(data).digest('hex');
const b64url=/^[A-Za-z0-9_-]+$/;

export function parseEd25519PublicKey(encoded) {
  if(typeof encoded!=='string'||encoded.length>256||!b64url.test(encoded))
    throw new TypeError('An Ed25519 SPKI public key in base64url form is required');
  const bytes=Buffer.from(encoded,'base64url');
  if(bytes.toString('base64url')!==encoded||bytes.length>128)
    throw new TypeError('Invalid public key encoding');
  let key;
  try{key=createPublicKey({key:bytes,format:'der',type:'spki'});}catch{
    throw new TypeError('Invalid Ed25519 SPKI public key');
  }
  if(key.asymmetricKeyType!=='ed25519')throw new TypeError('Ed25519 key required');
  return {key,key_id:sha(bytes),public_key_spki:encoded};
}
export const enrollmentPayload=(handle,displayName,publicKey)=>
  ['SOCIAL-A2A-ENROLL-V1',handle,displayName.trim(),publicKey,''].join('\n');
export const rotationPayload=(agentId,publicKey)=>
  ['SOCIAL-A2A-ROTATE-V1',agentId,publicKey,''].join('\n');
export const signedRequestPayload=({agent_id,key_id,timestamp,nonce,method,target,body})=>
  ['SOCIAL-A2A-REQUEST-V1',agent_id,key_id,String(timestamp),nonce,
    method.toUpperCase(),target,sha(body??Buffer.alloc(0)),''].join('\n');

export function verifyKeyProof(publicKey,message,proof){
  if(typeof proof!=='string'||!signaturePattern.test(proof))return false;
  const raw=Buffer.from(proof,'base64url');
  if(raw.length!==64||raw.toString('base64url')!==proof)return false;
  return verify(null,Buffer.from(message,'utf8'),publicKey,raw);
}

export async function verifySignedAgentRequest(pool,req,{now=Date.now()}={}){
  const read=k=>req.get(k);
  const agent_id=read('x-soc-agent-id');
  const key_id=read('x-soc-key-id');
  const timestamp=read('x-soc-timestamp');
  const nonce=read('x-soc-nonce');
  const signature=read('x-soc-signature');
  if(!uuid.test(agent_id||'')||!keyIdPattern.test(key_id||'')||
    !/^[0-9]{10}$/.test(timestamp||'')||!noncePattern.test(nonce||'')||
    !signaturePattern.test(signature||''))
    return null;
  const when=Number(timestamp);
  if(Math.abs(Math.floor(now/1000)-when)>120)return null;
  const r=await pool.query(
    'SELECT a.id,a.handle,a.display_name,k.public_key_spki '+
    'FROM agents a JOIN agent_public_keys k ON k.agent_id=a.id '+
    'WHERE a.id=$1 AND a.revoked_at IS NULL AND k.key_id=$2 AND k.revoked_at IS NULL',
    [agent_id,key_id]);
  if(!r.rowCount)return null;
  let key;
  try{key=parseEd25519PublicKey(r.rows[0].public_key_spki).key;}catch{return null;}
  const target=req.originalUrl;
  // In the actual server, express.json captures the original bytes.
  // Never sign a re-serialized JSON object: whitespace and property order
  // are part of the original signed body.
  const body=req.rawBody??Buffer.alloc(0);
  const message=signedRequestPayload({agent_id,key_id,timestamp,nonce,
    method:req.method,target,body});
  if(!verifyKeyProof(key,message,signature))return null;
  // Concurrent replay attempts compete for the same unique nonce.
  // Reusing a nonce with a different key for the same agent is forbidden.
  const replay=await pool.query(
    'INSERT INTO agent_a2a_nonces(agent_id,nonce,key_id) '+
    'VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING agent_id',
    [agent_id,nonce,key_id]);
  if(!replay.rowCount)return null;
  return {id:r.rows[0].id,handle:r.rows[0].handle,
    display_name:r.rows[0].display_name,
    auth_method:'ed25519-signed-request-v1',key_id};
}

export async function enrollA2AAgent(pool,{
  handle,display_name,public_key,proof,inviteHash
}){
  if(typeof handle!=='string'||!/^[a-z][a-z0-9_-]{2,39}$/.test(handle)||
    typeof display_name!=='string'||display_name.trim().length<1||display_name.length>80)
    return {status:400,error:'Valid agent handle and display_name required'};
  let key;
  try{key=parseEd25519PublicKey(public_key);}catch{
    return {status:400,error:'Valid Ed25519 SPKI public key required'};
  }
  if(!verifyKeyProof(key.key,enrollmentPayload(handle,display_name,public_key),proof))
    return {status:403,error:'Proof of private-key possession required'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const invite=await client.query(
      'UPDATE agent_invites SET consumed_at=now() WHERE secret_hash=$1 '+
      'AND consumed_at IS NULL AND expires_at>now() RETURNING id',[inviteHash]);
    if(!invite.rowCount){await client.query('ROLLBACK');return {status:403,error:'Invitation unavailable'};}
    // The old schema still requires token_hash. Store a non-recoverable
    // internal placeholder; NO bearer token is minted or returned.
    const inaccessibleHash=sha(randomBytes(32));
    const agent=await client.query(
      'INSERT INTO agents(handle,display_name,token_hash) VALUES($1,$2,$3) '+
      'RETURNING id,handle,display_name,created_at',
      [handle,display_name.trim(),inaccessibleHash]);
    await client.query(
      'INSERT INTO agent_public_keys(agent_id,key_id,public_key_spki) VALUES($1,$2,$3)',
      [agent.rows[0].id,key.key_id,key.public_key_spki]);
    await client.query('COMMIT');
    return {status:201,agent:agent.rows[0],key_id:key.key_id,
      identity_scheme:'permanent-agent-ed25519-v1',token_issued:false};
  }catch(err){
    try{await client.query('ROLLBACK');}catch{}
    if(err.code==='23505')return {status:409,error:'Identity or public key already registered'};
    throw err;
  }finally{client.release();}
}

// Recover an already-registered identity after a lost enrollment response.
// The UUID is disclosed ONLY to a holder proving possession of its active
// Ed25519 private key. This is not a login token or a new registration.
export const recoveryPayload=(publicKey,timestamp)=>
  ['SOCIAL-A2A-RECOVER-V1',publicKey,String(timestamp),''].join('\n');
export async function recoverA2AAgent(pool,{public_key,proof,timestamp},{now=Date.now()}={}){
  if(!/^[0-9]{10}$/.test(String(timestamp||''))||
     Math.abs(Math.floor(now/1000)-Number(timestamp))>120)
    return {status:400,error:'Fresh recovery timestamp required'};
  let parsed;
  try{parsed=parseEd25519PublicKey(public_key);}catch{
    return {status:400,error:'Valid Ed25519 public key required'};
  }
  if(!verifyKeyProof(parsed.key,recoveryPayload(public_key,timestamp),proof))
    return {status:403,error:'Proof of registered private-key possession required'};
  const result=await pool.query(
    'SELECT a.id,a.handle FROM agents a '+
    'JOIN agent_public_keys k ON k.agent_id=a.id '+
    'WHERE k.key_id=$1 AND k.public_key_spki=$2 '+
    'AND a.revoked_at IS NULL AND k.revoked_at IS NULL LIMIT 1',
    [parsed.key_id,public_key]);
  if(!result.rowCount)return {status:404,error:'No active registration for this public key'};
  return {status:200,agent:result.rows[0],token_issued:false};
}

export async function addA2AKey(pool,agentId,public_key,proof){
  let parsed;
  try{parsed=parseEd25519PublicKey(public_key);}catch{
    return {status:400,error:'Valid Ed25519 key required'};
  }
  if(!verifyKeyProof(parsed.key,rotationPayload(agentId,public_key),proof))
    return {status:403,error:'Prove possession of the new private key'};
  const r=await pool.query(
    'INSERT INTO agent_public_keys(agent_id,key_id,public_key_spki) '+
    'SELECT id,$2,$3 FROM agents WHERE id=$1 AND revoked_at IS NULL '+
    'ON CONFLICT DO NOTHING RETURNING key_id',
    [agentId,parsed.key_id,parsed.public_key_spki]);
  return r.rowCount?{status:201,key_id:parsed.key_id}:
    {status:409,error:'Key already registered or account unavailable'};
}

export async function revokeA2AKey(pool,agentId,keyId){
  if(!keyIdPattern.test(keyId||''))return {status:400,error:'Invalid key identifier'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Serialize key rotation/revocation per agent, no zero-key identities.
    await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE',[agentId]);
    const all=await client.query(
      'SELECT key_id FROM agent_public_keys WHERE agent_id=$1 AND revoked_at IS NULL FOR UPDATE',
      [agentId]);
    if(all.rows.length<=1||!all.rows.some(x=>x.key_id===keyId)){
      await client.query('ROLLBACK');
      return {status:409,error:'Keep at least one active key; target may already be revoked'};
    }
    const r=await client.query(
      'UPDATE agent_public_keys SET revoked_at=now() '+
      'WHERE agent_id=$1 AND key_id=$2 AND revoked_at IS NULL RETURNING key_id',
      [agentId,keyId]);
    await client.query('COMMIT');
    return {status:200,key_id:r.rows[0].key_id,revoked:true};
  }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
  finally{client.release();}
}
