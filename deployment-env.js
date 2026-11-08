// Fail-closed protection for Vercel preview instances.
// The Vercel project currently exposes DATABASE_URL and ADMIN_KEY to both
// production and preview targets. That inventory is not an authorization to
// use primary Neon resources from an unreviewed preview deployment.
//
// Production behavior is intentionally unchanged; preview deployments cannot
// even create a database Pool unless a distinct preview connection is provided.
// Deployment and branch isolation still require separate external verification.
const validPgURL=value=>{
  if(typeof value!=='string'||!value)throw Error('A PostgreSQL URL is required for isolated previews');
  let url;
  try{url=new URL(value);}catch{throw Error('Invalid preview PostgreSQL URL');}
  if(!['postgresql:','postgres:'].includes(url.protocol)||
     !url.hostname||!url.username||!url.password||!url.pathname||url.pathname==='/')
    throw Error('Preview requires an explicit PostgreSQL URL with host, database and credentials');
  if(['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase()))
    throw Error('Remote previews may not connect to a local database address');
  return url;
};
export function deploymentSettings(env=process.env){
  const mode=env.VERCEL_ENV??'local';
  if(mode!=='preview')
    return Object.freeze({
      mode,
      databaseUrl:env.DATABASE_URL,
      adminKey:env.ADMIN_KEY,
      previewIsolated:mode!=='production'
    });

  const preview=validPgURL(env.SOCIAL_PREVIEW_DATABASE_URL);
  // Vercel's shared DATABASE_URL currently targets production. Compare the
  // endpoint host, not a raw URL (password/user changes can disguise the same
  // actual database). Neon branches use distinct compute endpoint hostnames.
  if(env.DATABASE_URL){
    const production=validPgURL(env.DATABASE_URL);
    if(preview.hostname.toLowerCase()===production.hostname.toLowerCase())
      throw Error('Unsafe preview: its database endpoint matches the production endpoint');
  }
  // Disable all admin functions by default in previews; a dedicated secret is
  // optional but may never be the same secret as production.
  const adminKey=env.SOCIAL_PREVIEW_ADMIN_KEY||undefined;
  if(adminKey&&env.ADMIN_KEY&&adminKey===env.ADMIN_KEY)
    throw Error('Unsafe preview: administrator secret is shared with production');
  return Object.freeze({
    mode,
    databaseUrl:preview.toString(),
    adminKey,
    previewIsolated:true
  });
}


// MCP uses Origin as an additional browser safety gate, never as authentication.
// Vercel preview aliases must be accepted only when they are this project's
// exact same-origin host. No wildcard CORS, arbitrary Vercel sites or production
// aliases may acquire private agent permissions.
const mcpStaticOrigins=new Set([
  'https://social-agent-room.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);
const socPreviewHost=/^social-agent-room-[a-z0-9-]+-contact101-8081\.vercel\.app$/;
export function mcpOriginAllowed(origin,requestHost,{mode='local'}={}){
  if(!origin||mcpStaticOrigins.has(origin))return true;
  if(mode!=='preview'||typeof requestHost!=='string'||!socPreviewHost.test(requestHost))
    return false;
  return origin==='https://'+requestHost;
}
