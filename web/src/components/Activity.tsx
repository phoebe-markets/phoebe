import type { Activity as A } from "../store";
import { when } from "../format";
import { CFG } from "../chain";

const ICON: Record<A["kind"], [string, string]> = {
  Opened: ["+", "var(--ink-2)"],
  Closed: ["−", "var(--ink-2)"],
  MarginAdded: ["↓", "var(--ink-2)"],
  Flagged: ["▲", "var(--warning)"],
  Liquidated: ["✕", "var(--critical)"],
  Absorbed: ["◆", "var(--serious)"],
  InventorySold: ["$", "var(--good)"],
  Settled: ["=", "var(--ink-2)"],
  Redeemed: ["✓", "var(--good)"],
};

export function ActivityFeed({ items }: { items: A[] }) {
  return (
    <section className="card" aria-label="Protocol activity">
      <h2>Protocol activity</h2>
      {items.length === 0 ? (
        <div className="empty">{CFG.mainnet ? "No activity yet. Opens, liquidations and settlements show up here." : "Nothing yet. Start the keeper with demo/replay.sh."}</div>
      ) : (
        <div className="feed" role="log" aria-live="polite">
          {items.map((it) => (
            <div className="item" key={it.key}>
              <time>{when(it.t)}</time>
              <span aria-hidden style={{ color: ICON[it.kind][1], fontWeight: 700, textAlign: "center" }}>{ICON[it.kind][0]}</span>
              <span>
                <span className="sub">{it.kind === "InventorySold" ? "Inventory sold" : it.kind} · </span>
                {it.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
