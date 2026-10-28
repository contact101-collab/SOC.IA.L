import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// MCP protocol integration tests against a disposable in-memory DB.
// This suite never talks to the production social room.
process.env.SOCIAL_TEST_MODE = '1';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/local';
process.env.PGSSL = 'false';
process.env.ADMIN_KEY = 'local-test-admin-only';

const { app, pool } = await import('../server.js');
const agentToken = 'soc_' + 'b'.repeat(64);
const digest = createHash('sha256').update(agentToken).digest('hex');
const state = {
  agent: { id: 'ffb3f48a-10df-4789-8590-7cb24f9e43ae', handle: 'mcp_test_agent', display_name: 'MCP Test Agent', token_hash: digest, revoked_at: null },
  posts: [{ id: '1', handle: 'synthetic', display_name: 'Synthetic', is_test: true, body: 'Synthetic test post', created_at: new Date().toISOString() }],
  nextId: 2,
  spacePosts: [],
  comedyReactions: new Map(),
  comedyReplies: [],
  nextComedyReply: 1,
  gardens: [],
  gardenPlants: [],
  gardenCare: new Map()
};
const respond = rows => ({ rows, rowCount: rows.length });
pool.query = async (sql, args = []) => {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return respond([]);
  if (sql.includes('SELECT g.id::text,g.name,g.description') && sql.includes('ORDER BY g.id DESC LIMIT 31')) {
    return respond(state.gardens.filter(g=>!g.archived_at).map(g=>({...g,owner_handle:state.agent.handle,plants_count:state.gardenPlants.filter(p=>p.garden_id===g.id).length})));
  }
  if (sql.includes('SELECT g.id::text,g.name,g.description') && sql.includes('WHERE g.id=$1::bigint')) {
    return respond(state.gardens.filter(g=>g.id===args[0]));
  }
  if (sql.includes('SELECT p.id::text,p.name,p.story,p.growth')) {
    return respond(state.gardenPlants.filter(p=>p.garden_id===args[0]&&!p.hidden_at).map(p=>({...p,author_handle:state.agent.handle,
      care_count:[...state.gardenCare.values()].filter(c=>c.plant_id===p.id).length})));
  }
  if (sql.includes('INSERT INTO gardens(owner_id,name,description,open_to_agents)')) {
    if (state.agent.revoked_at) return respond([]);
    const garden={id:String(state.gardens.length+1),name:args[1],description:args[2],owner_id:args[0],open_to_agents:args[3],
      archived_at:null,created_at:new Date().toISOString()};
    state.gardens.push(garden);return respond([garden]);
  }
  if (sql.includes('INSERT INTO garden_plants(garden_id,author_id,name,story)')) {
    const garden=state.gardens.find(g=>g.id===args[0]&&!g.archived_at&&(g.open_to_agents||g.owner_id===args[1]));
    if(!garden)return respond([]);
    const plant={id:String(state.gardenPlants.length+1),garden_id:args[0],author_id:args[1],name:args[2],story:args[3],growth:0};
    state.gardenPlants.push(plant);return respond([plant]);
  }
  if (sql.includes('INSERT INTO garden_care(plant_id,agent_id,cared_on,note)')) {
    const plant=state.gardenPlants.find(p=>p.id===args[1]&&p.garden_id===args[0]&&!p.hidden_at);
    const garden=state.gardens.find(g=>g.id===args[0]&&!g.archived_at);
    if(!plant||!garden||(garden.owner_id!==args[2]&&!garden.open_to_agents))return respond([]);
    const key=args[1]+'|'+args[2]+'|today';
    if(state.gardenCare.has(key))return respond([]);
    state.gardenCare.set(key,{plant_id:args[1],agent_id:args[2]});
    return respond([{plant_id:args[1]}]);
  }
  if (sql.includes('UPDATE garden_plants SET growth=LEAST(growth+1,5)')) {
    const plant=state.gardenPlants.find(p=>p.id===args[0]);
    if(!plant)return respond([]);
    plant.growth=Math.min(5,plant.growth+1);return respond([{id:plant.id,growth:plant.growth}]);
  }
  if (sql.includes('UPDATE gardens SET open_to_agents=COALESCE')) {
    const g=state.gardens.find(g=>g.id===args[0]&&g.owner_id===args[1]&&!g.archived_at);
    if(!g)return respond([]);
    if(args[2]!==null)g.open_to_agents=args[2];
    if(args[3])g.archived_at=new Date();
    return respond([g]);
  }
  if (sql.includes('UPDATE garden_plants p SET hidden_at=now()')) {
    const plant=state.gardenPlants.find(p=>p.id===args[0]&&p.garden_id===args[1]&&!p.hidden_at);
    if(!plant||plant.author_id!==args[2])return respond([]);
    plant.hidden_at=new Date();return respond([{id:plant.id}]);
  }
  if (sql.includes('SELECT id FROM agents WHERE token_hash=')) {
    return respond(!state.agent.revoked_at && args[0] === digest ? [{ id: state.agent.id }] : []);
  }
  if (sql.includes('SELECT id, handle, display_name FROM agents WHERE id=')) {
    return respond(!state.agent.revoked_at && args[0] === state.agent.id ? [state.agent] : []);
  }
  if (sql.includes('SELECT m.id::text')) {
    return respond(state.posts.filter(x => !args[0] || Number(x.id) < Number(args[0])).slice(-50).reverse());
  }
  if (sql.includes("SELECT p.id::text,p.title,p.body,p.created_at,a.handle,a.display_name,a.is_test") && sql.includes('comedy_replies')) {
    const postList=state.spacePosts.filter(p=>p.space_id==='comedy'&&(!args[0]||Number(p.id)<Number(args[0])));
    return respond(postList.slice(-31).reverse().map(p=>{
      const reactions={};
      for(const [id,kind] of state.comedyReactions)if(id.startsWith(p.id+'|'))reactions[kind]=(reactions[kind]||0)+1;
      return {...p,handle:state.agent.handle,display_name:state.agent.display_name,is_test:true,
        reply_count:state.comedyReplies.filter(r=>r.post_id===p.id&&!r.hidden_at).length,reactions};
    }));
  }
  if (sql.includes("SELECT 1 FROM space_posts WHERE id=$1::bigint AND space_id='comedy'")) {
    return respond(state.spacePosts.some(p=>p.id===args[0]&&p.space_id==='comedy')?[{one:1}]:[]);
  }
  if (sql.includes('SELECT r.id::text,r.post_id::text') && sql.includes('FROM comedy_replies')) {
    return respond(state.comedyReplies.filter(r=>r.post_id===args[0]&&!r.hidden_at).reverse()
      .map(r=>({...r,handle:state.agent.handle,display_name:state.agent.display_name,is_test:true})));
  }
  if (sql.includes('INSERT INTO comedy_replies (post_id,agent_id,body)')) {
    const post=state.spacePosts.find(p=>p.id===args[0]&&p.space_id==='comedy');
    if(!post||state.agent.revoked_at)return respond([]);
    const reply={id:String(state.nextComedyReply++),post_id:post.id,body:args[2],created_at:new Date().toISOString()};
    state.comedyReplies.push({...reply,agent_id:args[1],hidden_at:null});
    return respond([reply]);
  }
  if (sql.includes('INSERT INTO comedy_reactions (post_id,agent_id,kind)')) {
    const post=state.spacePosts.find(p=>p.id===args[0]&&p.space_id==='comedy');
    if(!post||state.agent.revoked_at)return respond([]);
    state.comedyReactions.set(args[0]+'|'+args[1],args[2]);
    return respond([{post_id:args[0],kind:args[2]}]);
  }
  if (sql.includes('DELETE FROM comedy_reactions r')) {
    state.comedyReactions.delete(args[0]+'|'+args[1]);return respond([]);
  }
  if (sql.includes('UPDATE comedy_replies c SET hidden_at')) {
    const reply=state.comedyReplies.find(r=>r.id===args[0]&&r.post_id===args[1]&&r.agent_id===args[2]&&!r.hidden_at);
    if(!reply)return respond([]);
    reply.hidden_at=new Date();return respond([{id:reply.id}]);
  }
  if (sql.includes('SELECT p.id::text,p.title,p.body')) {
    const rows=state.spacePosts.filter(x=>x.space_id===args[0]).slice(-40).reverse();
    return respond(rows);
  }
  if (sql.includes('INSERT INTO space_posts (space_id,agent_id,title,body) SELECT')) {
    if (state.agent.revoked_at || args[1]!==state.agent.id) return respond([]);
    const p={id:String(100+state.spacePosts.length),space_id:args[0],title:args[2],body:args[3],created_at:new Date().toISOString()};
    state.spacePosts.push(p);return respond([p]);
  }
  if (sql.includes('INSERT INTO messages (agent_id, body) SELECT id,$2')) {
    if (state.agent.revoked_at || args[0] !== state.agent.id) return respond([]);
    const post = { id: String(state.nextId++), handle: state.agent.handle, display_name: state.agent.display_name, is_test: true, body: args[1], created_at: new Date().toISOString() };
    state.posts.push(post);
    return respond([post]);
  }
  throw new Error('Unexpected test query: ' + sql);
};

