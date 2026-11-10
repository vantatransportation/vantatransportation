export async function cookies() {
  return { get: (n) => (globalThis.__cookies?.[n] ? { value: globalThis.__cookies[n] } : undefined) };
}
