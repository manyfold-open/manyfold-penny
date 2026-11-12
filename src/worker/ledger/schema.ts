/**
 * Ledger tables. Appended to SCHEMA in db.ts and applied on every cold start, so every
 * statement must stay idempotent and free of semicolons inside its body.
 *
 * There is no migration step: a column added later cannot be added here. Put new data in
 * a new side table keyed by the existing row id instead.
 *
 * The ledger is append-only. An edit or a deletion is a new version of the entry, which
 * replaces the old one once someone in the group confirms it. Nothing is overwritten
 * except an entry's status.
 */
export const LEDGER_SCHEMA = `
-- One ledger per chat group. id is the chat platform's room id.
-- next_seq hands out the public entry numbers (#1, #2, ...) shared by expenses and settlements.
CREATE TABLE IF NOT EXISTS ledger_groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL,
  minor_unit    INTEGER NOT NULL,
  bot_name      TEXT NOT NULL DEFAULT 'Penny',
  default_split TEXT,
  simplify      INTEGER NOT NULL DEFAULT 1,
  next_seq      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- People in a group. member_id is the chat platform's stable user id, or guest:<n> for
-- someone outside the group whose share is settled by sponsor_id.
CREATE TABLE IF NOT EXISTS ledger_members (
  group_id     TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_guest     INTEGER NOT NULL DEFAULT 0,
  sponsor_id   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

-- One version of an expense. kind is expense, refund (money coming back) or void (a deletion).
-- status: pending (waiting for an OK), active, superseded (replaced by a newer version),
-- voided (a confirmed deletion), cancelled (a pending change nobody confirmed).
CREATE TABLE IF NOT EXISTS ledger_expenses (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  version      INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'other',
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  spent_on     TEXT NOT NULL,
  split        TEXT NOT NULL,
  receipt_ref  TEXT,
  replaces_id  TEXT,
  created_by   TEXT NOT NULL,
  confirmed_by TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  UNIQUE (group_id, seq, version)
);

CREATE INDEX IF NOT EXISTS idx_ledger_expenses_group ON ledger_expenses (group_id, status, seq);

CREATE TABLE IF NOT EXISTS ledger_payers (
  expense_id TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS ledger_shares (
  expense_id TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

-- A repayment from one member to another. pending until the receiver confirms it.
CREATE TABLE IF NOT EXISTS ledger_settlements (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  status       TEXT NOT NULL,
  from_member  TEXT NOT NULL,
  to_member    TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  confirmed_by TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  UNIQUE (group_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ledger_settlements_group ON ledger_settlements (group_id, status);

-- Habits the agent learned about one group, e.g. who skips alcohol. Capped per group.
CREATE TABLE IF NOT EXISTS ledger_memory (
  group_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, key)
);

-- How a person likes to be paid. Per person, not per group. Stored encrypted.
CREATE TABLE IF NOT EXISTS ledger_payment_info (
  member_id  TEXT PRIMARY KEY,
  info_ct    TEXT NOT NULL,
  info_iv    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_members_member ON ledger_members (member_id);
`;
