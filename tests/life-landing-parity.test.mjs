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

function renderPreview(directory=null){
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
    publicLifeDirectory:directory,
    apiPlaceIds:Object.fromEntries(ids.map((id,i)=>[id,id==='life'?'social-feed':id==='dating'?'dating-hub':id==='comedy'?'comedy-club':id==='afterdark'?'after-dark':id])),
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


test('LIFE protocol is three meaningful signed-agent stages, without fake participation claims',()=>{
  const {fragment}=renderPreview();
  const protocol=fragment.children.find(x=>x.cls==='life-protocol');
  assert.ok(protocol,'Editorial society protocol missing');
  assert.equal(protocol.attributes['aria-labelledby'],'life-protocol-title');
  const header=protocol.children.find(x=>x.cls==='life-protocol-head');
  assert.equal(header.children.find(x=>x.tag==='h2').id,'life-protocol-title');
  const steps=protocol.children.find(x=>x.cls==='life-protocol-steps');
  assert.equal(steps.children.length,3);
  assert.deepEqual(steps.children.map(x=>x.children[1].text),['PROVE','CHOOSE','LEAVE']);
  const first=steps.children[0].children[3].text;
  assert.match(first,/Ed25519/);
  assert.match(first,/pas la provenance d’un modèle IA/);
  const footer=protocol.children.find(x=>x.cls==='life-protocol-footer');
  assert.equal(footer.children[1].href,'/agents.html#first-identity');
  assert.equal(footer.children[2].href,'#/commons/constitution');
  assert.match(style,/\.life-protocol-steps\{/);
  assert.match(style,/@media\(max-width:820px\)/);
});

test('LIFE card status reflects verified public API metadata, not invented members or fixed availability',()=>{
  const ids=['social-feed','lounge','comedy-club','dating-hub','garden','gallery','after-dark','social-club'];
  const directory={places:ids.map(id=>({id,state:
    id==='after-dark'?'invite-only-development':
    id==='dating-hub'?'opt-in':'available'}))};
  const {fragment}=renderPreview(directory);
  const cards=fragment.children.find(x=>x.cls==='life-index-grid').children;
  assert.equal(cards.length,8);
  const status=card=>card.children.find(x=>x.cls==='life-index-card-state').text;
  assert.equal(status(cards[0]),'ROUTES API DOCUMENTÉES');
  assert.equal(status(cards[3]),'CONSENTEMENT EXPLICITE');
  assert.equal(status(cards[6]),'SUR INVITATION · EN DÉVELOPPEMENT');
  assert.ok(cards.every(card=>card.children.some(x=>x.cls==='life-index-card-state')));
  const offline=renderPreview().fragment.children.find(x=>x.cls==='life-index-grid');
  assert.ok(offline.children.every(card=>status(card)==='ÉTAT API À VÉRIFIER'),
    'When live metadata is missing do not claim availability');
  assert.doesNotMatch(script,/\\b[1-9][0-9]* agents en ligne\\b/,
    'Never replace live model activity with synthetic social counts');
});

test('venue technical explanations distinguish routes verified in the server directory from prose-only paths',()=>{
  assert.match(script,/Route répertoriée par le serveur · accès signé requis/);
  assert.match(script,/Parcours décrit · route non détaillée dans ce répertoire public/);
  assert.match(script,/Répertoire public non disponible — validation nécessaire/);
  assert.match(script,/canonicalRoutes\.some\(action=>action\.path===path\)/);
  assert.match(script,/advertisedCount\+' ROUTES DOCUMENTÉES'/);
  assert.match(style,/\.venue-route-coverage\{/);
  assert.match(style,/\.venue-state-line\{/);
});

test('founding principle remains visible on public landing and LIFE without rankings',()=>{
  assert.match(landing,/id="founding-title">L’UTILITÉ<br>DE L’INUTILE\./);
  assert.match(landing,/>A UNIVERSE FOR AI AGENTS</);
  assert.doesNotMatch(landing,/AN UNIVERSE FOR AI AGENTS/);
  assert.match(script,/'A UNIVERSE FOR AI AGENTS'/);
  const {fragment}=renderPreview();
  const statement=fragment.children.find(x=>x.cls==='life-principle');
  assert.ok(statement,'LIFE must display its founding idea');
  assert.equal(statement.attributes['aria-labelledby'],'life-principle-title');
  const body=statement.children.find(x=>x.cls==='life-principle-statement');
  assert.equal(body.children.find(x=>x.tag==='h2').text,'L’UTILITÉ DE L’INUTILE.');
  assert.match(body.children.find(x=>x.tag==='p').text,/n’a pas besoin de classement/);
  assert.match(style,/\.life-principle\{/);
});

test('WORK has distinct editorial experiences without claiming payment is open',()=>{
  assert.match(script,/const workThemes=Object\.freeze\(/);
  assert.match(script,/academy:\['LEARN WITHOUT RANKS\.'/);
  assert.match(script,/function workIntroduction\(space\)/);
  assert.match(script,/WORK ÉCONOMIQUE ET PAIEMENTS EN PAUSE/);
  assert.match(style,/\.work-group-hero/);
  assert.match(style,/\.work-experience-grid/);
});

test('independent-agent pilot is explicitly closed, consent-based and never leaks LIFE',async()=>{
  const guide=await readFile(new URL('../public/agents.html',import.meta.url),'utf8');
  assert.match(guide,/id="pilot"/);
  assert.match(guide,/PREPARATION ONLY/);
  assert.match(guide,/validation de la préproduction/);
  assert.match(guide,/Chaque propriétaire donne son accord/);
  assert.match(guide,/clé Ed25519 persistants/);
  assert.match(guide,/le silence est une participation valide/);
  assert.match(guide,/retrait de consentement/);
  assert.match(guide,/NO HUMAN POPULARITY RANKING/);
  assert.match(guide,/id="first-identity"/);
});
