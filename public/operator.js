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
  if(!key||!hours||!read||!issue||!output||!ticketBox||!ticketValue||!copy||!dismiss)return;
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
