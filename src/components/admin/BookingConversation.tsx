import { fmtDate } from "@/components/admin/util";

export interface ConversationMessage { id: string; sender_role: "customer" | "driver" | string; body: string; created_at: string; driver_id: string | null; quick_reply?: boolean | null }

/**
 * Read-only view of ONE booking's chat for administrators. The parent page is admin-only and loads messages by booking id,
 * so a conversation can never appear under the wrong booking. Customer and driver messages are visually distinct and labelled.
 */
export default function BookingConversation({ messages, customerName, driverNames, tz }: { messages: ConversationMessage[]; customerName: string; driverNames: Record<string, string>; tz: string }) {
  return (
    <section className="panel" aria-label="Customer and driver conversation" style={{ marginTop: "1rem" }}>
      <h2 style={{ fontSize: "1.1rem" }}>Customer / driver messages <span className="muted">({messages.length})</span></h2>
      <p className="muted">Read-only. Messages are stored per booking and visible only to administrators, the customer and the assigned driver.</p>
      {messages.length === 0 ? <p className="muted">No messages have been sent for this ride.</p> : (
        <ol style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0", display: "grid", gap: ".5rem", maxHeight: 420, overflowY: "auto" }}>
          {messages.map((m) => {
            const isDriver = m.sender_role === "driver";
            const who = isDriver ? `Driver${m.driver_id && driverNames[m.driver_id] ? ` · ${driverNames[m.driver_id]}` : ""}` : `Customer · ${customerName}`;
            return (
              <li key={m.id} style={{ justifySelf: isDriver ? "start" : "end", maxWidth: "85%", padding: ".55rem .75rem", borderRadius: 10, border: "1px solid var(--line, #333)", borderLeft: isDriver ? "4px solid var(--accent, #2dd4bf)" : "1px solid var(--line, #333)", borderRight: isDriver ? undefined : "4px solid #c9a24a" }}>
                <p style={{ fontSize: ".8rem" }}><strong>{who}</strong> <span className="muted">· {fmtDate(m.created_at, tz)}</span>{m.quick_reply ? <span className="muted"> · quick reply</span> : null}</p>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
