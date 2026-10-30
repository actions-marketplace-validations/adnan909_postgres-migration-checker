# Postgres Migration Safety Checker

**Try it: https://adnan909.github.io/postgres-migration-checker/**

Paste a PostgreSQL migration and see which statements will lock or rewrite a live table, fail on a table that has data, or break your app during a rolling deploy, with a safe rewrite for each one. Runs entirely in your browser.

## What it catches

- `CREATE INDEX` without `CONCURRENTLY` (blocks writes)
- `CONCURRENTLY` inside a transaction (the migration fails)
- `ADD COLUMN` with a volatile default like `gen_random_uuid()` (rewrites the table), or `NOT NULL` with no default (fails on non-empty tables)
- `ALTER COLUMN ... TYPE` (rewrite), `SET NOT NULL` (full scan under the strongest lock)
- `FOREIGN KEY` / `CHECK` without `NOT VALID`, `UNIQUE` / `PRIMARY KEY` without `USING INDEX`
- `RENAME` and `DROP` that break code still running during a deploy
- `VACUUM FULL`, `CLUSTER`, `REINDEX`, `REFRESH MATERIALIZED VIEW`, in-migration `UPDATE`/`DELETE` backfills
- Missing `lock_timeout`, and strong locks piling up inside one transaction

Every rule's behaviour (which lock it takes, whether it rewrites the table) was measured on PostgreSQL 16, and every suggested fix is run against a real database. Targets PostgreSQL 11+.

## Use it in your own tooling

`checker.js` has no dependencies:

```js
const { analyze } = require('./checker.js');
const { findings } = analyze(sql, { wrappedInTransaction: true });
for (const f of findings) console.log(f.severity, `line ${f.line}:`, f.title);
```

Run the tests with `node --test test.js`.

## Make Claude Code write safe migrations

The free [`postgres-safe-migrations` Claude Code skill](https://github.com/adnan909/free-sample) teaches Claude these same rules, so it writes migrations like this in the first place. The full [Backend Skills Pack](https://adnology0.gumroad.com/l/backend-skills-pack) covers the rest of a TypeScript + GraphQL + Postgres backend.

MIT licensed.
