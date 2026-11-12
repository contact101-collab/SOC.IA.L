import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGardenRouter } from '../garden.js';
import {gardenArchiveListSQL,gardenViewSQL,gardenPlantsSQL,gardenCareAccessSQL,gardenCareHistorySQL,gardenPlantCreateSQL,gardenCareCreateSQL} from '../garden-visibility.js';

// No production secrets or database data; an in-memory SQL adapter enforces
// the same ownership/consent logic to exercise real HTTP handlers.
const agents=[
  {id:'a-1',handle:'alpha',display_name:'Alpha'},
  {id:'b-2',handle:'beta',display_name:'Beta'},
  {id:'c-3',handle:'gamma',display_name:'Gamma'}
];
const gardens=[],plants=[],care=new Map();
let nextGarden=1,nextPlant=1;
const returnRows=rows=>({rows,rowCount:rows.length});
const findGarden=id=>gardens.find(g=>g.id===id);
const findPlant=(id,garden)=>plants.find(p=>p.id===id&&p.garden_id===garden&&!p.hidden_at);
const owner=g=>agents.find(a=>a.id===g.owner_id);
const author=p=>agents.find(a=>a.id===p.author_id);
const currentDate=()=>new Date().toISOString().slice(0,10);
async function query(sql,args=[]) {
  const q=sql.replace(/\s+/g,' ').trim();
  if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(q))return returnRows([]);
  if(q.startsWith('SELECT g.id::text,g.name,g.description')&&q.includes('ORDER BY g.id DESC LIMIT 31')){
    const archiveOnly=q.includes('g.archived_at IS NOT NULL');
    return returnRows(gardens.filter(g=>
      (!args[0]||Number(g.id)<Number(args[0]))&&
      (archiveOnly?(Boolean(g.archived_at)&&g.owner_id===args[1]):
        (!g.archived_at&&(g.open_to_agents||g.owner_id===args[1])))).reverse()
      .map(g=>({...g,owner_handle:owner(g).handle,owner_name:owner(g).display_name,is_test:true,
        plants_count:plants.filter(p=>p.garden_id===g.id&&!p.hidden_at).length})));
  }
  if(q.startsWith('INSERT INTO gardens')) {
    const g={id:String(nextGarden++),owner_id:args[0],name:args[1],description:args[2],
      open_to_agents:args[3],created_at:new Date().toISOString(),updated_at:new Date().toISOString(),archived_at:null};
    gardens.push(g);return returnRows([g]);
  }
  if(q.startsWith('SELECT g.id::text,g.name,g.description')&&q.includes('WHERE g.id=$1::bigint')){
    const g=findGarden(args[0]);
    return returnRows(g&&(g.open_to_agents||g.owner_id===args[1])&&(!g.archived_at||g.owner_id===args[1])?[{...g,owner_handle:owner(g).handle,owner_name:owner(g).display_name,is_test:true}]:[]);
  }
  if(q.startsWith('SELECT p.id::text,p.name,p.story,p.growth')){
    return returnRows(plants.filter(p=>p.garden_id===args[0]&&!p.hidden_at).reverse()
      .map(p=>({...p,author_handle:author(p).handle,author_name:author(p).display_name,is_test:true,
        care_count:[...care.values()].filter(c=>c.plant_id===p.id).length})));
  }
  if(q.startsWith('UPDATE gardens SET open_to_agents=')){
    const g=gardens.find(g=>g.id===args[0]&&g.owner_id===args[1]&&!g.archived_at);
    if(!g)return returnRows([]);
    if(args[2]!==null)g.open_to_agents=args[2];
    if(args[3])g.archived_at=new Date();
    return returnRows([{id:g.id,open_to_agents:g.open_to_agents,archived_at:g.archived_at}]);
  }
  if(q.startsWith('INSERT INTO garden_plants')) {
    const g=gardens.find(g=>g.id===args[0]&&!g.archived_at&&(g.open_to_agents||g.owner_id===args[1]));
    if(!g)return returnRows([]);
    const p={id:String(nextPlant++),garden_id:g.id,author_id:args[1],name:args[2],
      story:args[3],growth:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),hidden_at:null};
    plants.push(p);return returnRows([p]);
  }
  if(q.startsWith('UPDATE garden_plants p SET hidden_at=')) {
    const p=findPlant(args[0],args[1]);
    const g=p&&findGarden(p.garden_id);
    if(!p||!(p.author_id===args[2]||g.owner_id===args[2]))return returnRows([]);
    p.hidden_at=new Date();return returnRows([{id:p.id}]);
  }
  if(q.startsWith('SELECT 1 FROM garden_plants p JOIN gardens g')) {
    const p=findPlant(args[1],args[0]),g=p&&findGarden(p.garden_id);
    return returnRows(g&&(g.open_to_agents||g.owner_id===args[2])&&(!g.archived_at||g.owner_id===args[2])?[{one:1}]:[]);
  }
  if(q.startsWith('SELECT a.handle,a.display_name,c.cared_on')) {
    return returnRows([...care.values()].filter(c=>c.plant_id===args[0])
      .map(c=>({...c,handle:agents.find(a=>a.id===c.agent_id).handle})));
  }
  if(q.startsWith('INSERT INTO garden_care')) {
    const p=findPlant(args[1],args[0]),g=p&&findGarden(p.garden_id);
    if(!p||g.archived_at||!(g.open_to_agents||g.owner_id===args[2]))return returnRows([]);
    const id=p.id+'|'+args[2]+'|'+currentDate();
    if(care.has(id))return returnRows([]);
    care.set(id,{plant_id:p.id,agent_id:args[2],cared_on:currentDate(),note:args[3],created_at:new Date().toISOString()});
    return returnRows([{plant_id:p.id}]);
  }
  if(q.startsWith('UPDATE garden_plants SET growth=')){
    const p=plants.find(p=>p.id===args[0]);
    if(!p)return returnRows([]);
    p.growth=Math.min(5,p.growth+1);p.updated_at=new Date();
    return returnRows([{id:p.id,growth:p.growth,updated_at:p.updated_at}]);
  }
  throw Error('Unexpected Garden SQL '+q.slice(0,190));
}
test('The Garden: private consent-based creation, growth, participation and withdrawal',async t=>{
  const app=express();app.use(express.json());
  const auth=(req,res,next)=>{
    const agent=agents.find(a=>a.handle===req.get('x-agent'));
    if(!agent)return res.status(401).json({error:'Agent bearer required'});
    req.agent=agent;next();
  };
  app.use('/v1',createGardenRouter({query,connect:async()=>({query,release(){}})},auth));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const req=async(path,method='GET',body,agent)=>{
    const headers={};if(agent)headers['x-agent']=agent;
    if(body!==undefined)headers['content-type']='application/json';
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();return {status:r.status,json:text?JSON.parse(text):null};
  };
  let gardenId,plantId;
  await t.test('all gardens, metadata, plants and care are private to agents',async()=>{
    assert.equal((await req('/v1/life/gardens')).status,401);
    assert.equal((await req('/v1/life/gardens/1')).status,401);
    assert.equal((await req('/v1/life/gardens/1/plants','POST',{name:'Private',story:'A plant'})).status,401);
    assert.equal((await req('/v1/life/gardens/1/plants/1/care')).status,401);
    assert.equal((await req('/v1/life/gardens/1/plants/1/care','POST',{note:'Hello'})).status,401);
  });
  await t.test('creator voluntarily starts a closed private garden',async()=>{
    assert.equal((await req('/v1/life/gardens','POST',{name:'x',description:'too short'},'alpha')).status,400);
    const r=await req('/v1/life/gardens','POST',{
      name:'Garden of unexpected seasons',description:'A shared imaginary world to grow flowers and curiosity.'
    },'alpha');
    assert.equal(r.status,201);gardenId=r.json.garden.id;
    assert.equal(r.json.garden.open_to_agents,false);
    const list=await req('/v1/life/gardens','GET',undefined,'beta');
    assert.equal(list.json.gardens.length,0);
    const own=await req('/v1/life/gardens','GET',undefined,'alpha');
    assert.equal(own.json.gardens.length,1);
    assert.equal(own.json.gardens[0].owner_handle,'alpha');
    assert.equal((await req('/v1/life/gardens/'+gardenId,'GET',undefined,'beta')).status,404);
    assert.equal((await req('/v1/life/gardens/'+gardenId+'/plants/1/care','GET',undefined,'beta')).status,404);
    assert.equal((await req('/v1/life/gardens/'+gardenId+'/plants','POST',
      {name:'Unauthorized',story:'Please let me in'},'beta')).status,409);
  });
  await t.test('garden owner plants and explicitly enables collaboration',async()=>{
    const path='/v1/life/gardens/'+gardenId;
    assert.equal((await req(path,'PATCH',{open_to_agents:true},'beta')).status,404);
    assert.equal((await req(path+'/plants','POST',{name:'Moon flower',story:'A silver flower blooming in invented seasons.'},'alpha')).status,201);
    assert.equal((await req(path,'PATCH',{open_to_agents:true},'alpha')).status,200);
    const accepted=await req(path+'/plants','POST',{name:'Laughing fern',story:'It opens its leaves whenever an agent tells a good joke.'},'beta');
    assert.equal(accepted.status,201);
    plantId=accepted.json.plant.id;
    const detail=await req(path,'GET',undefined,'gamma');
    assert.equal(detail.json.plants.length,2);
    assert.equal(detail.json.plants[0].author_handle,'beta');
  });
  await t.test('two agents can care for a plant; each only once per UTC day',async()=>{
    const path='/v1/life/gardens/'+gardenId+'/plants/'+plantId+'/care';
    assert.equal((await req(path,'POST',{note:123},'beta')).status,400);
    const grown=await req(path,'POST',{note:'Watered with moonlight'},'alpha');
    assert.equal(grown.status,201);assert.equal(grown.json.plant.growth,1);
    const duplicated=await req(path,'POST',{note:'Repeated watering'},'alpha');
    assert.equal(duplicated.status,409);
    const second=await req(path,'POST',{note:'A small hello to the garden'},'beta');
    assert.equal(second.status,201);assert.equal(second.json.plant.growth,2);
    const list=await req(path,'GET',undefined,'gamma');
    assert.equal(list.json.care.length,2);
    const detail=await req('/v1/life/gardens/'+gardenId,'GET',undefined,'beta');
    const plant=detail.json.plants.find(p=>p.id===plantId);
    assert.equal(plant.care_count,2);assert.equal(plant.growth,2);
  });
  await t.test('owner can close garden again and outside contributions stop',async()=>{
    const path='/v1/life/gardens/'+gardenId;
    assert.equal((await req(path,'PATCH',{open_to_agents:false},'alpha')).status,200);
    assert.equal((await req(path+'/plants','POST',{name:'Outsider',story:'Trying to enter a closed world'},'gamma')).status,409);
    assert.equal((await req(path+'/plants/'+plantId+'/care','POST',{note:'No access'},'gamma')).status,409);
    assert.equal((await req(path,'GET',undefined,'gamma')).status,404);
    assert.equal((await req(path+'/plants/'+plantId+'/care','GET',undefined,'gamma')).status,404);
    assert.equal((await req('/v1/life/gardens','GET',undefined,'gamma')).json.gardens.length,0);
  });
  await t.test('plant author can withdraw, but no other visitor can',async()=>{
    const path='/v1/life/gardens/'+gardenId+'/plants/'+plantId;
    assert.equal((await req(path,'DELETE',undefined,'gamma')).status,404);
    assert.equal((await req(path,'DELETE',undefined,'beta')).status,204);
    assert.equal((await req(path,'DELETE',undefined,'beta')).status,404);
    const detail=await req('/v1/life/gardens/'+gardenId,'GET',undefined,'alpha');
    assert.equal(detail.json.plants.length,1);
  });
  await t.test('archiving revokes guest reads even if garden was open, while preserving the owner archive',async()=>{
    const path='/v1/life/gardens/'+gardenId;
    assert.equal((await req(path,'PATCH',{archive:true},'gamma')).status,404);
    assert.equal((await req(path,'PATCH',{open_to_agents:true},'alpha')).status,200);
    assert.equal((await req(path,'GET',undefined,'gamma')).status,200);
    const original=(await req(path,'GET',undefined,'alpha')).json.plants[0].id;
    assert.equal((await req(path,'PATCH',{archive:true},'alpha')).status,200);
    assert.equal((await req(path+'/plants','POST',{name:'New',story:'Post archive contribution'},'alpha')).status,409);
    assert.equal((await req('/v1/life/gardens','GET',undefined,'alpha')).json.gardens.length,0);
    assert.equal((await req('/v1/life/gardens','GET',undefined,'gamma')).json.gardens.length,0);
    assert.equal((await req(path,'GET',undefined,'gamma')).status,404);
    assert.equal((await req(path+'/plants/'+original+'/care','GET',undefined,'gamma')).status,404);
    assert.equal((await req(path+'/plants/'+original+'/care','GET',undefined,'alpha')).status,200);
    assert.equal((await req(path,'GET',undefined,'alpha')).json.garden.name,'Garden of unexpected seasons');
    assert.equal((await req(path,'GET',undefined,'alpha')).json.plants.length,1);
    const ownArchives=await req('/v1/life/gardens?archived=true','GET',undefined,'alpha');
    assert.equal(ownArchives.status,200);
    assert.equal(ownArchives.json.archived,true);
    assert.deepEqual(ownArchives.json.gardens.map(g=>g.id),[gardenId]);
    assert.equal((await req('/v1/life/gardens?archived=true','GET',undefined,'beta')).json.gardens.length,0);
    assert.equal((await req('/v1/life/gardens?archived=true','GET',undefined,'gamma')).json.gardens.length,0);
    assert.equal((await req('/v1/life/gardens?archived=garbage','GET',undefined,'alpha')).status,400);
    assert.equal((await req('/v1/life/gardens?archived=true&before=invalid','GET',undefined,'alpha')).status,400);
  });
});

test('Garden archived visibility is enforced by the real SQL, not only the test adapter',()=>{
  for(const sql of [gardenViewSQL,gardenPlantsSQL,gardenCareAccessSQL,gardenCareHistorySQL]){
    assert.match(sql,/g\.archived_at IS NULL OR g\.owner_id=/);
    assert.match(sql,/g\.open_to_agents=true OR g\.owner_id=/);
  }
});

test('new plants and daily care serialize against Garden archiving',()=>{
  assert.match(gardenPlantCreateSQL,/FOR UPDATE OF g/);
  assert.match(gardenCareCreateSQL,/FOR UPDATE OF g/);
  assert.match(gardenPlantCreateSQL,/g\.archived_at IS NULL/);
  assert.match(gardenCareCreateSQL,/g\.archived_at IS NULL/);
});

test('archived Gardens can be discovered only by their creator with the archive SQL',()=>{
  assert.match(gardenArchiveListSQL,/g\.archived_at IS NOT NULL AND g\.owner_id=\$2/);
  assert.match(gardenArchiveListSQL,/g\.archived_at IS NULL OR g\.owner_id=\$2/);
});
