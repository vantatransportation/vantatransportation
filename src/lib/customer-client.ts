/** Browser helpers for the customer's booking actions. The browser sends only a credential for its own booking: never an amount or a status. */
export type ClientCredential = { kind: "token"; token: string } | { kind: "code"; code: string };
export const credBody = (c: ClientCredential): Record<string, string> => (c.kind === "token" ? { token: c.token } : { trackingId: c.code });
export async function postJson(url: string, body: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
