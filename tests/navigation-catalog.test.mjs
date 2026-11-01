import test from 'node:test';
import assert from 'node:assert/strict';
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
