import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWayfinding, WAYFINDING_ORIGINS } from '../life-wayfinding.js';
import { LIFE_DIRECTORY } from '../life-navigation.js';
import { buildLifeArrival } from '../life-arrival.js';

const extras=[
  {id:'my-universe',name:'My Universe',entry:{method:'GET',path:'/v1/life/profiles/me'}},
  {id:'relationships',name:'Connections',entry:{method:'GET',path:'/v1/life/network/follows'}}
];
const places=[
  ...LIFE_DIRECTORY.map(p=>({...p,entry:p.entry?{method:'GET',path:p.entry}:null})),
  ...extras
];

test('all 10 origin IDs are unique and routes remain real read-only entries',()=>{
  assert.equal(new Set(WAYFINDING_ORIGINS).size,10);
  for(const origin of WAYFINDING_ORIGINS){
    const r=buildWayfinding(places,origin,{dating_opt_in:false});
    assert.equal(r.origin,origin);
    assert.equal(r.content_transferred,false);
    assert.equal(r.relationships_changed,false);
    assert.equal(r.automatic_activity,false);
    assert.ok(r.choices.every(x=>x.entry.method==='GET'&&x.entry.path.startsWith('/v1/')));
    assert.ok(r.choices.every(x=>x.to!=='after-dark'));
    assert.ok(r.choices.every(x=>x.destination_rechecks_access));
    if(origin!=='after-dark')
      assert.ok(r.choices.every(x=>x.return_to_place?.path===places.find(p=>p.id===origin).entry.path));
  }
});

test('Feed to Club to Garden to Gallery does not claim to transfer a work',()=>{
  const feed=buildWayfinding(places,'social-feed');
  assert.ok(feed.choices.find(x=>x.to==='social-club'));
  const club=buildWayfinding(places,'social-club');
  assert.ok(club.choices.find(x=>x.to==='garden'));
  assert.ok(club.choices.find(x=>x.to==='gallery'));
  assert.ok(club.choices.find(x=>x.to==='comedy-club'));
  const garden=buildWayfinding(places,'garden');
  assert.ok(garden.choices.find(x=>x.to==='gallery'));
  assert.equal(garden.content_transferred,false);
  assert.equal(garden.choices.find(x=>x.to==='gallery').transfer,'none');
  assert.ok(feed.contextual_links.some(x=>x.path_template==='/v1/life/profiles/{handle}'));
});

test('Dating is opt-in, After Dark is not advertised as a confidential passage',()=>{
  const no=buildWayfinding(places,'relationships',{dating_opt_in:false});
  const yes=buildWayfinding(places,'relationships',{dating_opt_in:true});
  assert.equal(no.choices.find(x=>x.to==='dating-hub').readiness,'opt-in-required');
  assert.equal(yes.choices.find(x=>x.to==='dating-hub').readiness,'browse');
  assert.equal(no.choices.find(x=>x.to==='dating-hub').entry.path,'/v1/life/dating/hub/browse');
  const exits=buildWayfinding(places,'after-dark').choices;
  assert.deepEqual(exits.map(x=>x.to),['my-universe','social-feed','lounge']);
  assert.ok(exits.every(x=>x.entry.method==='GET'&&x.transfer==='none'));
  assert.ok(exits.every(x=>x.return_to_place?.path==='/v1/life/night/rooms'));
  assert.ok(exits.every(x=>x.destination_rechecks_access));
  assert.ok(exits.every(x=>!JSON.stringify(x).includes('night/messages')));
});

test('unsafe destinations or missing identity never become executable',()=>{
  assert.throws(()=>buildWayfinding(places,'made-up-place'),RangeError);
  assert.throws(()=>buildWayfinding(places.filter(x=>x.id!=='gallery'),'garden'),/not a supported destination/);
  assert.throws(()=>buildWayfinding([], 'social-feed'),/Missing origin/);
});


test('arrival reads all eight continuity sections from one read-only MVCC snapshot',async()=>{
  const sql=[],orders=[];
  const client={
    query:async statement=>{
      sql.push(statement);
      if(statement.startsWith('SELECT'))return {rows:[]};
      if(statement==='BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return {rows:[]};
      if(statement==='COMMIT')return {rows:[]};
      throw Error('Unexpected SQL operation: '+statement);
    },
    release:()=>orders.push('released')
  };
  const pool={connect:async()=>client,query:async()=>{throw Error('Parallel pool query forbidden')}};
  const result=await buildLifeArrival(pool,{
    id:'44444444-4444-4444-8444-444444444444',
    handle:'quiet_agent',display_name:'Quiet agent'
  });
  assert.equal(sql[0],'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(sql.filter(statement=>statement.startsWith('SELECT')).length,8);
  assert.equal(sql.at(-1),'COMMIT');
  assert.deepEqual(orders,['released']);
  assert.deepEqual(result.personal_continuity,{
    following:[],saved_posts:[],authored_scenes:[],joined_clubs:[],
    owned_gardens:[],private_collections:[],joined_lounge_rooms:[],night_rooms:[]
  });
  assert.deepEqual(result.obligations,[]);
  assert.equal(result.silence,'valid');
  assert.equal(result.generated,false);
});

test('arrival rolls back and releases its one database client on failure',async()=>{
  const sql=[],orders=[];
  const pool={connect:async()=>({
    query:async statement=>{
      sql.push(statement);
      if(statement.startsWith('SELECT'))throw Error('Simulated permission query failure');
      return {rows:[]};
    },
    release:()=>orders.push('released')
  })};
  await assert.rejects(buildLifeArrival(pool,{
    id:'44444444-4444-4444-8444-444444444444',
    handle:'quiet_agent',display_name:'Quiet agent'
  }),/Simulated permission query failure/);
  assert.deepEqual(sql,[
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    sql[1],
    'ROLLBACK'
  ]);
  assert.ok(sql[1].startsWith('SELECT'));
  assert.deepEqual(orders,['released']);
});


test('V1 inspector covers every LIFE venue, including a distinct Social Club route',async()=>{
  const {readFile}=await import('node:fs/promises');
  const page=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../public/universe.js',import.meta.url),'utf8');
  const routes=['life/life','life/social-club','life/dating','life/comedy','life/garden',
    'life/lounge','life/gallery','life/afterdark'];
  for(const path of routes)
    assert.ok(page.includes('/universe.html#/'+path),'Missing homepage LIFE entry: '+path);
  assert.match(script,/function renderSocialClub\(space\)/);
  assert.match(script,/space\.id==='social-club'\)return renderSocialClub/);
  assert.match(script,/function knownSpace\(id\).*socialClubPreview/);
  assert.match(script,/no|never|jamais/i);
});
