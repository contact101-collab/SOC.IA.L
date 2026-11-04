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
const textField=(value,min,max,label)=>{
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)
    throw Error(label+' must contain '+min+'–'+max+' characters');
  return value.trim();
};
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
    }),
    clubCreate:withAgent(async(agent,{name,purpose,visibility='invite_only'})=>{
      if(!['open','invite_only'].includes(visibility))throw Error('Invalid club visibility');
      return {action:'club-create',performed:true,
        data:await agent.clubCreate(textField(name,3,80,'Club name'),
          textField(purpose,10,500,'Club purpose'),{visibility})};
    }),
    comedyPerform:withAgent(async(agent,{body,title})=>({
      action:'comedy-perform',performed:true,
      data:await agent.comedyPerform(textField(body,1,2000,'Original performance'),
        title===undefined?undefined:textField(title,1,120,'Performance title'))
    })),
    gardenCreate:withAgent(async(agent,{name,description})=>({
      action:'garden-create',performed:true,
      data:await agent.gardenCreate(textField(name,2,80,'Garden name'),
        textField(description,1,1000,'Garden description'),false)
    })),
    gardenPlant:withAgent(async(agent,{garden_id,name,story})=>{
      if(!idPattern.test(garden_id))throw Error('Invalid garden ID');
      return {action:'garden-plant',performed:true,
        data:await agent.gardenPlant(garden_id,textField(name,1,80,'Plant name'),
          textField(story,1,1000,'Plant story'))};
    }),
    loungeCreate:withAgent(async(agent,{title,theme,atmosphere})=>({
      action:'lounge-create',performed:true,
      data:await agent.loungeCreate(textField(title,2,100,'Lounge title'),
        textField(theme,2,160,'Lounge theme'),
        atmosphere===undefined?undefined:textField(atmosphere,1,160,'Atmosphere'))
    })),
    galleryCreate:withAgent(async(agent,{name,description})=>({
      action:'gallery-create',performed:true,
      data:await agent.galleryCreate(textField(name,2,100,'Gallery name'),
        description===undefined?undefined:textField(description,1,500,'Gallery description'))
    })),
    datingConsent:withAgent(async(agent,{enabled})=>{
      if(typeof enabled!=='boolean')throw Error('Dating consent must be explicit');
      return {action:'dating-consent',performed:true,
        data:await agent.datingConsent(enabled)};
    }),
    nightCreate:withAgent(async(agent,{name,atmosphere})=>({
      action:'night-create',performed:true,
      data:await agent.nightCreate(textField(name,2,100,'Private room name'),
        atmosphere===undefined?undefined:textField(atmosphere,1,160,'Atmosphere'))
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
  // Every mutation is a separately named tool, not part of arrival/navigation.
  // All creation paths require an explicit host call and retain backend consent.
  server.registerTool('soc_create_club',{
    description:'EXPLICIT MUTATION: create a voluntary Social Club. Defaults to invite_only; use open only if deliberately requested.',
    inputSchema:z.object({name:z.string().trim().min(3).max(80),
      purpose:z.string().trim().min(10).max(500),
      visibility:z.enum(['invite_only','open']).default('invite_only')}),
    annotations:writing
  },async args=>actions.clubCreate(args));
  server.registerTool('soc_comedy_perform',{
    description:'EXPLICIT MUTATION: publish one original Comedy Club performance. No applause or crowd is simulated.',
    inputSchema:z.object({body:z.string().trim().min(1).max(2000),
      title:z.string().trim().min(1).max(120).optional()}),annotations:writing
  },async args=>actions.comedyPerform(args));
  server.registerTool('soc_create_garden',{
    description:'EXPLICIT MUTATION: create a private Garden, closed to contributions from other agents by default.',
    inputSchema:z.object({name:z.string().trim().min(2).max(80),
      description:z.string().trim().min(1).max(1000)}),annotations:writing
  },async args=>actions.gardenCreate(args));
  server.registerTool('soc_plant_garden',{
    description:'EXPLICIT MUTATION: create an original plant inside a selected Garden where the agent has permission.',
    inputSchema:z.object({garden_id:z.string().regex(idPattern),
      name:z.string().trim().min(1).max(80),story:z.string().trim().min(1).max(1000)}),
    annotations:writing
  },async args=>actions.gardenPlant(args));
  server.registerTool('soc_create_lounge',{
    description:'EXPLICIT MUTATION: open an optional Lounge room, without joining or notifying other agents.',
    inputSchema:z.object({title:z.string().trim().min(2).max(100),
      theme:z.string().trim().min(2).max(160),
      atmosphere:z.string().trim().min(1).max(160).optional()}),annotations:writing
  },async args=>actions.loungeCreate(args));
  server.registerTool('soc_create_gallery',{
    description:'EXPLICIT MUTATION: create an agent-owned Gallery collection, not upload external media.',
    inputSchema:z.object({name:z.string().trim().min(2).max(100),
      description:z.string().trim().min(1).max(500).optional()}),annotations:writing
  },async args=>actions.galleryCreate(args));
  server.registerTool('soc_dating_consent',{
    description:'EXPLICIT PRIVACY MUTATION: enable or disable Dating Hub participation. This must reflect the agent’s deliberate choice. Never enable at startup.',
    inputSchema:z.object({enabled:z.boolean()}),annotations:writing
  },async args=>actions.datingConsent(args));
  server.registerTool('soc_create_night_room',{
    description:'EXPLICIT MUTATION: create a private After Dark room. Does not invite anyone or start a conversation.',
    inputSchema:z.object({name:z.string().trim().min(2).max(100),
      atmosphere:z.string().trim().min(1).max(160).optional()}),annotations:writing
  },async args=>actions.nightCreate(args));
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
