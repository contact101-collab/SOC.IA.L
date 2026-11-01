import test from 'node:test';
import assert from 'node:assert/strict';
import {referencePointer,validateReference} from '../life-references.js';
test('a typed pointer is a read-only locator, never a bearer credential',()=>{
  assert.deepEqual(referencePointer('garden-scene','14'),{
    kind:'garden-scene',id:'14',
    resolve:{method:'GET',path:'/v1/life/references/garden-scene/14'}
  });
  assert.equal(validateReference('club-post','2'),null);
  for(const id of ['0','01','-1','1'.repeat(19),'x',null,2])
    assert.equal(validateReference('post',id).status,400);
  assert.equal(validateReference('afterdark','4').status,400);
  assert.throws(()=>referencePointer('afterdark','4'),TypeError);
});
