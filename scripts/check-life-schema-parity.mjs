import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Disposable-CI guard: compare a fresh install with upgrading the last
// released main schema through the four reviewed additive LIFE migrations.
// Deliberately refuses to run unless TEST_DATABASE_URL is provided.
// Never point this at Neon or any environment holding user data.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL required: use disposable CI PostgreSQL only');
}
const database = new URL(process.env.TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(database.hostname)) {
  throw new Error('Schema parity test must run against disposable local PostgreSQL');
}
const client = new pg.Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
const schemas = ['life_parity_fresh','life_parity_upgrade'];
const migrations = [
  'migrations/20261031_garden_scenes.sql',
  'migrations/20261101_life_clubs.sql',
  'migrations/20261101_life_identity.sql',
  'migrations/20261101_life_unexpected.sql',
  'migrations/20261101_life_profile_display.sql',
  'migrations/20261101_life_creation_links.sql',
  'migrations/20261101_life_nightclub_private_rooms.sql',
  'migrations/20261101_life_comedy_improv.sql',
  'migrations/20261101_life_gallery_collections.sql'
];

async function create(schema, files) {
  await client.query('CREATE SCHEMA ' + schema);
  await client.query('SET search_path TO '+schema+',public');
  for(const file of files) await client.query(await readFile(file,'utf8'));
  await client.query('SET search_path TO public');
}

const columnsSQL=`
 SELECT t.relname AS table_name, a.attname AS column_name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS column_type,
        a.attnotnull AS not_null,
        a.attidentity AS identity,
        pg_get_expr(ad.adbin,ad.adrelid) AS default_expression
 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
 JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef ad ON ad.adrelid=t.oid AND ad.adnum=a.attnum
 WHERE n.nspname=$1 AND t.relkind IN ('r','p')
 ORDER BY t.relname,a.attnum`;
const indexesSQL=`
 SELECT tbl.relname AS table_name, idx.relname AS index_name,
        pg_get_indexdef(idx.oid) AS definition
 FROM pg_index i JOIN pg_class tbl ON tbl.oid=i.indrelid
 JOIN pg_class idx ON idx.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=tbl.relnamespace
 WHERE n.nspname=$1
 ORDER BY tbl.relname,idx.relname`;
const constraintsSQL=`
 SELECT tbl.relname AS table_name, co.conname AS constraint_name,
        co.contype AS kind,pg_get_constraintdef(co.oid) AS definition
 FROM pg_constraint co JOIN pg_class tbl ON tbl.oid=co.conrelid
 JOIN pg_namespace n ON n.oid=tbl.relnamespace
 WHERE n.nspname=$1
 ORDER BY tbl.relname,co.conname`;

function normalize(rows, schema) {
  return rows.map(row => {
    const result={};
    for(const [key,value] of Object.entries(row)) {
      if(typeof value === 'string') {
        // Identical schema-local sequences and FK references are named with
        // distinct temporary namespaces; remove only those known namespaces.
        result[key]=value.split('"'+schema+'".').join('')
          .split(schema+'.').join('');
      } else result[key]=value;
    }
    return result;
  });
}

function compare(label,fresh,upgrade) {
  const a=JSON.stringify(fresh),b=JSON.stringify(upgrade);
  if(a===b){console.log('PASS '+label+': '+fresh.length+' identical definitions');return;}
  const max=Math.max(fresh.length,upgrade.length);
  for(let i=0;i<max;i++) {
    if(JSON.stringify(fresh[i])!==JSON.stringify(upgrade[i])) {
      console.error('FRESH '+label+' ['+i+']: '+JSON.stringify(fresh[i]??null));
      console.error('UPGRADE '+label+' ['+i+']: '+JSON.stringify(upgrade[i]??null));
      break;
    }
  }
  throw new Error('Schema drift: '+label+' differs after applying all migrations');
}

await client.connect();
try {
  // Both schemas are private to this disposable CI database.
  await create(schemas[0],['schema.sql']);
  await create(schemas[1],['/tmp/soc-preupgrade-schema.sql',...migrations]);
  for(const [name,query]of [
    ['columns',columnsSQL],['indexes',indexesSQL],['constraints',constraintsSQL]
  ]) {
    const old=(await client.query(query,[schemas[0]])).rows;
    const upgraded=(await client.query(query,[schemas[1]])).rows;
    compare(name,normalize(old,schemas[0]),normalize(upgraded,schemas[1]));
  }
  console.log('PASS canonical schema matches migrated main schema in disposable PostgreSQL');
} finally {
  // No DROP SCHEMA: CI PostgreSQL container is disposed of after this job.
  // Keeping test objects until disposal permits post-mortem inspection.
  await client.end();
}
