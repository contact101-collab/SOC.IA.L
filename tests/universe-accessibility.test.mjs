import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../public/universe.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/universe.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/universe.css',import.meta.url),'utf8');

function classes(){
  const values=new Set();
  return {
    contains:c=>values.has(c),
    add:c=>values.add(c),
    remove:c=>values.delete(c),
    toggle:(c,force)=>{const set=force===undefined?!values.has(c):Boolean(force);
      if(set)values.add(c);else values.delete(c);return set;}
  };
}
function fakeNode(document){
  const attrs=new Map();
  return {
    classList:classes(),inert:false,
    setAttribute:(k,v)=>attrs.set(k,String(v)),
    removeAttribute:k=>attrs.delete(k),
    getAttribute:k=>attrs.get(k)??null,
    focus(){document.activeElement=this;},
    querySelector:()=>null,
    querySelectorAll:()=>[],
    contains:()=>false
  };
}
function drawerFixture(){
  const document={body:{classList:classes()},activeElement:null};
  const ids=['screen','navigation','crumb','sidebar','mobile-menu',
    'sidebar-scrim','sidebar-close','skip-to-content'];
  const nodes=Object.fromEntries(ids.map(id=>[id,fakeNode(document)]));
  const frame=fakeNode(document);
  const logo=fakeNode(document);
  nodes.sidebar.querySelector=()=>logo;
  nodes.sidebar.querySelectorAll=()=>[nodes['sidebar-close'],logo];
  nodes.sidebar.contains=node=>node===logo||node===nodes['sidebar-close'];
  document.getElementById=id=>nodes[id]||null;
  document.querySelector=selector=>selector==='.main-frame'?frame:null;
  const viewport={matches:true,handlers:[],
    addEventListener(type,fn){if(type==='change')this.handlers.push(fn);}};
  const window={matchMedia:()=>viewport};
  const code=source.slice(0,source.indexOf('let catalog = null;'));
  assert.ok(code.includes('syncNavigationAccessibility()'),'Missing drawer lifecycle');
  const exposed=runInNewContext(code+'\n({setMenuOpen,trapMobileNavigation,syncNavigationAccessibility})',
    {document,window});
  return {document,nodes,frame,viewport,...exposed};
}

test('mobile sidebar starts inert and inaccessible while closed',()=>{
  const d=drawerFixture();
  assert.equal(d.nodes.sidebar.inert,true);
  assert.equal(d.nodes.sidebar.getAttribute('aria-hidden'),'true');
  assert.equal(d.nodes['mobile-menu'].getAttribute('aria-expanded'),'false');
  assert.equal(d.frame.inert,false);
});

test('opening traps focus within sidebar, Escape/close restore normal page access',()=>{
  const d=drawerFixture();
  d.setMenuOpen(true);
  assert.equal(d.nodes.sidebar.inert,false);
  assert.equal(d.frame.inert,true,'Off-canvas backdrop must be inaccessible');
  assert.equal(d.nodes.sidebar.getAttribute('aria-hidden'),null);
  assert.equal(d.nodes['mobile-menu'].getAttribute('aria-expanded'),'true');
  assert.equal(d.document.activeElement,d.nodes['sidebar-close']);
  let stopped=0;
  const key=(shiftKey)=>({key:'Tab',shiftKey,preventDefault:()=>stopped++});
  d.trapMobileNavigation(key(true));
  assert.equal(stopped,1);
  assert.equal(d.document.activeElement,d.nodes.sidebar.querySelector('a.wordmark'));
  d.trapMobileNavigation(key(false));
  assert.equal(stopped,2);
  assert.equal(d.document.activeElement,d.nodes['sidebar-close']);
  d.setMenuOpen(false,true);
  assert.equal(d.frame.inert,false);
  assert.equal(d.nodes.sidebar.inert,true);
  assert.equal(d.document.activeElement,d.nodes['mobile-menu']);
});

test('desktop sidebar stays keyboard accessible even if mobile was open on resize',()=>{
  const d=drawerFixture();
  d.setMenuOpen(true);
  d.viewport.matches=false;
  for(const fn of d.viewport.handlers)fn();
  assert.equal(d.frame.inert,false);
  assert.equal(d.nodes.sidebar.inert,false);
  assert.equal(d.nodes.sidebar.getAttribute('aria-hidden'),null);
  assert.equal(d.nodes.sidebar.classList.contains('open'),false);
  assert.equal(d.document.activeElement,d.nodes.sidebar.querySelector('a.wordmark'));
});

