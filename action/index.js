// GitHub Action entry point. No dependencies: uses Node's built-in fetch and fs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('../checker.js');

const MARKER = '<!-- postgres-migration-checker -->';
const TOOL_URL = 'https://adnan909.github.io/postgres-migration-checker/';
const SKILL_URL = 'https://github.com/adnan909/free-sample';
const RANK = { danger: 0, warning: 1, info: 2 };

// ---------- inputs & environment ----------
function input(name, fallback = '') {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v.trim();
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// ---------- globs ----------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function parsePatterns(raw) {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((p) => p.replace(/^\.\//, ''));
}

function matches(file, patterns) {
  return patterns.some((p) => globToRegExp(p).test(file));
}

function walk(dir, root = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

// ---------- GitHub API ----------
async function gh(token, method, url, body) {
  const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'postgres-migration-checker',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`${method} ${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function prFiles(token, repo, number) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh(token, 'GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files.filter((f) => f.status !== 'removed').map((f) => f.filename);
}

// ---------- report ----------
function renderComment(results, opts) {
  const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, file: r.file })));
  const n = (s) => all.filter((f) => f.severity === s).length;
  const lines = [MARKER, '### Postgres migration safety check', ''];
  if (!results.length) {
    lines.push('No migration files changed in this pull request.');
  } else if (!all.length) {
    lines.push(`✅ No problems found in ${results.length} migration file${results.length === 1 ? '' : 's'}.`);
  } else {
    lines.push(`Checked ${results.length} migration file${results.length === 1 ? '' : 's'}: **${n('danger')} danger**, **${n('warning')} warning**, ${n('info')} note.`, '');
    lines.push('| | File | Line | Finding |', '| --- | --- | --- | --- |');
    const icon = { danger: '🔴', warning: '🟡', info: '🔵' };
    for (const f of all) lines.push(`| ${icon[f.severity]} | \`${f.file}\` | ${f.line} | ${f.title.replace(/\|/g, '\\|')} |`);
    lines.push('');
    for (const f of all.filter((x) => x.severity !== 'info')) {
      lines.push('<details>', `<summary>${icon[f.severity]} <code>${f.file}:${f.line}</code>: ${f.title.replace(/</g, '&lt;')}</summary>`, '');
      lines.push(f.why, '', 'Safer version:', '', '```sql', f.fix, '```', '</details>', '');
    }
  }
  lines.push('', `<sub>${opts.wrapped ? 'Assumes your migration tool wraps each file in a transaction' : 'Assumes migrations run outside a transaction'}. Rules target PostgreSQL 11+. Try it in the browser: [Postgres Migration Safety Checker](${TOOL_URL}) · Make Claude Code write safe migrations: [free skill](${SKILL_URL})</sub>`);
  return lines.join('\n');
}

async function findComment(token, repo, number) {
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(token, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const c = batch.find((x) => typeof x.body === 'string' && x.body.includes(MARKER));
    if (c) return c;
    if (batch.length < 100) return null;
  }
  return null;
}

// Findings: create or update our one comment. Clean run: only update an existing
// comment to "all clear", so clean pull requests get no extra noise.
async function syncComment(token, repo, number, body, hasFindings) {
  const existing = await findComment(token, repo, number);
  if (existing) {
    await gh(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
    return 'updated';
  }
  if (!hasFindings) return 'skipped (clean)';
  await gh(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
  return 'created';
}

// ---------- main ----------
async function run() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const patterns = parsePatterns(input('files', '**/*.sql'));
  const wrapped = input('wrapped-in-transaction', 'true').toLowerCase() !== 'false';
  const failOn = input('fail-on', 'danger').toLowerCase();
  const wantComment = input('comment', 'true').toLowerCase() !== 'false';
  const token = input('github-token');
  const repo = process.env.GITHUB_REPOSITORY;

  let event = {};
  try { event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch (e) { /* not in Actions */ }
  const pr = event.pull_request;

  let candidates;
  if (pr && token && repo) {
    try {
      candidates = (await prFiles(token, repo, pr.number)).filter((f) => matches(f, patterns));
      console.log(`Pull request #${pr.number}: ${candidates.length} changed migration file(s).`);
    } catch (e) {
      console.log(`::warning::Could not list pull request files (${e.message}); checking all matching files instead.`);
    }
  }
  if (!candidates) candidates = walk(workspace).filter((f) => matches(f, patterns));

  const results = [];
  for (const file of candidates) {
    const full = path.join(workspace, file);
    if (!fs.existsSync(full)) {
      console.log(`::warning::${file} is not in the workspace. Add actions/checkout before this step.`);
      continue;
    }
    const { findings } = analyze(fs.readFileSync(full, 'utf8'), { wrappedInTransaction: wrapped });
    results.push({ file, findings });
    for (const f of findings) {
      const level = f.severity === 'danger' ? 'error' : f.severity === 'warning' ? 'warning' : 'notice';
      console.log(`::${level} file=${escapeProp(file)},line=${f.line},title=${escapeProp(f.title)}::${escapeData(`${f.why}\n\nSafer version:\n${f.fix}`)}`);
    }
  }

  const all = results.flatMap((r) => r.findings);
  const count = (s) => all.filter((f) => f.severity === s).length;
  setOutput('dangers', count('danger'));
  setOutput('warnings', count('warning'));
  setOutput('files-checked', results.length);

  const report = renderComment(results, { wrapped });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.replace(MARKER, '') + '\n');

  if (wantComment && pr && token && repo) {
    try {
      console.log(`Pull request comment: ${await syncComment(token, repo, pr.number, report, all.length > 0)}.`);
    } catch (e) {
      const hint = e.status === 403 ? ' Give the job "permissions: pull-requests: write" (pull requests from forks get a read-only token).' : '';
      console.log(`::warning::Could not post the pull request comment (${e.message}).${hint}`);
    }
  }

  console.log(`Checked ${results.length} file(s): ${count('danger')} danger, ${count('warning')} warning, ${count('info')} note.`);
  const threshold = { danger: 0, warning: 1, never: -1 }[failOn] ?? 0;
  const failing = threshold < 0 ? 0 : all.filter((f) => RANK[f.severity] <= threshold).length;
  if (failing) {
    console.log(`::error::${failing} finding(s) at "${failOn}" level or worse. Fix them, or set fail-on to adjust.`);
    process.exitCode = 1;
  }
}

module.exports = { globToRegExp, parsePatterns, matches, renderComment, syncComment, run };

if (require.main === module) {
  run().catch((e) => {
    console.log(`::error::${escapeData(e.stack || e.message)}`);
    process.exitCode = 1;
  });
}
