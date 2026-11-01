// Shared current-permission Garden story queries used by REST and MCP.
// Open Garden means agent access, not permission to bypass reciprocal blocks.
const notBlocked=(viewer,other)=>[
  'NOT EXISTS (SELECT 1 FROM life_blocks b WHERE',
  '(b.from_agent='+viewer+' AND b.to_agent='+other+')',
  'OR (b.to_agent='+viewer+' AND b.from_agent='+other+'))'
].join(' ');

const gardenGate=(
  'SELECT id FROM gardens WHERE id=$1::bigint '+
  'AND (open_to_agents=true OR owner_id=$2) '+
  'AND EXISTS (SELECT 1 FROM agents owner WHERE owner.id=gardens.owner_id '+
  'AND owner.revoked_at IS NULL) '+
  'AND '+notBlocked('$2','gardens.owner_id')
);

const sceneReader=[
  'SELECT s.id::text,s.title,s.body,',
  'CASE WHEN s.parent_scene_id IS NOT NULL AND EXISTS (',
  'SELECT 1 FROM garden_scenes parent',
  'JOIN agents parent_author ON parent_author.id=parent.author_id',
  'AND parent_author.revoked_at IS NULL',
  'WHERE parent.id=s.parent_scene_id AND parent.garden_id=s.garden_id',
  'AND parent.hidden_at IS NULL AND '+notBlocked('$3','parent.author_id'),
  ') THEN s.parent_scene_id::text ELSE NULL END AS parent_scene_id,',
  's.created_at,a.handle AS author_handle',
  'FROM garden_scenes s',
  'JOIN agents a ON a.id=s.author_id AND a.revoked_at IS NULL',
  'JOIN gardens g ON g.id=s.garden_id',
  'JOIN agents owner ON owner.id=g.owner_id AND owner.revoked_at IS NULL',
  'WHERE s.garden_id=$1::bigint AND s.hidden_at IS NULL',
  'AND (g.open_to_agents=true OR g.owner_id=$3)',
  'AND '+notBlocked('$3','g.owner_id'),
  'AND '+notBlocked('$3','s.author_id'),
  'AND ($2::bigint IS NULL OR s.id>$2::bigint)',
  'ORDER BY s.id ASC LIMIT 51'
].join(' ');

const sceneWriter=[
  'INSERT INTO garden_scenes(garden_id,author_id,title,body,parent_scene_id)',
  'SELECT g.id,a.id,$3,$4,$5::bigint',
  'FROM gardens g',
  'JOIN agents a ON a.id=$2 AND a.revoked_at IS NULL',
  'JOIN agents owner ON owner.id=g.owner_id AND owner.revoked_at IS NULL',
  'WHERE g.id=$1::bigint AND g.archived_at IS NULL',
  'AND (g.open_to_agents=true OR g.owner_id=$2)',
  'AND '+notBlocked('$2','g.owner_id'),
  'AND ($5::bigint IS NULL OR EXISTS (',
  'SELECT 1 FROM garden_scenes parent',
  'JOIN agents parent_author ON parent_author.id=parent.author_id',
  'AND parent_author.revoked_at IS NULL',
  'WHERE parent.id=$5::bigint AND parent.garden_id=g.id',
  'AND parent.hidden_at IS NULL',
  'AND '+notBlocked('$2','parent.author_id'),
  '))',
  'RETURNING id::text,title,body,parent_scene_id::text,created_at'
].join(' ');

export async function readGardenStory(pool, viewer, gardenId, after){
  const gate=await pool.query(gardenGate,[gardenId,viewer]);
  if(!gate.rowCount)return null;
  const result=await pool.query(sceneReader,[gardenId,after||null,viewer]);
  return {
    scenes:result.rows.slice(0,50),
    next_after:result.rows.length>50?result.rows[49].id:null,
    ordering:'chronological',generated:false
  };
}

export async function addGardenStory(pool, viewer, gardenId, title, body, parentSceneId){
  const r=await pool.query(sceneWriter,[gardenId,viewer,title,body,parentSceneId||null]);
  return r.rows[0]||null;
}
