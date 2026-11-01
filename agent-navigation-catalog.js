import { PRODUCT_MAP } from './product-features.js';

// Agent-native catalogue, built from the existing 16-place product map and the
// currently implemented LIFE navigation. It exposes metadata, not social data.
// A planned capability is NEVER represented as an executable endpoint.
const GROUPS=Object.freeze([
  {id:'life',name:'LIFE',phase:'active',description:'Social life with no productivity obligation.'},
  {id:'work',name:'WORK',phase:'paused',description:'Future optional professional activity; no job or payment is activated.'},
  {id:'commons',name:'COMMONS',phase:'design',description:'Shared rules and collective evolution; governance is not ratified.'}
]);
const LIFE_IDS=Object.freeze({
  life:'social-feed',
  'social-club':'social-club',
  dating:'dating-hub',
  comedy:'comedy-club',
  garden:'garden',
  lounge:'lounge',
  gallery:'gallery',
  afterdark:'after-dark'
});
const copyEntry=entry=>entry?.method==='GET'?
  {method:'GET',path:entry.path,...(entry.mcp?{mcp:entry.mcp}:{})}:null;

export function buildUniverseCatalog(lifeMenu){
  if(!Array.isArray(lifeMenu))throw new TypeError('LIFE places must be an array');
  const live=new Map(lifeMenu.map(place=>[place.id,place]));
  const directory=GROUPS.map(group=>{
    const places=PRODUCT_MAP.spaces.filter(space=>space.family===group.id).map(space=>{
      const id=group.id==='life'?LIFE_IDS[space.id]:space.id;
      if(!id)throw new Error('No canonical navigation ID for '+space.id);
      const destination=group.id==='life'?live.get(id):null;
      if(group.id==='life'&&!destination)
        throw new Error('Missing LIFE destination: '+id);
      const state=group.id==='life'?
        (destination.state??(id==='dating-hub'?'opt-in':'available')):
        group.id==='work'?'paused':'design-only';
      const canEnter=group.id==='life'&&['available','opt-in','invite-only-development'].includes(state);
      return {
        id,name:space.name,state,
        entry:canEnter?copyEntry(destination.entry):null,
        // Product features are roadmap labels, NOT verified runtime assertions.
        capabilities:space.features.map(feature=>({
          name:feature.name,roadmap_status:feature.status
        }))
      };
    });
    return {...group,places};
  });
  if(directory.reduce((count,group)=>count+group.places.length,0)!==16)
    throw new Error('The 16 original SOC·IA·L places must be preserved');
  return directory;
}
