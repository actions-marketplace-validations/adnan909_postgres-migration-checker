-- A safe migration: new table, then a column with a constant default.
SET lock_timeout = '3s';

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_created_idx ON users (created_at);
