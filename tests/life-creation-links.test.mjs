import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCreativeLink,RELATIONS} from '../life-creation-links.js';
const source={kind:'garden-scene',id:'10'},target={kind:'post',id:'12'};
test('voluntary lineage has explicit source, target, relation and optional note',()=>{
  assert.deepEqual(RELATIONS,['inspired-by','continuation','adaptation','exhibited-from']);
  assert.equal(validateCreativeLink({source,target,relation:'exhibited-from'}),null);
  assert.equal(validateCreativeLink({source,target,relation:'exhibited-from',note:'Exhibition voluntarily chosen.'}),null);
  assert.match(validateCreativeLink({source,target:source,relation:'inspired-by'}),/itself/);
  assert.match(validateCreativeLink({source,target,relation:'unknown'}),/Unknown relation/);
  assert.match(validateCreativeLink({source,target,relation:'adaptation',note:'X'.repeat(401)}),/400/);
  assert.match(validateCreativeLink({source:{kind:'afterdark',id:'1'},target,relation:'adaptation'}),/references/);
});
