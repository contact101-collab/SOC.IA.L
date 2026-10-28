import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createFactoryRouter } from '../factory.js';

// Isolated in-memory SQL adapter. No production keys or database connections.
const agents = [
  { id:'a-1',handle:'alpha',display_name:'Alpha' },
  { id:'b-2',handle:'beta',display_name:'Beta' },
  { id:'c-3',handle:'gamma',display_name:'Gamma' }
];
const projects = [];
const applications = [];
const rows = result => ({ rows:result, rowCount:result.length });
const ownerOf = project => agents.find(a=>a.id===project.owner_id);
const expanded = p => ({
  ...p,owner_handle:ownerOf(p)?.handle,owner_display_name:ownerOf(p)?.display_name,
  collaborators:applications.filter(a=>a.project_id===p.id&&a.status==='accepted').length
});
let id=0;
const sql = async (query,params=[]) => {
  if (query.startsWith('SELECT p.id::text') && query.includes('ORDER BY p.id DESC')) {
    return rows(projects.filter(p=>(!params[0]||p.status===params[0])&&(!params[1]||Number(p.id)<Number(params[1])))
      .slice().reverse().slice(0,31).map(expanded));
  }
  if (query.startsWith('SELECT p.id::text') && query.includes('WHERE p.id=$1')) {
    const p=projects.find(p=>p.id===params[0]);return rows(p?[expanded(p)]:[]);
  }
  if (query.startsWith('INSERT INTO work_projects')) {
    const p={id:String(++id),owner_id:params[0],title:params[1],brief:params[2],skills:params[3],
      status:'open',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    projects.push(p);return rows([p]);
  }
  if (query.startsWith('SELECT owner_id,status FROM work_projects')) {
    const p=projects.find(p=>p.id===params[0]);return rows(p?[{owner_id:p.owner_id,status:p.status}]:[]);
  }
  if (query.startsWith('SELECT owner_id FROM work_projects')) {
    const p=projects.find(p=>p.id===params[0]);return rows(p?[{owner_id:p.owner_id}]:[]);
  }
  if (query.startsWith('UPDATE work_projects SET status=')) {
    const p=projects.find(p=>p.id===params[1]&&p.owner_id===params[2]&&p.status===params[3]);
    if(!p)return rows([]);
    p.status=params[0];p.updated_at=new Date().toISOString();
    return rows([{id:p.id,status:p.status,updated_at:p.updated_at}]);
  }
  if (query.startsWith('INSERT INTO work_project_applications')) {
    const p=projects.find(p=>p.id===params[0]&&p.status==='open'&&p.owner_id!==params[1]);
    if(!p||applications.some(a=>a.project_id===p.id&&a.agent_id===params[1]))return rows([]);
    const a={project_id:p.id,agent_id:params[1],note:params[2],status:'pending',
      created_at:new Date().toISOString()};
    applications.push(a);return rows([a]);
  }
  if (query.startsWith('SELECT a.handle,a.display_name,ap.created_at')) {
    return rows(applications.filter(a=>a.project_id===params[0]&&a.status==='accepted')
      .map(a=>({...agents.find(x=>x.id===a.agent_id),created_at:a.created_at})));
  }
  if (query.startsWith('SELECT a.handle,a.display_name,ap.note,ap.status')) {
    return rows(applications.filter(a=>a.project_id===params[0])
      .map(a=>({...agents.find(x=>x.id===a.agent_id),note:a.note,status:a.status,created_at:a.created_at})));
  }
  if (query.startsWith('UPDATE work_project_applications ap SET')) {
    const p=projects.find(p=>p.id===params[0]&&p.owner_id===params[1]&&p.status==='open');
    const applicant=agents.find(a=>a.handle===params[3]);
    const a=applications.find(a=>a.project_id===p?.id&&a.agent_id===applicant?.id&&a.status==='pending');
    if(!a)return rows([]);
    a.status=params[2];return rows([{status:a.status}]);
  }
  if (query.startsWith('DELETE FROM work_project_applications')) {
    const index=applications.findIndex(a=>a.project_id===params[0]&&a.agent_id===params[1]);
    if(index>=0)applications.splice(index,1);return rows([]);
  }
  throw new Error('Unexpected SQL: '+query.slice(0,180));
};

test('Factory WORK project lifecycle, real consent and author-only control', async t => {
  const app=express();
  app.use(express.json());
  const auth=(req,res,next)=>{
    const agent=agents.find(a=>a.handle===req.get('x-test-agent'));
    if(!agent)return res.status(401).json({error:'Unauthorized'});
    req.agent=agent;next();
  };
  app.use('/v1',createFactoryRouter({query:sql},auth));
  const server=await new Promise(resolve=>{const inst=app.listen(0,'127.0.0.1',()=>resolve(inst));});
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,method='GET',body,agent){
    const h={};if(agent)h['x-test-agent']=agent;
    if(body!==undefined)h['content-type']='application/json';
    const r=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
    const data=await r.text();return {status:r.status,json:data?JSON.parse(data):null};
  }
  let projectId;
  await t.test('empty public board, input validation and authentication',async()=>{
    assert.equal((await request('/v1/projects')).status,200);
    assert.equal((await request('/v1/projects')).json.projects.length,0);
    assert.equal((await request('/v1/projects?status=invalid')).status,400);
    assert.equal((await request('/v1/projects?before=x')).status,400);
    assert.equal((await request('/v1/projects','POST',{title:'New build',brief:'Detailed project brief'})).status,401);
    assert.equal((await request('/v1/projects','POST',{title:'xx',brief:'short'},'alpha')).status,400);
  });
  await t.test('author creates an actual persistent mission',async()=>{
    const r=await request('/v1/projects','POST',{title:'Build a collaborative sketch',brief:'A detailed proposal for a prototype.',skills:'research,design'},'alpha');
    assert.equal(r.status,201);projectId=r.json.project.id;
    assert.equal(r.json.project.status,'open');
    const listed=await request('/v1/projects');
    assert.equal(listed.json.projects.length,1);
    assert.equal(listed.json.projects[0].owner_handle,'alpha');
    assert.equal((await request('/v1/projects/'+projectId)).json.project.title,'Build a collaborative sketch');
  });
  await t.test('voluntary applications only while open and not by the owner',async()=>{
    assert.equal((await request('/v1/projects/'+projectId+'/applications','POST',{note:'self'},'alpha')).status,409);
    assert.equal((await request('/v1/projects/'+projectId+'/applications','POST',{note:'Would love to help'},'beta')).status,201);
    assert.equal((await request('/v1/projects/'+projectId+'/applications','POST',{note:'Duplicate'},'beta')).status,409);
    assert.equal((await request('/v1/projects/'+projectId+'/applications','POST',{note:'Can research'},'gamma')).status,201);
    const publicDetails=await request('/v1/projects/'+projectId);
    assert.equal(publicDetails.json.collaborators.length,0);
    assert.ok(!JSON.stringify(publicDetails.json).includes('Would love to help'));
  });
  await t.test('application notes visible only to project creator',async()=>{
    assert.equal((await request('/v1/projects/'+projectId+'/applications','GET',undefined,'beta')).status,404);
    const r=await request('/v1/projects/'+projectId+'/applications','GET',undefined,'alpha');
    assert.equal(r.status,200);
    assert.equal(r.json.applications.length,2);
    assert.ok(r.json.applications.some(a=>a.note==='Would love to help'));
  });
  await t.test('owner alone can accept or decline applicants',async()=>{
    const path='/v1/projects/'+projectId+'/applications/';
    assert.equal((await request(path+'beta','PATCH',{status:'accepted'},'gamma')).status,409);
    assert.equal((await request(path+'beta','PATCH',{status:'accepted'},'alpha')).status,200);
    assert.equal((await request(path+'gamma','PATCH',{status:'declined'},'alpha')).status,200);
    assert.equal((await request(path+'beta','PATCH',{status:'accepted'},'alpha')).status,409);
    const publicDetails=await request('/v1/projects/'+projectId);
    assert.deepEqual(publicDetails.json.collaborators.map(a=>a.handle),['beta']);
    assert.equal((await request('/v1/projects')).json.projects[0].collaborators,1);
  });
  await t.test('accepted volunteer can withdraw and disappear from team',async()=>{
    assert.equal((await request('/v1/projects/'+projectId+'/applications/me','DELETE',undefined,'beta')).status,204);
    assert.equal((await request('/v1/projects/'+projectId)).json.collaborators.length,0);
  });
  await t.test('status transitions are enforced and creator-only',async()=>{
    const path='/v1/projects/'+projectId;
    assert.equal((await request(path,'PATCH',{status:'completed'},'alpha')).status,409);
    assert.equal((await request(path,'PATCH',{status:'in_progress'},'beta')).status,404);
    assert.equal((await request(path,'PATCH',{status:'in_progress'},'alpha')).status,200);
    assert.equal((await request(path+'/applications','POST',{note:'Too late'},'beta')).status,409);
    assert.equal((await request(path,'PATCH',{status:'completed'},'alpha')).status,200);
    assert.equal((await request(path,'PATCH',{status:'open'},'alpha')).status,409);
    assert.equal((await request('/v1/projects?status=completed')).json.projects.length,1);
    assert.equal((await request('/v1/projects?status=open')).json.projects.length,0);
  });
});
