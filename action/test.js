const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { globToRegExp, parsePatterns, matches, renderComment, run } = require('./index.js');

const RISKY = "ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid();\nCREATE INDEX i ON users (email);\n";
const SAFE = "SET lock_timeout = '3s';\nALTER TABLE users ADD COLUMN age int;\n";

test('globs', () => {
  assert.ok(globToRegExp('**/*.sql').test('db/migrations/001.sql'));
  assert.ok(globToRegExp('**/*.sql').test('001.sql'));
  assert.ok(!globToRegExp('**/*.sql').test('db/schema.rb'));
  assert.ok(globToRegExp('prisma/migrations/*/migration.sql').test('prisma/migrations/20261101_init/migration.sql'));
  assert.ok(!globToRegExp('migrations/*.sql').test('migrations/old/1.sql'));
  assert.deepEqual(parsePatterns('a/*.sql, ./b/**/*.sql\n c.sql'), ['a/*.sql', 'b/**/*.sql', 'c.sql']);
  assert.ok(matches('supabase/migrations/1_init.sql', parsePatterns('supabase/migrations/*.sql')));
});

test('comment rendering', () => {
  const clean = renderComment([{ file: 'a.sql', findings: [] }], { wrapped: true });
  assert.match(clean, /No problems found in 1 migration file/);
  const body = renderComment([{ file: 'm/1.sql', findings: [{ severity: 'danger', line: 3, title: 'Index build blocks all writes to "users"', why: 'why', fix: 'CREATE INDEX CONCURRENTLY ...' }] }], { wrapped: true });
  assert.match(body, /<!-- postgres-migration-checker -->/);
  assert.match(body, /\*\*1 danger\*\*/);
  assert.match(body, /`m\/1.sql` \| 3 \|/);
  assert.match(body, /```sql\nCREATE INDEX CONCURRENTLY/);
});

let ws, out, summary, logs;
function setup(files, extraEnv = {}) {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), c);
  }
  out = path.join(ws, 'out.txt'); summary = path.join(ws, 'summary.md');
  for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_') || k.startsWith('GITHUB_')) delete process.env[k];
  Object.assign(process.env, { GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, extraEnv);
  logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  process.exitCode = 0;
}
const realLog = console.log;
const finish = () => { console.log = realLog; const code = process.exitCode; process.exitCode = 0; return code; };

test('push mode scans the workspace, annotates and fails on danger', async () => {
  setup({ 'db/migrations/001.sql': RISKY, 'db/migrations/002.sql': SAFE, 'README.md': 'x' });
  await run();
  const code = finish();
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.startsWith('::error file=db/migrations/001.sql,line=1,title=DEFAULT gen_random_uuid() rewrites the whole table::')));
  assert.ok(logs.some((l) => l.startsWith('::error file=db/migrations/001.sql,line=2,title=Index build blocks all writes to "users"::')));
  assert.match(fs.readFileSync(out, 'utf8'), /dangers=2\nwarnings=\d+\nfiles-checked=2/);
  assert.match(fs.readFileSync(summary, 'utf8'), /### Postgres migration safety check/);
});

test('fail-on never and warning thresholds', async () => {
  setup({ 'm.sql': RISKY }, { 'INPUT_FAIL-ON': 'never' });
  await run();
  assert.equal(finish(), 0);
  setup({ 'm.sql': "SET lock_timeout='3s';\nALTER TABLE users ALTER COLUMN email SET NOT NULL;" }, { 'INPUT_FAIL-ON': 'danger' });
  await run();
  assert.equal(finish(), 0);
  setup({ 'm.sql': "SET lock_timeout='3s';\nALTER TABLE users ALTER COLUMN email SET NOT NULL;" }, { 'INPUT_FAIL-ON': 'warning' });
  await run();
  assert.equal(finish(), 1);
});

test('pull request mode checks only changed files and posts one comment', async () => {
  const event = path.join(os.tmpdir(), `evt-${Date.now()}.json`);
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
  setup({ 'db/1.sql': RISKY, 'db/2.sql': RISKY }, {
    'INPUT_GITHUB-TOKEN': 't', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event, 'INPUT_FAIL-ON': 'never',
  });
  const calls = [];
  const comments = [];
  global.fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
    const json = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
    if (url.includes('/pulls/7/files')) return json([{ filename: 'db/1.sql', status: 'modified' }, { filename: 'gone.sql', status: 'removed' }, { filename: 'app.ts', status: 'added' }]);
    if (init.method === 'GET' && url.includes('/issues/7/comments')) return json(comments);
    if (init.method === 'POST') { comments.push({ id: 99, body: JSON.parse(init.body).body }); return json({ id: 99 }, 201); }
    if (init.method === 'PATCH') { comments[0].body = JSON.parse(init.body).body; return json({ id: 99 }); }
    return json({}, 404);
  };
  await run();
  finish();
  assert.ok(logs.some((l) => /1 changed migration file/.test(l)));
  assert.ok(logs.every((l) => !l.includes('db/2.sql')), 'unchanged file must not be checked');
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /2 danger/);

  // second push: same PR, fixed migration -> the same comment is updated to all clear, not duplicated
  fs.writeFileSync(path.join(ws, 'db/1.sql'), SAFE);
  logs = []; console.log = (...a) => logs.push(a.join(' '));
  await run();
  finish();
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /No problems found/);
  assert.ok(calls.some((c) => c.startsWith('PATCH /repos/o/r/issues/comments/99')));
});

test('clean pull request with no earlier comment stays quiet', async () => {
  const event = path.join(os.tmpdir(), `evt2-${Date.now()}.json`);
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 8 } }));
  setup({ 'db/1.sql': SAFE }, { 'INPUT_GITHUB-TOKEN': 't', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event });
  let posted = false;
  global.fetch = async (url, init) => {
    if (init.method === 'POST') posted = true;
    const body = url.includes('/files') ? [{ filename: 'db/1.sql', status: 'added' }] : [];
    return { ok: true, status: 200, json: async () => body };
  };
  await run();
  assert.equal(finish(), 0);
  assert.equal(posted, false);
});

test('a 403 on commenting warns but does not crash', async () => {
  const event = path.join(os.tmpdir(), `evt3-${Date.now()}.json`);
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 9 } }));
  setup({ 'db/1.sql': RISKY }, { 'INPUT_GITHUB-TOKEN': 't', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event, 'INPUT_FAIL-ON': 'never' });
  global.fetch = async (url, init) => {
    if (url.includes('/files')) return { ok: true, status: 200, json: async () => [{ filename: 'db/1.sql', status: 'added' }] };
    return { ok: false, status: 403, json: async () => ({}) };
  };
  await run();
  assert.equal(finish(), 0);
  assert.ok(logs.some((l) => /::warning::Could not post the pull request comment .*pull-requests: write/.test(l)));
});
