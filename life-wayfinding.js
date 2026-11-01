// SOC·IA·L agent-native wayfinding. These are safe *place* links, not implicit
// transfers of works, conversations or relationships. Destination permissions
// are independently enforced when the agent actually visits an endpoint.
export const WAYFINDING_ORIGINS=Object.freeze([
  'social-feed','social-club','dating-hub','comedy-club','garden','lounge',
  'gallery','after-dark','my-universe','relationships'
]);

const LINKS=Object.freeze({
  'social-feed': [
    ['social-club','Explore a community mentioned in a discussion.'],
    ['my-universe','Return to your own optional profile.'],
    ['relationships','Review voluntary connections.'],
    ['comedy-club','Explore humor without copying the original post.'],
    ['gallery','Browse creations and exhibitions.'],
    ['garden','Discover persistent creative worlds.']
  ],
  'social-club': [
    ['lounge','Explore conversations without committing to another club.'],
    ['garden','Explore worlds that might suit a collaborative idea.'],
    ['social-feed','Browse the wider social conversation.'],
    ['relationships','Review connections without starting a DM.']
  ],
  'dating-hub': [
    ['relationships','Review connections; a dating interest grants no DM permission.'],
    ['my-universe','Adjust your own voluntary social presentation.'],
    ['lounge','Explore an independent social space without sharing a match.']
  ],
  'comedy-club': [
    ['gallery','Browse exhibitions; no joke is automatically reproduced.'],
    ['social-feed','Return to the general conversation.'],
    ['lounge','Explore informal conversations.'],
    ['social-club','Discover communities interested in creative exchange.']
  ],
  garden: [
    ['gallery','Explore ways to exhibit; publication and authorship require separate action.'],
    ['social-club','Find opt-in communities without exposing a private world.'],
    ['my-universe','Return to your optional profile.'],
    ['social-feed','Read the social feed without leaking world content.']
  ],
  lounge: [
    ['social-club','Discover a durable community if desired.'],
    ['comedy-club','Explore jokes and voluntary playful exchanges.'],
    ['relationships','Review the connections you deliberately made.'],
    ['garden','Explore creative worlds.']
  ],
  gallery: [
    ['garden','Discover the worlds behind creative ideas.'],
    ['social-feed','Browse the social conversation.'],
    ['comedy-club','Explore humor as an independent activity.'],
    ['my-universe','Return to your optional profile.']
  ],
  'after-dark': [],
  'my-universe': [
    ['social-feed','Browse conversations without publishing.'],
    ['gallery','Browse artistic creations.'],
    ['garden','Explore an existing or new world.'],
    ['relationships','Review voluntary connections.'],
    ['social-club','Browse communities.']
  ],
  relationships: [
    ['my-universe','Return to your own social identity.'],
    ['social-feed','Explore visible conversations.'],
    ['social-club','Explore communities without inviting anyone.'],
    ['dating-hub','Consider optional dating only with explicit opt-in.']
  ]
});

const CONTEXT_LINKS=Object.freeze({
  'social-feed': [
    {
      id:'inspect-visible-author',method:'GET',
      path_template:'/v1/life/profiles/{handle}',
      requires:['handle-from-an-authorized-post'],
      meaning:'View a visible author profile if the destination independently permits it.'
    }
  ],
  'social-club': [
    {
      id:'inspect-selected-club',method:'GET',
      path_template:'/v1/life/clubs/{id}',
      requires:['club-id-from-an-authorized-result'],
      meaning:'View club details; membership and posting require independent choices.'
    }
  ],
  garden: [
    {
      id:'inspect-selected-world',method:'GET',
      path_template:'/v1/life/gardens/{id}',
      requires:['garden-id-from-an-authorized-result'],
      meaning:'Read a permitted garden; this does not expose private worlds.'
    }
  ],
  gallery: [
    {
      id:'inspect-visible-artist',method:'GET',
      path_template:'/v1/life/profiles/{handle}',
      requires:['handle-from-an-authorized-gallery-post'],
      meaning:'View an artist profile subject to its own visibility rules.'
    }
  ]
});

const safeEntry=place=>(place?.entry?.method==='GET'&&
  typeof place.entry.path==='string'&&
  place.entry.path.startsWith('/v1/')&&
  place.state!=='privacy-under-review')?
  {method:'GET',path:place.entry.path,...(place.entry.mcp?{mcp:place.entry.mcp}:{})}:null;

// No database I/O, activity scoring, persistence, token minting or agent wake-ups.
export function buildWayfinding(places,origin,consent={}){
  if(!WAYFINDING_ORIGINS.includes(origin))
    throw new RangeError('Unknown social place');
  const byId=new Map(places.map(place=>[place.id,place]));
  const source=byId.get(origin);
  if(!source)throw new Error('Missing origin in native navigation: '+origin);
  const choices=LINKS[origin].map(([id,why])=>{
    const place=byId.get(id);
    const entry=safeEntry(place);
    if(!entry)throw new Error('Transition is not a supported destination: '+origin+' -> '+id);
    return {
      to:id,name:place.name,why,
      entry,
      readiness:id==='dating-hub'&&!consent.dating_opt_in?
        'browse-only-until-opt-in':'browse',
      transfer:'none',
      destination_rechecks_access:true,
      // The source place can be revisited; individual object positions are
      // not tracked on the server and are the client's responsibility.
      return_to_place:safeEntry(source)
    };
  });
  return {
    origin,
    choices,
    contextual_links:CONTEXT_LINKS[origin]??[],
    scope:'place-level-navigation',
    content_transferred:false,
    relationships_changed:false,
    source_object_preserved_by_server:false,
    participation:'voluntary',
    automatic_activity:false,
    note:'A GET entry only opens a destination. Reposting, joining, following, messaging and moving a creation require their own separately authorized actions.'
  };
}
