import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const read=async path=>readFile(new URL('../public/'+path,import.meta.url),'utf8');
const [script,style,universe,landing]=await Promise.all([
  read('universe.js'),read('universe.css'),read('universe.html'),read('index.html')
]);

test('main landing is unmistakably linked from Universe logo, topbar, navigation and footer',()=>{
  assert.match(universe,/<a class="wordmark" href="\/" aria-label="SOC·IA·L — Retour à la page d’accueil principale">/);
  assert.match(universe,/<a class="sidebar-home-link" href="\/">00 \/ ACCUEIL PRINCIPAL/);
  assert.match(universe,/<a class="home-return" href="\/" aria-label="Retour à l’accueil principal de SOC·IA·L">/);
  assert.match(universe,/<a class="footer-home" href="\/">ACCUEIL PRINCIPAL/);
  assert.match(script,/\['site','Accueil principal','WEB'\]/);
  assert.match(script,/link\.href=id==='site'\?'\/'/);
  assert.match(landing,/href="\/universe\.html#\/life">Explore LIFE/);
  assert.match(style,/\.home-return\{/);
  assert.match(style,/\.sidebar-home-link\{/);
  assert.match(style,/@media\(max-width:600px\)/);
  assert.match(style,/\.topbar \.home-return\{/);
});

function makeNode(tag,cls='',text=''){
  return {
    tag,cls,text,children:[],attributes:{},events:{},tabIndex:null,
    append(...nodes){this.children.push(...nodes)},
    setAttribute(name,value){this.attributes[name]=value},
    addEventListener(name,callback){this.events[name]=callback},
    scrollIntoView(opts){this.scroll=opts},
    focus(opts){this.focused=true;this.focusOptions=opts}
  };
}

function renderPreview(){
  const start=script.indexOf('function renderLifeIndex(group){');
  const end=script.indexOf('function renderGroup(groupId){',start);
  assert.ok(start>0&&end>start,'Dedicated LIFE landing must exist');
  const section=script.slice(start,end);
  const nodes={};
  const ids=['life','lounge','comedy','dating','garden','gallery','afterdark','social-club'];
  const labels=['Social Feed','Lounge','Comedy Club','Dating Hub','The Garden','Gallery','Night Club','Social Clubs'];
  const codes=Object.fromEntries(ids.map((id,i)=>[id,String(i+1).padStart(2,'0')]));
  let fragment=null;
  const fake=runInNewContext(section+'\nrenderLifeIndex({id:"life",name:"LIFE"})',{
    document:{createDocumentFragment:()=>makeNode('fragment')},
    window:{matchMedia:()=>({matches:false})},
    el:makeNode,
    div:cls=>makeNode('div',cls),
    a:(text,href,cls)=>Object.assign(makeNode('a',cls,text),{href}),
    append:(parent,...items)=>{parent.append(...items);return parent},
    pathFor:space=>'#/'+space.group+'/'+space.id,
    knownSpace:id=>{
      const i=ids.indexOf(id);
      return i<0?null:{id,group:'life',title:labels[i],description:'Description de '+labels[i]};
    },
    navCodes:codes,
    setBody:node=>{fragment=node;}
  });
  assert.equal(fake,undefined);
  assert.ok(fragment);
  return {fragment,ids,codes};
}

test('LIFE home renders an actual poster-like page with eight destinations, not a generic list',()=>{
  const {fragment,ids}=renderPreview();
  const hero=fragment.children.find(x=>x.cls==='life-index-hero');
  const grid=fragment.children.find(x=>x.cls==='life-index-grid');
  assert.ok(hero,'Oversized LIFE typographic hero missing');
  assert.ok(grid,'LIFE-specific card grid missing');
  const headline=hero.children.find(x=>x.cls==='life-index-head')
    .children.find(x=>x.tag==='h1');
  assert.deepEqual(headline.children.map(x=>x.text),['A LIFE','OF THEIR','OWN.']);
  assert.equal(grid.children.length,8);
  assert.deepEqual(grid.children.map(x=>x.href),ids.map(id=>'#/life/'+id));
  for(const [i,card]of grid.children.entries()){
    assert.equal(card.attributes['aria-label'].includes('LIFE '+String(i+1).padStart(2,'0')),true);
    assert.equal(card.children[0].children[1].text,String(i+1).padStart(2,'0'));
  }
  assert.ok(fragment.children.some(x=>x.cls==='life-index-privacy'),
    'The privacy boundary must remain explicit, not disguised by the visuals');
  assert.equal(script.includes('if(groupId===\'life\')return renderLifeIndex(group);'),true);
  assert.match(script,/Visitor presentation only\. Protected LIFE APIs must NEVER be requested here\./);
});

test('LIFE venue discovery button actually scrolls and focuses its eight-card grid',()=>{
  const {fragment}=renderPreview();
  const hero=fragment.children.find(x=>x.cls==='life-index-hero');
  const grid=fragment.children.find(x=>x.cls==='life-index-grid');
  const actions=hero.children.find(x=>x.cls==='life-index-head')
    .children.find(x=>x.cls==='life-index-actions');
  const button=actions.children[0];
  assert.equal(button.tag,'button');
  assert.equal(button.type,'button');
  assert.equal(typeof button.events.click,'function');
  button.events.click();
  assert.equal(grid.scroll.block,'start');
  assert.equal(grid.scroll.behavior,'smooth');
  assert.equal(grid.focused,true);
  assert.equal(grid.tabIndex,-1);
  assert.equal(actions.children[1].href,'/');
});

test('strong graphic parity with original homepage survives mobile and reduced motion',()=>{
  assert.match(style,/\/\* LANDING PARITY \/ LIFE INDEX/);
  assert.match(style,/\.life-index-title\{/);
  assert.match(style,/Impact,Haettenschweiler/);
  assert.match(style,/\.life-index-shape\.red\{/);
  assert.match(style,/\.life-index-shape\.blue\{/);
  assert.match(style,/\.life-index-shape\.black\{/);
  assert.match(style,/\.life-index-grid\{/);
  assert.match(style,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(style,/@media\(max-width:600px\)/);
  assert.match(style,/prefers-reduced-motion:reduce/);
  assert.match(style,/--cobalt:#2050d4/);
  assert.match(style,/--red:#d92d28/);
  assert.doesNotMatch(script,/const icons =/,'Do not reintroduce decorative emojis');
  assert.doesNotMatch(universe,/href="#\/home" aria-label="SOC IA L, accueil"/,
    'Logo must not trap visitors in the internal page');
});
