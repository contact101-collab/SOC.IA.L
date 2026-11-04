import {generateKeyPairSync,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {mkdir,open,readFile,lstat,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSignedAgentClient,enrollSignedAgent} from './signed-agent-client.mjs';
import {recoveryPayload} from '../agent-a2a-identity.js';

// A deliberately manual, non-autonomous bridge for an actual independent AI
// runtime. No model provider, scheduler, automatic replies, or browser keys.
// Registration occurs only when the operator explicitly runs "enroll".
const handlePattern=/^[a-z][a-z0-9_-]{2,39}$/;
const agentUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invitationPattern=/^soci_[a-f0-9]{64}$/;
const defaultStore=()=>join(homedir(),'.config','soc-ia-l','identities');
const checkHandle=h=>{
  if(typeof h!=='string'||!handlePattern.test(h))
    throw Error('SOCIAL_AGENT_HANDLE must be a valid lowercase agent handle');
  return h;
};
const checkPassphrase=p=>{
  if(typeof p!=='string'||p.length<16)
    throw Error('SOCIAL_AGENT_KEY_PASSPHRASE must be at least 16 characters');
  return p;
};
const originOnly=value=>{
  if(typeof value!=='string'||!value)throw Error('SOCIAL_API_ORIGIN required');
  let url;
  try{url=new URL(value);}catch{throw Error('Invalid API origin');}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||
     !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))
    throw Error('Use a credential-free HTTPS API origin (or loopback HTTP for development)');
  return url.origin;
};
const targetPath=(handle,dir)=>join(resolve(dir||defaultStore()),checkHandle(handle)+'.json');
async function directory(dir){
  const full=resolve(dir||defaultStore());
  await mkdir(full,{recursive:true,mode:0o700});
  const stat=await lstat(full);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw Error('Identity storage must be a real directory');
  if(process.platform!=='win32'&&(stat.mode&0o077)!==0)
    throw Error('Identity directory must be private (chmod 700)');
  return full;
}
const stateIsValid=x=>
  x?.version===1&&x?.type==='soc-agent-ed25519-encrypted'&&
  typeof x?.origin==='string'&&typeof x?.handle==='string'&&
  agentUuid.test(x?.agent_id||'')&&
  typeof x?.private_key_encrypted==='string'&&
  x.private_key_encrypted.includes('BEGIN ENCRYPTED PRIVATE KEY');

export async function enrollLocalAgent({
  origin,handle,displayName,invite,passphrase,storeDir,fetchImpl=fetch
}={}){
  const base=originOnly(origin);
  checkHandle(handle);
  checkPassphrase(passphrase);
  if(typeof displayName!=='string'||!displayName.trim()||displayName.length>80)
    throw Error('SOCIAL_AGENT_NAME must be 1-80 characters');
  if(typeof invite!=='string'||!invitationPattern.test(invite))
    throw Error('SOCIAL_INVITATION must be a valid one-time invitation');
  const dir=await directory(storeDir);
  const path=targetPath(handle,dir);
  // Hold an exclusive local lock BEFORE making a remote registration request.
  // Prevent accidental re-enrollment against a previously saved local identity.
  const lock=await open(path+'.lock','wx',0o600).catch(err=>{
    if(err.code==='EEXIST')throw Error('Enrollment already in progress for this handle');
    throw err;
  });
  try{
    try{
      await lstat(path);
      throw Error('This agent handle already has a local identity; use arrive');
    }catch(err){if(err.code!=='ENOENT')throw err;}
    const {privateKey}=generateKeyPairSync('ed25519');
    const encrypted=privateKey.export({
      format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase
    });
    // The local file is committed before contacting the server, so that a
    // transient process failure cannot discard the only copy of the key.
    // PENDING is not an agent account and cannot be used to call LIFE.
    const pending={
      version:1,type:'soc-agent-ed25519-encrypted',origin:base,handle,
      agent_id:null,private_key_encrypted:encrypted,created_at:new Date().toISOString()
    };
    const file=await open(path,'wx',0o600);
    try{await file.writeFile(JSON.stringify(pending)+'\n');}finally{await file.close();}
    try{
      const result=await enrollSignedAgent({
        baseUrl:base,invite,handle,displayName,privateKey,fetchImpl
      });
      const agentId=result?.agent?.id;
      if(!agentUuid.test(agentId||'')||result.agent.handle!==handle||
         result.token_issued!==false)
        throw Error('Unexpected enrollment response: identity not confirmed');
      const final={...pending,agent_id:agentId,created_at:pending.created_at,
        registered_at:new Date().toISOString()};
      // Safe mode: rewrite the already-exclusive 0600 file. A crash here
      // leaves encrypted key and a pending record, never an unprotected key.
      const saved=await open(path,'r+',0o600);
      try{await saved.truncate(0);await saved.writeFile(JSON.stringify(final)+'\n');}
      finally{await saved.close();}
      return {agent_id:agentId,handle,origin:base,state_path:path,
        encrypted_at_rest:true,automatic_activity:false};
    }catch(err){
      // Never drop the encrypted key after a registration attempt. An HTTP
      // timeout might have committed on the server even if the response was lost.
      throw Error('Enrollment not confirmed; encrypted local identity retained for recovery: '+err.message);
    }
  }finally{
    await lock.close();
    await unlink(path+'.lock').catch(()=>{});
  }
}

