// Type declarations for the plain-JS in-memory database helper (fakedb.mjs), so tests can import it without
// suppressing type errors. Runtime behaviour lives in fakedb.mjs; this file is types only.
export type FakeRow = { id: string } & Record<string, unknown>;

export declare class FakeDb {
  tables: Record<string, FakeRow[]>;
  seq: number;
  auth: { getUser(token: string): Promise<{ data: { user: { id: string; email: string } | null }; error: { message: string } | null }> };
  storage: Record<string, unknown>;
  /** Rows of a table (created on first use). */
  t(name: string): FakeRow[];
  seed(name: string, rows: Record<string, unknown>[]): void;
  from(name: string): unknown;
}
