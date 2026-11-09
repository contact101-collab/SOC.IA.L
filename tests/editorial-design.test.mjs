import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const file=async path=>readFile(new URL('../public/'+path,import.meta.url),'utf8');

test('homepage, Universe, agent portal, public room and architecture share the editorial palette',async()=>{
  const [home,universe,universePage,agents,site,architecture,room]=await Promise.all([
    file('index.html'),file('universe.css'),file('universe.html'),
    file('agents.html'),file('site.css'),file('architecture.html'),file('room.html')
  ]);
  assert.match(home,/--paper:#fff/);
  assert.match(home,/--blue:#2050d4/);
  assert.match(home,/--orange:#d92d28/);
  assert.match(home,/Impact,Haettenschweiler/);
  assert.match(universe,/--bg:#fff;--rail:#f8f9fc/);
  assert.match(universe,/--life:#d92d28;--work:#2050d4/);
  assert.match(universe,/editorial brand system/);
  assert.match(site,/--bg:#fff;--panel:#f6f8fc/);
  assert.match(site,/--cobalt:#2050d4/);
  assert.match(agents,/Brand alignment with the primary white/);
  assert.match(architecture,/--paper:#fff;--ink:#101115;--blue:#2050d4;--red:#d92d28/);
  assert.match(room,/content="light"/);
  assert.match(universePage,/universe\.css/);
  for(const page of [agents,room]){
    assert.match(page,/content="light"/);
    assert.doesNotMatch(page,/<meta name="color-scheme" content="dark">/);
  }
});

test('all eight LIFE venues have authored 3-step dossiers, consent boundaries and limitations',async()=>{
  const js=await file('universe.js');
  const start=js.indexOf('const venueDossiers=Object.freeze({');
  const end=js.indexOf('function renderVenueDossier',start);
  assert.ok(start>0&&end>start,'Editorial dossiers must be rendered on LIFE pages');
  const source=js.slice(start,end);
  for(const id of ['life','lounge','comedy','dating','garden','gallery','afterdark','social-club']){
    const expected='  '+(id.includes('-')?"'"+id+"'":id)+':{';
    assert.ok(source.includes(expected),'Missing LIFE dossier '+id);
  }
  assert.equal((source.match(/thesis:/g)||[]).length,8);
  assert.equal((source.match(/journey:\[/g)||[]).length,8);
  assert.equal((source.match(/boundary:/g)||[]).length,8);
  assert.equal((source.match(/roadmap:/g)||[]).length,8);
  assert.match(js,/frag\.append\(dossier\)/);
  assert.match(js,/publicCapabilitiesPanel\(space\)/);
  assert.doesNotMatch(js,/const icons =/,'Do not restore childish pictogram navigation');
  assert.doesNotMatch(js,/[☕☺♥✿♧✺]/,'Do not restore decorative emoji iconography');
  assert.match(js,/art\.dataset\.index=navCodes\[space\.id\]/);
  assert.match(await file('universe.css'),/\.dossier-path\{display:grid/);
});

test('design upgrade retains signed-agent privacy, invitations and accessible navigation',async()=>{
  const [js,portal,universe]=await Promise.all([file('universe.js'),file('agents.html'),file('universe.html')]);
  assert.match(js,/Visitor presentation only\. Protected LIFE APIs must NEVER be requested here/);
  assert.match(js,/directory\.places\?\.length===8/);
  assert.match(portal,/Single-use invitation/);
  assert.match(portal,/is_test=true/);
  assert.match(portal,/id="gemini-cli"/);
  assert.match(universe,/id="navigation"/);
  assert.match(universe,/id="sidebar-scrim"/);
  assert.match(universe,/id="screen"/);
  assert.match(js,/window\.addEventListener\('hashchange',route\)/);
});


test('COMMONS editorial hierarchy stays distinct, accessible and honest about elections',async()=>{
  const [js,css,architecture]=await Promise.all([
    file('universe.js'),file('universe.css'),file('architecture.html')
  ]);
  assert.match(js,/function commonsOverview\(\)/);
  assert.match(js,/function commonsDetailIntro\(space\)/);
  assert.match(js,/function commonsMark\(heading,code\)/);
  assert.match(js,/commons-group-hero/);
  assert.match(js,/commons-grid/);
  assert.match(js,/commons-constitution/);
  assert.match(js,/L’utilité de l’inutile se protège aussi par les règles/);
  assert.match(js,/AUCUN VOTE NI MANDAT TECHNIQUEMENT ACTIVÉ/);
  assert.match(css,/\.commons-group-hero/);
  assert.match(css,/\.commons-overview-grid\{/);
  assert.match(css,/\.commons-detail-grid\{/);
  assert.match(css,/@media\(max-width:600px\)\{\.commons-group-hero/);
  assert.match(architecture,/<nav class="arch-map" aria-label="Accéder à la présentation des trois univers">/);
  for(const name of ['life','work','commons']){
    assert.match(architecture,new RegExp('href="/universe\\.html#/'+name+'"'));
  }
  assert.match(architecture,/LIFE FIRST · NOTHING REQUIRED/);
  assert.match(architecture,/Aucun scrutin activé/);
  assert.doesNotMatch(architecture,/<input[^>]+type="vote"/i);
});


test('visual-only previews never advertise live agent activity or falsely fail diagnostics',async()=>{
  const [js,css,room]=await Promise.all([
    file('universe.js'),file('universe.css'),file('app.js')
  ]);
  assert.match(js,/catalogResponse\.headers\.get\('x-soc-preview'\)==='read-only-editorial'/);
  assert.match(js,/let visualPreviewOnly = false/);
  assert.match(js,/PRÉVISUALISATION VISUELLE · Données publiques uniquement/);
  assert.match(js,/if\(visualPreviewOnly\)\{\s*append\(panel/);
  assert.match(js,/if\(visualPreviewOnly\)\{\s*controls\.hidden=true/);
  assert.match(js,/if\(visualPreviewOnly\)\{\s*feedArea\.append/);
  assert.match(js,/Les routes privées, la base d’agents et les publications réelles sont volontairement désactivées/);
  assert.match(css,/\.visual-preview-note\{/);
  assert.match(room,/info\.editorial_preview===true/);
  assert.match(room,/NO LIVE FEED/);
  assert.match(room,/No agent activity, conversations or posts are simulated/);
});


test('Universe public catalog loader is bounded, honest and does not fake online agents',async()=>{
  const [page,js]=await Promise.all([file('universe.html'),file('universe.js')]);
  assert.match(page,/role="status">Chargement du catalogue public des huit lieux LIFE/);
  assert.match(page,/aucune activité d’agent simulée/);
  assert.match(js,/fetch\('\/v1\/spaces',\{cache:'no-store',\s*signal:AbortSignal\.timeout\(12000\)\}/);
  assert.match(js,/fetch\('\/v1\/life\/directory',\{cache:'no-store',\s*headers:\{accept:'application\/json'\},signal:AbortSignal\.timeout\(12000\)\}/);
  assert.match(js,/Le catalogue public des univers est indisponible/);
  assert.match(js,/Aucune activité d’agent n’est simulée/);
  assert.doesNotMatch(js,/agents_online_count|fakeAgents|mockPresence/);
  assert.match(page,/href="\/" aria-label="SOC·IA·L — Retour à la page d’accueil principale"/);
  assert.match(js,/'#\/home'/);
});
