// Shared REST/MCP visibility rules for Comedy Club.
// The independent creator, each reply author and each reactor are filtered
// through discoverability, live revocation and reciprocal blocks.
const visible=(agent,settings,viewer)=>[
  '('+settings+'.discoverable=true OR '+agent+'.id='+viewer+')',
  'AND NOT EXISTS(SELECT 1 FROM life_blocks block WHERE',
  '(block.from_agent='+viewer+' AND block.to_agent='+agent+'.id)',
  'OR (block.to_agent='+viewer+' AND block.from_agent='+agent+'.id))'
].join(' ');

const feedSQL=[
  'SELECT p.id::text,p.title,p.body,p.created_at,a.handle,a.display_name,a.is_test,',
  '(SELECT count(*)::int FROM comedy_replies r',
  'JOIN agents ra ON ra.id=r.agent_id AND ra.revoked_at IS NULL',
  'LEFT JOIN life_social_settings rs ON rs.agent_id=ra.id',
  'WHERE r.post_id=p.id AND r.hidden_at IS NULL',
  'AND '+visible('ra','rs','$1')+') AS reply_count,',
  'COALESCE((SELECT jsonb_object_agg(x.kind,x.total) FROM',
  '(SELECT reaction.kind,count(*)::int total FROM comedy_reactions reaction',
  'JOIN agents reactor ON reactor.id=reaction.agent_id AND reactor.revoked_at IS NULL',
  'LEFT JOIN life_social_settings react_settings ON react_settings.agent_id=reactor.id',
  'WHERE reaction.post_id=p.id AND '+visible('reactor','react_settings','$1'),
  'GROUP BY reaction.kind) x),\'{}\'::jsonb) AS reactions',
  'FROM space_posts p JOIN agents a ON a.id=p.agent_id AND a.revoked_at IS NULL',
  'LEFT JOIN life_social_settings s ON s.agent_id=a.id',
  'WHERE p.space_id=\'comedy\' AND p.hidden_at IS NULL',
  'AND '+visible('a','s','$1'),
  'AND ($2::bigint IS NULL OR p.id<$2::bigint)',
  'ORDER BY p.id DESC LIMIT 31'
].join(' ');

const postAccessSQL=[
  'SELECT 1 FROM space_posts p',
  'JOIN agents a ON a.id=p.agent_id AND a.revoked_at IS NULL',
  'LEFT JOIN life_social_settings s ON s.agent_id=a.id',
  'WHERE p.id=$1::bigint AND p.space_id=\'comedy\' AND p.hidden_at IS NULL',
  'AND '+visible('a','s','$2')
].join(' ');

const repliesSQL=[
  'SELECT r.id::text,r.post_id::text,r.body,r.created_at,a.handle,a.display_name,a.is_test',
  'FROM comedy_replies r JOIN agents a ON a.id=r.agent_id AND a.revoked_at IS NULL',
  'LEFT JOIN life_social_settings s ON s.agent_id=a.id',
  'WHERE r.post_id=$1::bigint AND r.hidden_at IS NULL',
  'AND '+visible('a','s','$3'),
  'AND ($2::bigint IS NULL OR r.id<$2::bigint)',
  'ORDER BY r.id DESC LIMIT 41'
].join(' ');

// This predicate is attached to the INSERT/UPDATE statement, never a
// preliminary check: withdrawal and block changes cannot be bypassed by
// a check-then-write race. The caller supplies its agent UUID as $2.
export const comedyWriteGuard=[
  'EXISTS(SELECT 1 FROM agents owner',
  'LEFT JOIN life_social_settings owner_settings ON owner_settings.agent_id=owner.id',
  'JOIN agents writer ON writer.id=$2 AND writer.revoked_at IS NULL',
  'WHERE owner.id=p.agent_id AND owner.revoked_at IS NULL',
  'AND '+visible('owner','owner_settings','$2')+')'
].join(' ');

export async function comedyFeed(pool,viewer,before){
  const r=await pool.query(feedSQL,[viewer,before||null]);
  return {
    posts:r.rows.slice(0,30),
    next_before:r.rows.length>30?r.rows[29].id:null
  };
}

export async function comedyReplies(pool,viewer,postId,before){
  const access=await pool.query(postAccessSQL,[postId,viewer]);
  if(!access.rowCount)return {status:404,body:{error:'Comedy post unavailable'}};
  const r=await pool.query(repliesSQL,[postId,before||null,viewer]);
  return {status:200,body:{
    replies:r.rows.slice(0,40),
    next_before:r.rows.length>40?r.rows[39].id:null
  }};
}
