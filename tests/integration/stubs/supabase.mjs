// Tests may register a different in-memory database per API key (globalThis.__fakeDbByKey), e.g. to model the anon key
// being unable to read what the service-role key can. By default every client shares globalThis.__fakeDb.
export function createClient(_url, key) { return globalThis.__fakeDbByKey?.[key] ?? globalThis.__fakeDb; }
