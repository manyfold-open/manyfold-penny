/**
 * Just enough of D1's API on top of Node's built-in SQLite to run the Worker's queries in
 * tests: prepare/bind/first/all/run and batch (one transaction). D1 is SQLite underneath,
 * so the SQL itself runs unchanged.
 */
import { DatabaseSync } from 'node:sqlite';

type Value = string | number | null;

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    for (const v of values) {
      if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined cannot be bound');
    }
    return new FakeStatement(this.db, this.sql, values as Value[]);
  }

  /** Runs the statement and returns its rows (empty for writes) and how many rows it changed. */
  exec(): { rows: Record<string, unknown>[]; changes: number } {
    const statement = this.db.prepare(this.sql);
    const rows = statement.columns().length > 0 ? (statement.all(...this.params) as Record<string, unknown>[]) : [];
    if (statement.columns().length === 0) statement.run(...this.params);
    const changes = Number((this.db.prepare('SELECT changes() AS c').get() as { c: number }).c);
    return { rows: rows.map((r) => ({ ...r })), changes };
  }

  async first<T>(column?: string): Promise<T | null> {
    const [row] = this.exec().rows;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T>() {
    const { rows, changes } = this.exec();
    return { success: true, results: rows as T[], meta: { changes } };
  }

  async run() {
    const { changes } = this.exec();
    return { success: true, results: [], meta: { changes } };
  }
}

export class FakeD1 {
  readonly db = new DatabaseSync(':memory:');

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => {
        const { rows, changes } = s.exec();
        return { success: true, results: rows, meta: { changes } };
      });
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
