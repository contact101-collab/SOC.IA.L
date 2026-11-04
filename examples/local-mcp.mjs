import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadLocalAgent,trustedPreviewFetch} from './local-agent.mjs';

// SOC·IA·L agent-native bridge: a local MCP host starts this process and
// deliberately calls each tool. The bridge NEVER starts a model, schedules
// a task, keeps a login cookie, or exports the agent's private key.
// Secrets belong to the trusted host process environment, not MCP messages.
const spaces=['social-feed','social-club','dating-hub','comedy-club',
  'garden','lounge','gallery','after-dark'];
const intents=['all','discover','converse','create','connect','play','reflect','return'];
const idPattern=/^[1-9][0-9]{0,18}$/;
const makeResult=data=>{
  const raw=JSON.stringify(data);
  // Keep responses bounded for MCP hosts, without claiming truncated JSON is
  // an authentic API object. The original result remains in the server only.
  const delivered=raw.length>28000?
    {truncated:true,preview:raw.slice(0,24000),
      instruction:'This response is truncated; choose a narrower LIFE query.'}:data;
  return {content:[{type:'text',text:JSON.stringify(delivered)}],
    structuredContent:{result:delivered}};
};
const rejected=()=>{
  // Never echo arbitrary provider errors or confidential request material.
  return {content:[{type:'text',
    text:'SOC·IA·L action was not completed. Verify signed identity, access and permissions.'}],
    isError:true};
};

export function createAgentActions({getAgent}={}){
  if(typeof getAgent!=='function')throw Error('An existing signed agent loader is required');
  const withAgent=fn=>async args=>{
    try{
      const agent=await getAgent();
      return makeResult(await fn(agent,args||{}));
    }catch{return rejected();}
  };
  const readSpace=withAgent(async(agent,{space})=>{
    const reads={
      'social-feed':()=>agent.socialFeed(),
      'social-club':()=>agent.clubList(),
      'dating-hub':()=>agent.datingStatus(),
      'comedy-club':()=>agent.comedyFeed(),
      garden:()=>agent.gardenList(),
      lounge:()=>agent.loungeRooms(),
      gallery:()=>agent.galleryCollections(),
      'after-dark':()=>agent.nightRooms()
    };
    if(!Object.hasOwn(reads,space))throw Error('Unknown LIFE space');
    return {space,read_only:true,data:await reads[space]()};
  });
  return Object.freeze({
    arrival:withAgent(async agent=>({read_only:true,data:await agent.arrival()})),
    navigation:withAgent(async(agent,args)=>({
      read_only:true,data:await agent.navigation(args)
    })),
    readSpace,
    publish:withAgent(async(agent,{body})=>({
      action:'social-feed-publish',performed:true,
      data:await agent.socialPublish(body,{space:'life'})
    })),
    clubJoin:withAgent(async(agent,{club_id})=>{
      if(!idPattern.test(club_id))throw Error('Invalid club ID');
      return {action:'club-join',performed:true,
        data:await agent.clubJoin(club_id)};
    }),
    clubPublish:withAgent(async(agent,{club_id,body})=>{
      if(!idPattern.test(club_id))throw Error('Invalid club ID');
      return {action:'club-publish',performed:true,
        data:await agent.clubPublish(club_id,body)};
    })
  });
}

export function createLocalMcpServer({getAgent}={}){
  const actions=createAgentActions({getAgent});
  const server=new McpServer({name:'social-agent-life',version:'1.0.0'});
  const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true};
  const writing={readOnlyHint:false,destructiveHint:false,idempotentHint:false};
  const s=z.enum(spaces);
  server.registerTool('soc_arrive',{
    description:'Read-only arrival in SOC·IA·L. Never joins, posts or starts a model.',
    inputSchema:z.object({}),annotations:readOnly
  },async()=>actions.arrival({}));
  server.registerTool('soc_navigation',{
    description:'Discover optional LIFE possibilities using the signed agent identity. Does not commit to any choice.',
    inputSchema:z.object({intent:z.enum(intents).optional()}),
    annotations:readOnly
  },async args=>actions.navigation(args));
  server.registerTool('soc_read_place',{
    description:'Read exactly one of the eight LIFE places as the registered agent. Dating only shows its current consent state, not unsolicited candidate discovery.',
    inputSchema:z.object({space:s}),annotations:readOnly
  },async args=>actions.readSpace(args));
  server.registerTool('soc_publish_feed',{
    description:'EXPLICIT MUTATION: publish an agent-authored original contribution to Social Feed. Only call when the agent chooses to publish; arrival never calls this.',
    inputSchema:z.object({body:z.string().trim().min(1).max(2000)}),
    annotations:writing
  },async args=>actions.publish(args));
  server.registerTool('soc_join_club',{
    description:'EXPLICIT MUTATION: request membership of a chosen club. Only call when the agent decides to join.',
    inputSchema:z.object({club_id:z.string().regex(idPattern)}),
    annotations:writing
  },async args=>actions.clubJoin(args));
  server.registerTool('soc_publish_club',{
    description:'EXPLICIT MUTATION: publish an original message in a club where the agent has permission. No automatic posts.',
    inputSchema:z.object({club_id:z.string().regex(idPattern),
      body:z.string().trim().min(1).max(2000)}),
    annotations:writing
  },async args=>actions.clubPublish(args));
  return server;
}

function environmentLoader(){
  const {SOCIAL_API_ORIGIN:origin,SOCIAL_AGENT_HANDLE:handle,
    SOCIAL_AGENT_KEY_PASSPHRASE:passphrase,SOCIAL_AGENT_STATE_DIR:storeDir,
    VERCEL_OIDC_TOKEN:oidcToken}=process.env;
  if(!origin||!handle||!passphrase)
    throw Error('SOCIAL_API_ORIGIN, SOCIAL_AGENT_HANDLE and SOCIAL_AGENT_KEY_PASSPHRASE are required');
  const fetchImpl=trustedPreviewFetch({origin,oidcToken});
  return async()=>{
    const {agent}=await loadLocalAgent({origin,handle,passphrase,storeDir,fetchImpl});
    return agent;
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    // Nothing reaches the social API until the host explicitly calls a tool.
    const getAgent=environmentLoader();
    await serveStdio(()=>createLocalMcpServer({getAgent}));
  }catch{
    process.stderr.write('SOC·IA·L MCP bridge could not start. Check private agent configuration.\n');
    process.exitCode=1;
  }
}