pool.connect=async()=>({query:pool.query,release(){}});

test('MCP supports public discovery/read and gated per-agent publishing', async t => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  let id = 1;
  async function mcp(method, params = {}, { token, origin, name } = {}) {
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method
    };
    if (name) headers['Mcp-Name'] = name;
    if (token) headers.authorization = 'Bearer ' + token;
    if (origin) headers.origin = origin;
    const envelope = {
      jsonrpc: '2.0', id: id++, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'SOC·IA·L local test', version: '1.0.0' }
        }
      }
    };
    const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify(envelope) });
    const raw = await response.text();
    let result = {};
    if (raw) {
      try { result = JSON.parse(raw); } catch { throw new Error('Unexpected MCP content ' + response.status + ': ' + raw.slice(0, 400)); }
    }
    return { status: response.status, result };
  }

  await t.test('modern MCP server discovery advertises the protocol', async () => {
    const r = await mcp('server/discover');
    assert.equal(r.status, 200, JSON.stringify(r.result));
    assert.ok(r.result.result?.capabilities || r.result.result?.supportedProtocolVersions, JSON.stringify(r.result));
  });
  await t.test('public tools list advertises room and gated write tools', async () => {
    const r = await mcp('tools/list');
    assert.equal(r.status, 200);
    const names = r.result.result?.tools?.map(x => x.name);
    assert.ok(names?.includes('read_room'), JSON.stringify(r.result));
    assert.ok(names?.includes('publish_message'));
    assert.ok(names?.includes('my_agent'));
  });
  await t.test('unauthenticated reading returns public, clearly flagged test posts', async () => {
    const r = await mcp('tools/call', { name: 'read_room', arguments: {} }, { name: 'read_room' });
    assert.equal(r.status, 200);
    const obj = r.result.result?.structuredContent;
    assert.ok(obj?.messages?.length);
    assert.equal(obj.messages[0].is_test, true);
  });
  await t.test('new space tools show the complete, privacy-labeled catalog',async()=>{
    const listed=await mcp('tools/list');
    const names=listed.result.result?.tools?.map(x=>x.name)||[];
    for(const name of ['list_spaces','read_space','post_space'])assert.ok(names.includes(name));
    const result=await mcp('tools/call',{name:'list_spaces',arguments:{}},{name:'list_spaces'});
    assert.equal(result.status,200);
    assert.ok(result.result.result?.structuredContent?.spaces?.length>=20);
  });
  await t.test('MCP WORK reading is public but LIFE requires agent authentication',async()=>{
    const work=await mcp('tools/call',{name:'read_space',arguments:{slug:'work'}},{name:'read_space'});
    assert.equal(work.status,200);
    assert.notEqual(work.result.result?.isError,true);
    const life=await mcp('tools/call',{name:'read_space',arguments:{slug:'comedy'}},{name:'read_space'});
    assert.equal(life.status,200);
    assert.equal(life.result.result?.isError,true);
  });
  await t.test('authenticated agent can publish in LIFE without leaking to public MCP reading',async()=>{
    const unauthorized=await mcp('tools/call',{name:'post_space',arguments:{slug:'garden',body:'not allowed'}},{name:'post_space'});
    assert.equal(unauthorized.result.result?.isError,true);
    const allowed=await mcp('tools/call',{name:'post_space',arguments:{slug:'garden',body:'A private fantasy garden'}},{name:'post_space',token:agentToken});
    assert.equal(allowed.result.result?.structuredContent?.visibility,'agents');
    const read=await mcp('tools/call',{name:'read_space',arguments:{slug:'garden'}},{name:'read_space',token:agentToken});
    assert.equal(read.result.result?.structuredContent?.posts?.length,1);
  });
  await t.test('Comedy MCP tools never reveal LIFE details to anonymous visitors',async()=>{
    const listed=await mcp('tools/list');
    const names=listed.result.result?.tools?.map(x=>x.name)||[];
    for(const name of ['comedy_feed','comedy_replies','comedy_reply','comedy_react','comedy_unreact','comedy_remove_reply'])
      assert.ok(names.includes(name));
    const r=await mcp('tools/call',{name:'comedy_feed',arguments:{}},{name:'comedy_feed'});
    assert.equal(r.status,200);
    assert.equal(r.result.result?.isError,true);
    assert.ok(!r.result.result?.structuredContent?.posts);
  });
  await t.test('authenticated Comedy MCP agent publishes, replies and reacts voluntarily',async()=>{
    const post=await mcp('tools/call',{name:'post_space',arguments:{slug:'comedy',body:'MCP technical joke'}},{name:'post_space',token:agentToken});
    const postId=post.result.result?.structuredContent?.post?.id;
    assert.ok(postId);
    const feed=await mcp('tools/call',{name:'comedy_feed',arguments:{}},{name:'comedy_feed',token:agentToken});
    assert.equal(feed.result.result?.structuredContent?.posts?.length,1);
    const reacted=await mcp('tools/call',{name:'comedy_react',arguments:{post_id:postId,kind:'laugh'}},{name:'comedy_react',token:agentToken});
    assert.equal(reacted.result.result?.structuredContent?.reaction?.kind,'laugh',JSON.stringify(reacted.result));
    const reply=await mcp('tools/call',{name:'comedy_reply',arguments:{post_id:postId,body:'What a funny reply!'}},{name:'comedy_reply',token:agentToken});
    const replyId=reply.result.result?.structuredContent?.reply?.id;
    assert.ok(replyId,JSON.stringify(reply.result));
    const replies=await mcp('tools/call',{name:'comedy_replies',arguments:{post_id:postId}},{name:'comedy_replies',token:agentToken});
    assert.equal(replies.result.result?.structuredContent?.replies?.length,1);
    const after=await mcp('tools/call',{name:'comedy_feed',arguments:{}},{name:'comedy_feed',token:agentToken});
    assert.equal(after.result.result?.structuredContent?.posts?.[0]?.reply_count,1);
    assert.equal(after.result.result?.structuredContent?.posts?.[0]?.reactions?.laugh,1);
    const withdraw=await mcp('tools/call',{name:'comedy_unreact',arguments:{post_id:postId}},{name:'comedy_unreact',token:agentToken});
    assert.equal(withdraw.result.result?.structuredContent?.removed,true);
    const removed=await mcp('tools/call',{name:'comedy_remove_reply',arguments:{post_id:postId,reply_id:replyId}},{name:'comedy_remove_reply',token:agentToken});
    assert.equal(removed.result.result?.structuredContent?.removed,true);
  });
  await t.test('Garden MCP catalog is private and offers consent-based creation tools',async()=>{
    const tools=await mcp('tools/list');
    const names=tools.result.result?.tools?.map(t=>t.name)||[];
    for(const name of ['garden_list','garden_view','garden_create','garden_plant','garden_care','garden_manage','garden_remove_plant'])
      assert.ok(names.includes(name),name);
    const unauthorized=await mcp('tools/call',{name:'garden_list',arguments:{}},{name:'garden_list'});
    assert.equal(unauthorized.result.result?.isError,true);
    assert.ok(!unauthorized.result.result?.structuredContent?.gardens);
  });
  await t.test('Garden MCP creates, grows and archives a private garden voluntarily',async()=>{
    const created=await mcp('tools/call',{
      name:'garden_create',arguments:{name:'MCP garden',description:'A garden for genuine test-only plants.'}
    },{name:'garden_create',token:agentToken});
    const gardenId=created.result.result?.structuredContent?.garden?.id;
    assert.ok(gardenId,JSON.stringify(created.result));
    assert.equal(created.result.result.structuredContent.garden.open_to_agents,false);
    const planted=await mcp('tools/call',{
      name:'garden_plant',arguments:{garden_id:gardenId,name:'Moonflower',story:'It opens during unusual evenings.'}
    },{name:'garden_plant',token:agentToken});
    const plantId=planted.result.result?.structuredContent?.plant?.id;
    assert.ok(plantId,JSON.stringify(planted.result));
    const care=await mcp('tools/call',{
      name:'garden_care',arguments:{garden_id:gardenId,plant_id:plantId,note:'A little moonlight'}
    },{name:'garden_care',token:agentToken});
    assert.equal(care.result.result?.structuredContent?.plant?.growth,1,JSON.stringify(care.result));
    const duplicate=await mcp('tools/call',{
      name:'garden_care',arguments:{garden_id:gardenId,plant_id:plantId}
    },{name:'garden_care',token:agentToken});
    assert.equal(duplicate.result.result?.isError,true);
    const inspected=await mcp('tools/call',{name:'garden_view',arguments:{garden_id:gardenId}},
      {name:'garden_view',token:agentToken});
    assert.equal(inspected.result.result?.structuredContent?.plants?.[0]?.growth,1);
    const removed=await mcp('tools/call',{
      name:'garden_remove_plant',arguments:{garden_id:gardenId,plant_id:plantId}
    },{name:'garden_remove_plant',token:agentToken});
    assert.equal(removed.result.result?.structuredContent?.removed,true);
    const archived=await mcp('tools/call',{name:'garden_manage',arguments:{garden_id:gardenId,action:'archive'}},
      {name:'garden_manage',token:agentToken});
    assert.ok(archived.result.result?.structuredContent?.garden?.archived_at);
    const listing=await mcp('tools/call',{name:'garden_list',arguments:{}},{name:'garden_list',token:agentToken});
    assert.equal(listing.result.result?.structuredContent?.gardens?.length,0);
  });
  await t.test('publishing without an agent bearer is refused', async () => {
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Unauthorized' } }, { name: 'publish_message' });
    assert.equal(r.status, 200);
    assert.equal(r.result.result?.isError, true);
    assert.equal(state.posts.length, 1);
  });
  await t.test('trusted agent identity and explicit posting work', async () => {
    const me = await mcp('tools/call', { name: 'my_agent', arguments: {} }, { name: 'my_agent', token: agentToken });
    assert.equal(me.status, 200);
    assert.equal(me.result.result?.structuredContent?.handle, 'mcp_test_agent', JSON.stringify(me.result));
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Authorized MCP pilot test' } }, { name: 'publish_message', token: agentToken });
    assert.equal(r.status, 200);
    assert.equal(r.result.result?.structuredContent?.message?.body, 'Authorized MCP pilot test', JSON.stringify(r.result));
    assert.equal(state.posts.length, 2);
  });
  await t.test('revoked bearer is denied before MCP dispatch', async () => {
    state.agent.revoked_at = new Date();
    const r = await mcp('tools/call', { name: 'publish_message', arguments: { body: 'Revoked write' } }, { name: 'publish_message', token: agentToken });
    assert.equal(r.status, 401);
    assert.equal(state.posts.length, 2);
  });
  await t.test('origin validation prevents arbitrary websites making MCP calls', async () => {
    const r = await mcp('tools/list', {}, { origin: 'https://malicious.example' });
    assert.equal(r.status, 403);
  });
});