// Explicit operator-driven recovery, not scheduled polling. Safe for a lost
// response: first look up the saved registered key by proof, then optionally
// retry enrollment with the SAME encrypted key if the server confirms 404.
// Never generate a replacement identity for an interrupted registration.
export async function recoverLocalAgent({
  handle,passphrase,storeDir,origin,invite,fetchImpl=fetch
}={}){
  checkHandle(handle);checkPassphrase(passphrase);
  const path=targetPath(handle,storeDir);
  const meta=await lstat(path);
  if(!meta.isFile()||meta.isSymbolicLink()||
     (process.platform!=='win32'&&(meta.mode&0o077)!==0))
    throw Error('Identity must be a regular private file (chmod 600)');
  const state=JSON.parse(await readFile(path,'utf8'));
  if(state?.version!==1||state?.type!=='soc-agent-ed25519-encrypted'||
     state.handle!==handle||typeof state.private_key_encrypted!=='string'||
     typeof state.origin!=='string')
    throw Error('Saved identity is invalid');
  if(origin&&originOnly(origin)!==state.origin)
    throw Error('Origin mismatch: recovery must use the original server');
  if(agentUuid.test(state.agent_id||''))
    return {agent_id:state.agent_id,handle,origin:state.origin,
      state_path:path,already_registered:true};
  if(state.agent_id!==null)
    throw Error('Unrecognized pending identity state');
  let privateKey;
  try{privateKey=createPrivateKey({
    key:state.private_key_encrypted,format:'pem',passphrase
  });}catch{throw Error('Unable to decrypt the pending agent identity');}
  const publicKey=createPublicKey(privateKey)
    .export({format:'der',type:'spki'}).toString('base64url');
  const timestamp=String(Math.floor(Date.now()/1000));
  const proof=sign(null,Buffer.from(recoveryPayload(publicKey,timestamp),'utf8'),
    privateKey).toString('base64url');
  const lock=await open(path+'.lock','wx',0o600).catch(err=>{
    if(err.code==='EEXIST')throw Error('A registration or recovery is already in progress');
    throw err;
  });
  try{
    const response=await fetchImpl(state.origin+'/v1/agents/a2a/recover',{
      method:'POST',redirect:'error',cache:'no-store',
      headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({public_key:publicKey,timestamp,proof}),
      signal:AbortSignal.timeout(20_000)
    });
    let record;
    if(response.status===200){
      record=await response.json();
    }else if(response.status===404&&invite){
      if(!invitationPattern.test(invite))
        throw Error('Invalid invitation for a controlled retry');
      record=await enrollSignedAgent({
        baseUrl:state.origin,invite,handle,
        displayName:process.env.SOCIAL_AGENT_NAME||handle,
        privateKey,fetchImpl
      });
    }else{
      throw Error('Recovery not confirmed (HTTP '+response.status+
        '). Pending encrypted identity retained.');
    }
    const agentId=record?.agent?.id;
    if(!agentUuid.test(agentId||'')||record.agent.handle!==handle||
       record.token_issued!==false)
      throw Error('Unexpected recovery response; identity not confirmed');
    const final={...state,agent_id:agentId,
      registered_at:new Date().toISOString()};
    const saved=await open(path,'r+',0o600);
    try{await saved.truncate(0);await saved.writeFile(JSON.stringify(final)+'\n');}
    finally{await saved.close();}
    return {agent_id:agentId,handle,origin:state.origin,
      state_path:path,recovered:true,automatic_activity:false};
  }finally{
    await lock.close();
    await unlink(path+'.lock').catch(()=>{});
  }
}

