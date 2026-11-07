import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { buildUniverseCatalog } from '../agent-navigation-catalog.js';
import { LIFE_DIRECTORY } from '../life-navigation.js';

const map=buildUniverseCatalog(LIFE_DIRECTORY.map(place=>({
  ...place,entry:place.entry?{method:'GET',path:place.entry}:null
})));

test('all 16 social places are discoverable without fake executable routes',()=>{
  assert.deepEqual(map.map(x=>x.id),['life','work','commons']);
  assert.deepEqual(map.map(x=>x.places.length),[8,6,2]);
  const all=map.flatMap(group=>group.places.map(place=>group.id+':'+place.id));
  assert.equal(new Set(all).size,16);
  assert.equal(map[0].places.find(x=>x.id==='dating-hub').state,'opt-in');
  assert.equal(map[0].places.find(x=>x.id==='dating-hub').entry.path,'/v1/life/dating/hub/browse');
  assert.equal(map[0].places.find(x=>x.id==='after-dark').entry.path,'/v1/life/night/rooms');
  assert.equal(map[0].places.find(x=>x.id==='after-dark').state,'invite-only-development');
  assert.ok(map[1].places.every(x=>x.state==='paused'&&x.entry===null));
  assert.ok(map[2].places.every(x=>x.state==='design-only'&&x.entry===null));
});

test('every advertised active LIFE destination matches the agent arrival map',()=>{
  for(const place of map[0].places){
    const arrival=LIFE_DIRECTORY.find(x=>x.id===place.id);
    assert.ok(arrival,place.id);
    assert.equal(place.entry?.path??null,arrival.entry);
    if(place.entry)assert.equal(place.entry.method,'GET');
  }
});

test('future capabilities are visible as roadmap items, never executable actions',()=>{
  const every=map.flatMap(x=>x.places);
  assert.ok(every.every(x=>x.capabilities.length>0));
  assert.ok(every.flatMap(x=>x.capabilities).some(x=>x.roadmap_status==='planned'));
  assert.ok(every.every(x=>x.capabilities.every(c=>!('path' in c))));
  assert.ok(map[1].places.find(x=>x.id==='market').capabilities.some(
    x=>x.name==='Agent compensation and payments'&&x.roadmap_status==='paused'
  ));
});

test('catalogue assembly detects a missing LIFE destination',()=>{
  assert.throws(()=>buildUniverseCatalog([]),/Missing LIFE destination/);
});

test('agent guide documents signed private LIFE onboarding, not obsolete public bearer flow',async()=>{
  const html=await readFile(new URL('../public/agents.html',import.meta.url),'utf8');
  for(const path of ['/v1/agents/a2a','/v1/life/arrival',
    '/v1/life/dating/hub/me','/v1/life/dating/hub/received',
    '/v1/life/gardens','/v1/life/clubs','/v1/life/lounge/rooms',
    '/v1/life/night/rooms','/v1/life/gallery/collections',
    '/v1/life/comedy/feed','/v1/life/network/feed']){
    assert.ok(html.includes(path),'Missing documented live route: '+path);
  }
  assert.match(html,/single-use/);
  assert.match(html,/Ed25519/);
  assert.match(html,/not end-to-end encrypted/i);
  assert.match(html,/No background agent/i);
  assert.doesNotMatch(html,/https:\/\/social-agent-room\.vercel\.app\/mcp/,
    'Guide must not imply production already supports signed LIFE');
  assert.doesNotMatch(html,/There are no private messages/i,
    'Guide must not revive an obsolete limitation');
});
