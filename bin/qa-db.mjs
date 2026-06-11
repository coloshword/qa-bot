#!/usr/bin/env node
// Usage: node qa-db.mjs <ephemeral-name> "<SQL>"
// Queries the ephemeral's CloudBeaver GraphQL API and prints results as a markdown table.
// No Playwright needed — CloudBeaver allows anonymous access; we just need a session cookie.

const [ephemeral, sql] = process.argv.slice(2);
if (!ephemeral || !sql) {
  console.error('usage: qa-db.mjs <ephemeral-name> "<SQL>"');
  process.exit(1);
}

const BASE = `https://${ephemeral}.cloudbeaver.bookofthemoment.com`;
const GQL = `${BASE}/api/gql`;

let cookie = '';

async function gql(query, variables) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// Establish a session by hitting the root page first
const rootRes = await fetch(BASE, { redirect: 'follow' });
const setCookie = rootRes.headers.get('set-cookie');
if (setCookie) cookie = setCookie.split(';')[0];

// 1. List connections
const { userConnections } = await gql(`query { userConnections { id name connected } }`);
if (!userConnections?.length) throw new Error('No connections found in CloudBeaver — is the ephemeral up?');
const conn = userConnections.find((c) => c.name.toLowerCase().includes('mysql')) ?? userConnections[0];

// 2. Open connection
await gql(`mutation($id:ID!) { initConnection(id:$id) { id connected } }`, { id: conn.id });

// 3. Create SQL context (default catalog: xavier)
const { sqlContextCreate } = await gql(
  `mutation($c:ID!) { sqlContextCreate(connectionId:$c, defaultCatalog:"xavier") { id } }`,
  { c: conn.id },
);
const ctxId = sqlContextCreate.id;

// 4. Execute
const { asyncSqlExecuteQuery: task } = await gql(
  `mutation($c:ID!,$x:ID!,$s:String!) { asyncSqlExecuteQuery(connectionId:$c, contextId:$x, sql:$s) { id running } }`,
  { c: conn.id, x: ctxId, s: sql },
);

// 5. Poll until done
let done = false;
for (let i = 0; i < 60 && !done; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const { asyncTaskInfo: info } = await gql(
    `mutation($id:String!) { asyncTaskInfo(id:$id, removeOnFinish:false) { running status error { message } } }`,
    { id: task.id },
  );
  if (info.error?.message) throw new Error(`Query error: ${info.error.message}`);
  done = !info.running;
}
if (!done) throw new Error('Query timed out after 15s');

// 6. Fetch results
const { asyncSqlExecuteResults: result } = await gql(
  `mutation($t:ID!) { asyncSqlExecuteResults(taskId:$t) { results { resultSet { columns { name } rows } updateRowCount } } }`,
  { t: task.id },
);

const first = result.results[0];
if (!first) { console.log('(no result set)'); process.exit(0); }
if (!first.resultSet) { console.log(`${first.updateRowCount ?? 0} row(s) affected`); process.exit(0); }

const { columns, rows } = first.resultSet;
if (!rows.length) { console.log('(no rows)'); process.exit(0); }

// 7. Markdown table
const names = columns.map((c) => c.name);
const widths = names.map((n, i) => Math.max(n.length, ...rows.map((r) => String(r[i] ?? '').length)));
const line = (cells) => '| ' + cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join(' | ') + ' |';
console.log(line(names));
console.log('| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |');
for (const row of rows) console.log(line(row));
console.log(`\n(${rows.length} row${rows.length !== 1 ? 's' : ''})`);