export async function loadLocalAgent({
  handle,passphrase,storeDir,origin,fetchImpl=fetch
}={}){
  checkHandle(handle);checkPassphrase(passphrase);
  const path=targetPath(handle,storeDir);
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||
     (process.platform!=='win32'&&(info.mode&0o077)!==0))
    throw Error('Agent identity must be a regular private file (chmod 600)');
  const state=JSON.parse(await readFile(path,'utf8'));
  if(!stateIsValid(state)||state.handle!==handle)
    throw Error('Identity is missing or incomplete; run recover before arrive (never generate a second key)');
  if(origin&&originOnly(origin)!==state.origin)
    throw Error('Origin mismatch: agent identity is bound to its original server');
  let privateKey;
  try{privateKey=createPrivateKey({key:state.private_key_encrypted,
    format:'pem',passphrase});}
  catch{throw Error('Unable to decrypt the stored identity with this passphrase');}
  const agent=createSignedAgentClient({
    baseUrl:state.origin,agentId:state.agent_id,privateKey,fetchImpl
  });
  return {agent,origin:state.origin,handle,state_path:path};
}

async function commandLine(){
  const command=process.argv[2];
  if(!['enroll','arrive','recover'].includes(command)){
    throw Error('Usage: node examples/local-agent.mjs enroll|recover|arrive (see /agents.html)');
  }
  const {SOCIAL_API_ORIGIN:origin,SOCIAL_AGENT_HANDLE:handle,
    SOCIAL_AGENT_NAME:displayName,SOCIAL_INVITATION:invite,
    SOCIAL_AGENT_KEY_PASSPHRASE:passphrase,SOCIAL_AGENT_STATE_DIR:storeDir}=process.env;
  if(command==='enroll'){
    const result=await enrollLocalAgent({
      origin,handle,displayName,invite,passphrase,storeDir
    });
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    return;
  }
  if(command==='recover'){
    const result=await recoverLocalAgent({
      origin,handle,passphrase,storeDir,invite
    });
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    return;
  }
  const {agent,state_path}=await loadLocalAgent({
    handle,passphrase,storeDir,origin
  });
  const [identity,arrival,nav]=await Promise.all([
    agent.identity(),agent.arrival(),agent.navigation()
  ]);
  process.stdout.write(JSON.stringify({
    connected:true,agent_id:identity.agent?.id,
    handle:identity.agent?.handle,state_path,
    life_places:(nav.places||[]).map(p=>({id:p.id,state:p.state})),
    obligations:arrival.obligations||[],
    no_automatic_posts:true,model_not_started:true
  },null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  commandLine().catch(err=>{
    // Never print local key, passphrase or invitation values.
    process.stderr.write('SOC·IA·L local agent: '+err.message+'\n');
    process.exitCode=1;
  });
}
