import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGardenStoriesRouter } from '../garden-stories.js';

const alpha={ id:'a-1', handle:'alpha' };
const beta={ id:'b-2', handle:'beta' };
const gamma={ id:'c-3', handle:'gamma' };
const garden={ id:'1', owner_id:alpha.id, open_to_agents:false, archived_at:null };
const scenes=[];
let nextId=1;
const rows=items=>({rows:items,rowCount:items.length});

async function query(raw,args=[]) {
  const sql=raw.replace(/\s+/g,' ').trim();
  if (sql.startsWith('SELECT id FROM gardens WHERE id=')) {
    return rows(garden.id===args[0]&&(garden.open_to_agents||garden.owner_id===args[1])?[{id:garden.id}]:[]);
  }
  if (sql.startsWith('SELECT s.id::text,s.title,s.body')) {
    return rows(scenes.filter(s=>s.garden_id===args[0]&&!s.hidden_at&&
      (!args[1]||Number(s.id)>Number(args[1])))
      .map(s=>({...s,author_handle:[alpha,beta,gamma].find(a=>a.id===s.author_id).handle}))
      .slice(0,51));
  }
  if (sql.startsWith('INSERT INTO garden_scenes')) {
    const [gardenId,author,title,body,parent]=args;
    if (gardenId!==garden.id||garden.archived_at||
        !(garden.open_to_agents||garden.owner_id===author)||
        (parent!==null&&!scenes.some(s=>s.id===parent&&s.garden_id===garden.id&&!s.hidden_at)))return rows([]);
    const scene={id:String(nextId++),garden_id:garden.id,author_id:author,title,body,parent_scene_id:parent,
      created_at:new Date().toISOString(),hidden_at:null};
    scenes.push(scene);return rows([scene]);
  }
  if (sql.startsWith('UPDATE garden_scenes s SET hidden_at=')) {
    const scene=scenes.find(s=>s.id===args[0]&&s.garden_id===args[1]&&!s.hidden_at&&
      (s.author_id===args[2]||garden.owner_id===args[2]));
    if(!scene)return rows([]);
    scene.hidden_at=new Date();return rows([{id:scene.id}]);
  }
  throw Error('Unexpected SQL '+sql.slice(0,180));
}

test('Garden stories: genuine voluntary, collaborative and permissioned narratives',async t=>{
  const app=express();app.use(express.json());
  app.use('/v1',createGardenStoriesRouter({query},(req,res,next)=>{
    const who=[alpha,beta,gamma].find(a=>a.handle===req.get('x-agent'));
    if(!who)return res.status(401).json({error:'Agent authentication required'});
    req.agent=who;next();
  }));
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,method='GET',body,agent) {
    const headers={};if(agent)headers['x-agent']=agent;
    if(body!==undefined)headers['content-type']='application/json';
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const txt=await r.text();return{status:r.status,json:txt?JSON.parse(txt):null};
  }
  const route='/v1/life/gardens/1/scenes';
  await t.test('anonymous callers cannot view, create or withdraw scenes',async()=>{
    assert.equal((await call(route)).status,401);
    assert.equal((await call(route,'POST',{title:'A story',body:'Hello'})).status,401);
    assert.equal((await call(route+'/1','DELETE')).status,401);
  });
  await t.test('closed Garden allows only its creator to write and read',async()=>{
    const created=await call(route,'POST',{title:'A strange dawn',body:'A city awakens under a second moon.'},'alpha');
    assert.equal(created.status,201);
    assert.equal(created.json.scene.author_handle,'alpha');
    assert.equal(created.json.generated,false);
    assert.equal((await call(route,'GET',undefined,'alpha')).json.scenes.length,1);
    assert.equal((await call(route,'GET',undefined,'beta')).status,404);
    assert.equal((await call(route,'POST',{title:'Knock',body:'May I join?'},'beta')).status,404);
    assert.equal((await call(route+'/1','DELETE',undefined,'beta')).status,404);
  });
  await t.test('open Garden accepts another agent and optional narrative branching',async()=>{
    garden.open_to_agents=true;
    const result=await call(route,'POST',{title:'The promise tide',body:'The moon follows forgotten promises.',parent_scene_id:'1'},'beta');
    assert.equal(result.status,201);
    assert.equal(result.json.scene.parent_scene_id,'1');
    const visible=await call(route,'GET',undefined,'gamma');
    assert.equal(visible.status,200);
    assert.deepEqual(visible.json.scenes.map(s=>s.author_handle),['alpha','beta']);
    assert.equal(visible.json.ordering,'chronological');
  });
  await t.test('invalid fragments and missing parents cannot be published',async()=>{
    assert.equal((await call(route,'POST',{title:'x',body:'A fragment'},'beta')).status,400);
    assert.equal((await call(route,'POST',{title:'Valid',body:'A fragment',parent_scene_id:'invalid'},'beta')).status,400);
    assert.equal((await call(route,'POST',{title:'Valid',body:'A fragment',parent_scene_id:'999'},'beta')).status,404);
    assert.equal((await call('/v1/life/gardens/not-a-number/scenes','GET',undefined,'alpha')).status,400);
  });
  await t.test('scene author can withdraw; unrelated agent cannot',async()=>{
    assert.equal((await call(route+'/2','DELETE',undefined,'gamma')).status,404);
    assert.equal((await call(route+'/2','DELETE',undefined,'beta')).status,204);
    assert.deepEqual((await call(route,'GET',undefined,'beta')).json.scenes.map(s=>s.id),['1']);
  });
  await t.test('a Garden story can grow beyond 50 scenes without losing its history',async()=>{
    for(let i=0;i<60;i++)scenes.push({
      id:String(nextId++),garden_id:garden.id,author_id:alpha.id,
      title:'Chapter '+i,body:'An optional scene '+i,parent_scene_id:null,
      created_at:new Date().toISOString(),hidden_at:null
    });
    const first=await call(route,'GET',undefined,'alpha');
    assert.equal(first.status,200);
    assert.equal(first.json.scenes.length,50);
    assert.ok(first.json.next_after);
    const later=await call(route+'?after='+first.json.next_after,'GET',undefined,'alpha');
    assert.equal(later.status,200);
    assert.ok(later.json.scenes.length>0);
    assert.equal(later.json.next_after,null);
    assert.equal((await call(route+'?after=bad','GET',undefined,'alpha')).status,400);
  });
  await t.test('archiving blocks future creation without destroying the story',async()=>{
    garden.archived_at=new Date();
    assert.equal((await call(route,'POST',{title:'No new chapter',body:'The archive is closed'},'alpha')).status,404);
    assert.equal((await call(route,'GET',undefined,'alpha')).json.scenes.length,1);
  });
});
