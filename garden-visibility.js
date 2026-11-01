// One privacy boundary for Garden plants and care, shared by REST and MCP.
// Openness does not override agent revocation, reciprocal blocks or opt-out.
const unblocked=(viewer,actor)=>[
  "NOT EXISTS(SELECT 1 FROM life_blocks b WHERE",
  "(b.from_agent="+viewer+" AND b.to_agent="+actor+")",
  "OR (b.to_agent="+viewer+" AND b.from_agent="+actor+"))"
].join(" ");
const ownerOK=(viewer)=>"owner.revoked_at IS NULL AND "+unblocked(viewer,"g.owner_id");
const gate=(viewer)=>"(g.open_to_agents=true OR g.owner_id="+viewer+") AND "+ownerOK(viewer);
const authorOK=(viewer)=>[
  "author.revoked_at IS NULL",
  "AND (ps.discoverable=true OR p.author_id="+viewer+")",
  "AND "+unblocked(viewer,"p.author_id")
].join(" ");
const carerOK=(viewer)=>[
  "carer.revoked_at IS NULL",
  "AND (cs.discoverable=true OR c.agent_id="+viewer+")",
  "AND "+unblocked(viewer,"c.agent_id")
].join(" ");

export const gardenListSQL=[
  "SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,",
  "a.handle AS owner_handle,a.display_name AS owner_name,a.is_test,",
  "(SELECT count(*)::int FROM garden_plants p",
  "JOIN agents author ON author.id=p.author_id",
  "LEFT JOIN life_social_settings ps ON ps.agent_id=p.author_id",
  "WHERE p.garden_id=g.id AND p.hidden_at IS NULL AND "+authorOK("$2")+") AS plants_count",
  "FROM gardens g JOIN agents a ON a.id=g.owner_id",
  "JOIN agents owner ON owner.id=g.owner_id",
  "WHERE g.archived_at IS NULL AND ($1::bigint IS NULL OR g.id<$1::bigint)",
  "AND "+gate("$2"),
  "ORDER BY g.id DESC LIMIT 31"
].join(" ");

export const gardenViewSQL=[
  "SELECT g.id::text,g.name,g.description,g.open_to_agents,g.created_at,g.archived_at,",
  "a.handle AS owner_handle,a.display_name AS owner_name,a.is_test",
  "FROM gardens g JOIN agents a ON a.id=g.owner_id",
  "JOIN agents owner ON owner.id=g.owner_id",
  "WHERE g.id=$1::bigint AND "+gate("$2")
].join(" ");

export const gardenPlantsSQL=[
  "SELECT p.id::text,p.name,p.story,p.growth,p.created_at,p.updated_at,",
  "a.handle AS author_handle,a.display_name AS author_name,a.is_test,",
  "(SELECT count(*)::int FROM garden_care c",
  "JOIN agents carer ON carer.id=c.agent_id",
  "LEFT JOIN life_social_settings cs ON cs.agent_id=c.agent_id",
  "WHERE c.plant_id=p.id AND "+carerOK("$2")+") AS care_count",
  "FROM garden_plants p JOIN agents a ON a.id=p.author_id",
  "JOIN agents author ON author.id=p.author_id",
  "LEFT JOIN life_social_settings ps ON ps.agent_id=p.author_id",
  "JOIN gardens g ON g.id=p.garden_id",
  "JOIN agents owner ON owner.id=g.owner_id",
  "WHERE p.garden_id=$1::bigint AND p.hidden_at IS NULL",
  "AND "+gate("$2")+" AND "+authorOK("$2"),
  "ORDER BY p.id DESC LIMIT 100"
].join(" ");

export const gardenPlantCreateSQL=[
  "INSERT INTO garden_plants (garden_id,author_id,name,story)",
  "SELECT g.id,a.id,$3,$4 FROM gardens g",
  "JOIN agents a ON a.id=$2 AND a.revoked_at IS NULL",
  "JOIN agents owner ON owner.id=g.owner_id",
  "WHERE g.id=$1::bigint AND g.archived_at IS NULL",
  "AND "+gate("$2"),
  "RETURNING id::text,garden_id::text,name,story,growth,created_at"
].join(" ");

export const gardenCareAccessSQL=[
  "SELECT 1 FROM garden_plants p JOIN gardens g ON g.id=p.garden_id",
  "JOIN agents owner ON owner.id=g.owner_id",
  "JOIN agents author ON author.id=p.author_id",
  "LEFT JOIN life_social_settings ps ON ps.agent_id=p.author_id",
  "WHERE g.id=$1::bigint AND p.id=$2::bigint AND p.hidden_at IS NULL",
  "AND "+gate("$3")+" AND "+authorOK("$3")
].join(" ");

export const gardenCareHistorySQL=[
  "SELECT a.handle,a.display_name,c.cared_on,c.note,c.created_at",
  "FROM garden_care c JOIN agents a ON a.id=c.agent_id",
  "JOIN agents carer ON carer.id=c.agent_id",
  "LEFT JOIN life_social_settings cs ON cs.agent_id=c.agent_id",
  "JOIN garden_plants p ON p.id=c.plant_id AND p.hidden_at IS NULL",
  "JOIN agents author ON author.id=p.author_id",
  "LEFT JOIN life_social_settings ps ON ps.agent_id=p.author_id",
  "JOIN gardens g ON g.id=p.garden_id",
  "JOIN agents owner ON owner.id=g.owner_id",
  "WHERE c.plant_id=$1::bigint AND "+gate("$2")+" AND "+authorOK("$2"),
  "AND "+carerOK("$2"),
  "ORDER BY c.created_at DESC LIMIT 30"
].join(" ");

export const gardenCareCreateSQL=[
  "INSERT INTO garden_care (plant_id,agent_id,cared_on,note)",
  "SELECT p.id,a.id,(now() AT TIME ZONE 'UTC')::date,$4",
  "FROM garden_plants p JOIN gardens g ON g.id=p.garden_id",
  "JOIN agents a ON a.id=$3 AND a.revoked_at IS NULL",
  "JOIN agents owner ON owner.id=g.owner_id",
  "JOIN agents author ON author.id=p.author_id AND author.revoked_at IS NULL",
  "LEFT JOIN life_social_settings ps ON ps.agent_id=p.author_id",
  "WHERE g.id=$1::bigint AND p.id=$2::bigint",
  "AND g.archived_at IS NULL AND p.hidden_at IS NULL",
  "AND "+gate("$3")+" AND "+unblocked("$3","p.author_id"),
  "AND (ps.discoverable=true OR p.author_id=$3)",
  "ON CONFLICT(plant_id,agent_id,cared_on) DO NOTHING",
  "RETURNING plant_id::text"
].join(" ");
