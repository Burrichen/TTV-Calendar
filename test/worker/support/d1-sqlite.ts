/**
 * A real D1 database, backed by Node's built-in SQLite.
 *
 * The alternative — a hand-written fake that returns canned objects — would test
 * nothing that matters here. The entire duplicate-prevention design rests on SQL
 * semantics: a conditional `ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING` that
 * yields a row only when the claim is genuinely ours. A fake would have to reimplement
 * that, and would then be testing the reimplementation.
 *
 * So these tests run the **actual migration** and the **actual statements** against
 * real SQLite, which is what D1 is. `node:sqlite` is built into Node 24, so this needs
 * no dependency and no Docker.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;

/**
 * Every migration, in order, read from the directory rather than listed.
 *
 * A new migration is then covered by the whole suite the moment it is added — the
 * alternative is a list that silently goes stale and tests a schema nobody runs.
 */
const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => join(MIGRATIONS_DIR, name));

/**
 * Bound values must be SQLite primitives. Booleans in particular are not, and arrive
 * here as `true`/`false` from application code that means 1/0.
 */
const bindable = (value: unknown): null | number | bigint | string | Uint8Array => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`cannot bind ${typeof value} to a SQLite statement`);
};

class SqlitePreparedStatement {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  readonly #bindings: unknown[];

  constructor(db: DatabaseSync, sql: string, bindings: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#bindings = bindings;
  }

  /** D1's `bind` returns a NEW statement rather than mutating, and code relies on it. */
  bind(...values: unknown[]): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.#db, this.#sql, values);
  }

  // Callers pass a type argument (`first<{ status: string }>()`), so the generic has to
  // stay, but nothing here can verify the shape — SQLite returns whatever the row is.
  first<T = Row>(column?: string): Promise<T | null> {
    const row = this.#all()[0];
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve((column === undefined ? row : row[column]) as T);
  }

  all(): Promise<{ results: Row[]; success: true; meta: { changes: number } }> {
    return Promise.resolve({ results: this.#all(), success: true, meta: { changes: 0 } });
  }

  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const statement = this.#db.prepare(this.#sql);
    const result = statement.run(...this.#bindings.map(bindable));
    return Promise.resolve({
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    });
  }

  #all(): Row[] {
    const statement = this.#db.prepare(this.#sql);
    // `all` also works for statements with RETURNING, which is how claims are read.
    return statement.all(...this.#bindings.map(bindable));
  }
}

/** A `D1Database` over `node:sqlite`. Implements only what the Worker actually calls. */
export class SqliteD1 {
  readonly #db: DatabaseSync;
  /** Set to make every subsequent statement throw, to simulate D1 being unavailable. */
  failure: Error | null = null;

  constructor() {
    this.#db = new DatabaseSync(':memory:');
    for (const migration of MIGRATIONS) {
      this.#db.exec(readFileSync(migration, 'utf8'));
    }
  }

  prepare(sql: string): SqlitePreparedStatement {
    if (this.failure) throw this.failure;
    return new SqlitePreparedStatement(this.#db, sql);
  }

  async batch(
    statements: SqlitePreparedStatement[],
  ): Promise<{ results: Row[]; success: true; meta: { changes: number } }[]> {
    if (this.failure) throw this.failure;

    // D1 batches are atomic. Without the transaction, a failure part-way through would
    // leave half a snapshot recorded, which is exactly the case the monitor's ordering
    // is designed around.
    this.#db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.#db.exec('COMMIT');
      return results.map((result) => ({
        results: [],
        success: true as const,
        meta: { changes: result.meta.changes },
      }));
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Direct SQL, for arranging fixtures and asserting on stored state. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  query<T>(sql: string, ...bindings: unknown[]): T[] {
    return this.#db.prepare(sql).all(...bindings.map(bindable)) as T[];
  }

  close(): void {
    this.#db.close();
  }

  /** The Worker's handlers take a `D1Database`; this satisfies the surface they use. */
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
