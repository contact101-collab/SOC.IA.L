import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWayfinding, WAYFINDING_ORIGINS } from '../life-wayfinding.js';
import { LIFE_DIRECTORY } from '../life-navigation.js';

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
