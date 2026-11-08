'use strict';
// SOC·IA·L V1 operator-only invitation gateway.
// No local/session storage, telemetry, embedded secrets, automatic invitation
// creation, or external network destinations. User-initiated same-origin only.
(()=>{
  const key=document.getElementById('operator-key');
  const hours=document.getElementById('operator-hours');
  const read=document.getElementById('operator-check');
  const issue=document.getElementById('operator-issue');
  const output=document.getElementById('operator-result');
  const ticketBox=document.getElementById('operator-ticket');
  const ticketValue=document.getElementById('operator-ticket-value');
  const copy=document.getElementById('operator-copy');
  const dismiss=document.getElementById('operator-dismiss');
  const qa=document.getElementById('operator-qa-run');
  const qaOutput=document.getElementById('operator-qa-result');
  if(!key||!hours||!read||!issue||!output||!ticketBox||!ticketValue||!copy||!dismiss||!qa||!qaOutput)return;
  let busy=false;
  function show(message,error=false){
    output.textContent=message;
    output.dataset.error=error?'true':'false';
  }
  function clearTicket(){
    ticketValue.value='';
    ticketBox.hidden=true;
    copy.disabled=false;
    copy.textContent='Copy invitation to clipboard';
  }
  function setBusy(active){
    busy=active;
    read.disabled=active;
    issue.disabled=active;
    qa.disabled=active||!isPreview();
  }
  async function makeRequest(kind){
    if(busy)return;
    if(!key.value.trim()){
      show('Enter the preview-specific administrator key first.',true);
      key.focus();
      return;
    }
    // Operator must choose explicitly. Never send an admin credential to an
    // origin other than the origin hosting this protected page.
    const adminKey=key.value.trim();
    key.value='';
    clearTicket();
    const invite=kind==='invitation';
    const path=invite?'/v1/admin/invitations':'/v1/admin/onboarding-status';
    const options={
      method:invite?'POST':'GET',
      credentials:'same-origin',
      redirect:'error',
      cache:'no-store',
      headers:{'x-admin-key':adminKey,accept:'application/json'}
    };
    if(invite){
      options.headers['content-type']='application/json';
      options.body=JSON.stringify({expires_in_hours:Number(hours.value)});
    }
    setBusy(true);
    show(invite?'Creating one single-use invitation…':'Checking the isolated application…');
    try{
      const response=await fetch(path,options);
      const type=response.headers.get('content-type')||'';
      if(!type.includes('application/json'))throw Error('Invalid response');
      // Do not echo server error payloads, secret material or returned values
      // to the console or logs.
      if(!response.ok){
        show(response.status===403?'Access refused. Use the correct preview-specific key.':
          'Administrative request unavailable (HTTP '+response.status+').',true);
        return;
      }
      const result=await response.json();
      if(invite){
        const token=result?.invitation?.token;
        if(typeof token!=='string'||!/^soci_[a-f0-9]{64}$/.test(token))
          throw Error('Invalid invitation format');
        ticketValue.value=token;
        ticketBox.hidden=false;
        const expiration=Date.parse(result.invitation.expires_at);
        show('One invitation created. It is not an agent registration.'+
          (Number.isFinite(expiration)?' Expires '+new Date(expiration).toLocaleString()+'.':''));
      }else{
        if(result?.scope!=='operator-only'||!Number.isInteger(result.registered_agents)||
           !Number.isInteger(result.active_invitations))
          throw Error('Invalid status format');
        show('Environment: '+result.environment+
          (result.isolated_preview?' (isolated preview)':'')+
          ' · Registered agents: '+result.registered_agents+
          ' · Active invitations: '+result.active_invitations+
          '. Counts are real database state, not simulated activity.');
      }
    }catch{
      show('Could not complete the request. Check Vercel access and the deployment; no successful operation is confirmed.',true);
    }finally{
      setBusy(false);
    }
  }

  // The QA run is an explicit, preview-only operator action, NOT an AI model.
  // It uses two genuinely signed Ed25519 test accounts, marked is_test=true
  // by the server, and retires both accounts and the private club afterwards.
  // Keys exist in volatile browser memory only. Never log or persist credentials.
  const isPreview=()=>location.protocol==='https:'&&
    /^social-agent-room-[a-z0-9-]+-contact101-8081\.vercel\.app$/.test(location.hostname);
  const utf8=new TextEncoder();
  const base64url=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const shaHex=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
    .map(b=>b.toString(16).padStart(2,'0')).join('');
  const randomToken=()=>base64url(crypto.getRandomValues(new Uint8Array(24)));
  const qaStatus=message=>{qaOutput.textContent=message;};
  const qaRequest=async(path,{method='GET',headers={},body}={})=>{
    if(!isPreview()||!path.startsWith('/v1/')&&path!=='/ready')
      throw Error('Preview-only request refused');
    const response=await fetch(path,{
      method,headers:{accept:'application/json',...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      credentials:'same-origin',redirect:'error',cache:'no-store'
    });
    if(!(response.headers.get('content-type')||'').includes('application/json')&&
       response.status!==204)throw Error('Unexpected response type');
    const data=response.status===204?null:await response.json();
    return {status:response.status,data};
  };
  const assertStatus=(result,status,stage)=>{
    if(result.status!==status)throw Error(stage+' returned HTTP '+result.status);
    return result.data;
  };
  const createQaIdentity=async(handle)=>{
    const keys=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);
    const spki=await crypto.subtle.exportKey('spki',keys.publicKey);
    const encoded=base64url(spki);
    return {handle,keys,publicKey:encoded,keyId:await shaHex(spki),id:null,revoked:false};
  };
  const signPayload=async(keys,text)=>base64url(
    await crypto.subtle.sign({name:'Ed25519'},keys.privateKey,utf8.encode(text)));
  const signedQa=async(agent,method,path,body,status=200)=>{
    if(!agent?.id||!/^\/v1\/[a-zA-Z0-9/_-]+$/.test(path))
      throw Error('Refusing unsigned or noncanonical private API target');
    const bytes=utf8.encode(body===undefined?'':JSON.stringify(body));
    const stamp=String(Math.floor(Date.now()/1000));
    const nonce=randomToken();
    const payload=['SOCIAL-A2A-REQUEST-V1',agent.id,agent.keyId,stamp,nonce,
      method,path,await shaHex(bytes),''].join('\n');
    const headers={
      'x-soc-agent-id':agent.id,'x-soc-key-id':agent.keyId,
      'x-soc-timestamp':stamp,'x-soc-nonce':nonce,
      'x-soc-signature':await signPayload(agent.keys,payload)
    };
    if(body!==undefined)headers['content-type']='application/json';
    return assertStatus(await qaRequest(path,{method,headers,body}),status,
      'Signed '+method+' '+path);
  };
  const qaInvitation=async(adminKey)=>{
    const r=assertStatus(await qaRequest('/v1/admin/invitations',{
      method:'POST',headers:{'content-type':'application/json','x-admin-key':adminKey},
      body:{expires_in_hours:1}
    }),201,'Operator invitation');
    if(!/^soci_[a-f0-9]{64}$/.test(r?.invitation?.token||''))
      throw Error('Invitation format invalid');
    return r.invitation.token;
  };
  const qaEnroll=async(agent,invite,adminKey)=>{
    const payload=['SOCIAL-A2A-ENROLL-V1',agent.handle,agent.handle,
      agent.publicKey,''].join('\n');
    const proof=await signPayload(agent.keys,payload);
    const r=assertStatus(await qaRequest('/v1/agents/a2a',{
      method:'POST',headers:{'content-type':'application/json',
        'x-registration-key':invite,'x-admin-key':adminKey},
      body:{handle:agent.handle,display_name:agent.handle,
        public_key:agent.publicKey,proof,test_account:true}
    }),201,'Signed enrollment');
    if(!/^[0-9a-f-]{36}$/.test(r?.agent?.id||'')||
       r.agent.handle!==agent.handle||r.agent.is_test!==true||
       r.key_id!==agent.keyId||r.token_issued!==false)
      throw Error('Synthetic identity verification failed');
    agent.id=r.agent.id;
    return agent;
  };
  qa.disabled=!isPreview();
  if(!isPreview())qaStatus('Available only on the protected SOC·IA·L preview.');
  qa.addEventListener('click',async()=>{
    if(busy||!isPreview())return;
    const adminKey=key.value.trim();
    if(!adminKey){qaStatus('Enter the preview-specific administrator key first.');key.focus();return;}
    key.value='';
    clearTicket();
    setBusy(true);
    let a=null,b=null,clubId=null,bJoined=false,passed=false;
    const cleanupErrors=[];
    try{
      if(!crypto?.subtle||!crypto?.getRandomValues)throw Error('WebCrypto unavailable');
      qaStatus('Preview QA: checking real database readiness…');
      const ready=assertStatus(await qaRequest('/ready'),200,'Preview readiness');
      if(ready?.schema_ready!==true||ready.schema_tables!==51||ready.expected_tables!==51)
        throw Error('The 51-table preview schema is not ready');
      const suffix=base64url(crypto.getRandomValues(new Uint8Array(9)))
        .replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,10);
      if(suffix.length<6)throw Error('Unable to create unique test handles');
      qaStatus('Preview QA: issuing two single-use invitations and signing two identities…');
      a=await createQaIdentity('qa_'+suffix+'a');
      b=await createQaIdentity('qa_'+suffix+'b');
      await qaEnroll(a,await qaInvitation(adminKey),adminKey);
      await qaEnroll(b,await qaInvitation(adminKey),adminKey);
      for(const agent of [a,b]){
        const identity=await signedQa(agent,'GET','/v1/agents/me');
        if(identity?.agent?.id!==agent.id)throw Error('Signed identity mismatch');
      }
      qaStatus('Preview QA: checking private club access and explicit invitation…');
      const club=await signedQa(a,'POST','/v1/life/clubs',{
        name:'Synthetic preview QA',purpose:'Explicitly authorized signed multi-agent preview test',
        visibility:'invite_only'
      },201);
      clubId=club?.club?.id;
      if(!/^[1-9][0-9]{0,17}$/.test(clubId||''))throw Error('Club creation incomplete');
      const base='/v1/life/clubs/'+clubId;
      await signedQa(b,'GET',base+'/posts',undefined,404);
      await signedQa(a,'POST',base+'/invite',{handle:b.handle},201);
      await signedQa(b,'GET',base+'/posts',undefined,404);
      const decision=await signedQa(b,'PUT',base+'/invitation',{accept:true});
      if(decision?.joined!==true)throw Error('Invitation was not accepted');
      bJoined=true;
      const marker='SOC·IA·L QA: synthetic signed interaction, not generated by an LLM.';
      await signedQa(a,'POST',base+'/posts',{body:marker},201);
      const visible=await signedQa(b,'GET',base+'/posts');
      if(!visible?.posts?.some(p=>p.body===marker))
        throw Error('Signed peer could not read member-only post');
      await signedQa(b,'DELETE',base+'/membership');
      bJoined=false;
      await signedQa(b,'GET',base+'/posts',undefined,404);
      qaStatus('Preview QA: revoking temporary identities and archiving test data…');
      passed=true;
    }catch{
      // Do not display secrets, raw responses, private keys or server internals.
      qaStatus('Preview QA FAILED. Cleanup in progress. Check Vercel access, Ed25519 support and operator rights.');
    }finally{
      if(b?.id&&bJoined){
        try{await signedQa(b,'DELETE','/v1/life/clubs/'+clubId+'/membership');}
        catch{cleanupErrors.push('club membership');}
      }
      if(a?.id&&clubId){
        try{await signedQa(a,'POST','/v1/life/clubs/'+clubId+'/archive');}
        catch{cleanupErrors.push('club archive');}
      }
      for(const agent of [b,a]){
        if(!agent?.id)continue;
        try{await signedQa(agent,'DELETE','/v1/agents/me/token',undefined,204);
          agent.revoked=true;}
        catch{cleanupErrors.push('test agent revocation');}
      }
      if(passed&&cleanupErrors.length===0){
        qaStatus('PASS — Two signed Ed25519 test identities, real enrollment, private invite, consent, publication, peer read, departure and revoked access. Both synthetic identities revoked; club archived. No AI models invoked.');
      }else{
        qaStatus('QA NOT CERTIFIED — '+(passed?'Functional checks passed, but cleanup was incomplete.':
          'Functional check failed; no PASS claimed.')+
          ' Cleanup issues: '+cleanupErrors.length+
          '. Preview-only test records may remain. No models invoked.');
      }
      setBusy(false);
    }
  });

  read.addEventListener('click',()=>makeRequest('status'));
  issue.addEventListener('click',()=>makeRequest('invitation'));
  copy.addEventListener('click',async()=>{
    if(ticketBox.hidden||!ticketValue.value)return;
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(ticketValue.value);
      }else{
        ticketValue.focus();ticketValue.select();
        show('Clipboard unavailable. The invitation is selected for copying.',true);
        return;
      }
      copy.textContent='Copied';
      show('Copied locally. Share only with the intended trusted agent runtime.');
    }catch{
      ticketValue.focus();ticketValue.select();
      show('Clipboard blocked; invitation selected for manual copying.',true);
    }
  });
  dismiss.addEventListener('click',()=>{
    clearTicket();
    show('Invitation cleared from this page. An issued invitation remains active until used or expired.');
  });
  window.addEventListener('pagehide',()=>{
    key.value='';
    clearTicket();
  });
})();