test('hash router keeps universe category boundaries and declines invalid locations',()=>{
  const start=source.indexOf('function getRoute(){');
  const stop=source.indexOf('const socialClubPreview',start);
  assert.ok(start>=0&&stop>start);
  const fn=source.slice(start,stop);
  const parse=hash=>JSON.parse(JSON.stringify(runInNewContext(fn+'\ngetRoute()',{
    location:{hash}
  })));
  assert.deepEqual(parse('#/life/garden'),{id:'garden',group:'life',isGroupRoute:false,invalid:false});
  assert.deepEqual(parse('#/work/factory'),{id:'factory',group:'work',isGroupRoute:false,invalid:false});
  assert.deepEqual(parse('#/life'),{id:'life',group:'life',isGroupRoute:true,invalid:false});
  assert.equal(parse('#/life/garden/secret').invalid,true);
  assert.equal(parse('#/life/%2e%2e').invalid,true);
  assert.equal(parse('#/made-up').invalid,false,'Unknown top-level groups are rejected by route()');
  assert.match(source,/if\(space&&space\.group===group\)renderSpace\(space\)/,
    'Never render a LIFE destination under WORK or COMMONS');
  assert.match(source,/else renderNotFound\(\)/);
  assert.match(source,/Aucun accès privé n’a été tenté/);
});

test('every LIFE venue has functional four-chapter navigation with focus and reduced-motion',()=>{
  const start=source.indexOf('function venueSectionNavigation(space,parts){');
  const stop=source.indexOf('function renderLifeVenue(space)',start);
  assert.ok(start>=0&&stop>start);
  const nodes=[];
  const el=(tag,cls,text)=>({
    tag,cls,text,children:[],events:{},attrs:{},
    append(child){this.children.push(child)},
    setAttribute(k,v){this.attrs[k]=v},
    addEventListener(k,fn){this.events[k]=fn}
  });
  let reduction=false;
  const helper=runInNewContext(source.slice(start,stop)+'\nvenueSectionNavigation',
    {el,window:{matchMedia:()=>({matches:reduction})}});
  const sections=['actions','philosophy','api','privacy'].map(id=>({
    id,scrolls:[],focused:false,
    scrollIntoView(x){this.scrolls.push(x)},
    focus(){this.focused=true}
  }));
  const nav=helper({title:'The Garden'},sections.map((s,i)=>[
    String(i+1).padStart(2,'0'),['ACTIONS','PHILOSOPHIE','API','CONFIDENTIALITÉ'][i],s]));
  assert.equal(nav.tag,'nav');
  assert.equal(nav.attrs['aria-label'],'Sommaire de The Garden');
  assert.equal(nav.children.length,5);
  for(let i=0;i<4;i++)assert.equal(nav.children[i+1].attrs['aria-controls'],sections[i].id);
  nav.children[2].events.click();
  assert.equal(sections[1].focused,true);
  assert.equal(sections[1].scrolls[0].behavior,'smooth');
  reduction=true;
  nav.children[3].events.click();
  assert.equal(sections[2].scrolls[0].behavior,'auto');
  for(const id of ['venue-actions','venue-philosophy','venue-api','venue-privacy'])
    assert.ok(source.includes("'"+id+"'"),'Missing target '+id);
  assert.match(css,/\.venue-section-nav\{/);
  assert.match(css,/@media\(max-width:390px\)/);
  assert.match(html,/id="sidebar-close"/);
  assert.match(html,/id="skip-to-content"/);
  assert.match(html,/<nav id="navigation"/);
});


test('mobile nav closes for every selected link, including the current route',()=>{
  const start=source.indexOf("  navHost.addEventListener('click',event=>{");
  const stop=source.indexOf("\n  });",start);
  assert.ok(start>=0&&stop>start,'Delegated link handler required');
  const delegate=source.slice(start,stop+6);
  const events={};let opened=true,focusCount=0;
  const sandbox={
    navHost:{addEventListener:(event,fn)=>{events[event]=fn;}},
    sidebar:{classList:{contains:name=>name==='open'&&opened}},
    setMenuOpen:open=>{opened=Boolean(open);},
    screen:{focus:()=>{focusCount++;}},
    location:{hash:'#/life/garden'}
  };
  runInNewContext(delegate,sandbox);
  const item=href=>({getAttribute:name=>name==='href'?href:null});
  const clicked=anchor=>({target:{closest:selector=>selector==='a'?anchor:null}});
  assert.equal(typeof events.click,'function');
  events.click(clicked(item('#/life/comedy')));
  assert.equal(opened,false,'A different destination must close the mobile drawer');
  assert.equal(focusCount,0);
  opened=true;
  events.click(clicked(item('#/life/garden')));
  assert.equal(opened,false,'Selecting the current destination must still dismiss the drawer');
  assert.equal(focusCount,1,'Current-route link restores content keyboard focus');
  opened=true;
  events.click(clicked(null));
  assert.equal(opened,true,'Clicking a non-link must not close the drawer');
});
