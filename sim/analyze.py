#!/usr/bin/env python3
"""Summarize backtest runs.   python3 sim/analyze.py <tag> [<tag> ...]   [--markets]"""
import json, sys, glob, os

LP = 1_000_000
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def load(tag):
    rows = []
    for f in sorted(glob.glob(os.path.join(ROOT, tag, "*.json"))):
        rows.append(json.load(open(f)))
    return rows


def world_stats(rows, key):
    ws = [(r["market"].split("/")[-1], r[key]) for r in rows if r.get(key)]
    if not ws:
        return None
    usd = lambda x: x / 1e6
    pnl = [(m, usd(w["senior"] + w["junior"]) - LP) for m, w in ws]
    bad = sum(usd(w["badDebt"]) for _, w in ws)
    interest = sum(p for _, p in pnl) + bad
    out = {
        "markets": len(ws),
        "lp_pnl": sum(p for _, p in pnl),
        "interest": interest,
        "bad_debt": bad,
        "loss_markets": sum(1 for _, p in pnl if p < 0),
        "worst": min(pnl, key=lambda x: x[1]),
        "senior_loss_markets": sum(1 for _, w in ws if usd(w["senior"]) < LP * 0.8 - 1e-6) if key == "phoebe" else None,
        "junior_min": min(usd(w["junior"]) for _, w in ws),
        "volume": sum(usd(w["volume"]) for _, w in ws),
        "avg_peak_util": sum(usd(w["peakDebt"]) for _, w in ws) / len(ws) / LP,
        "bad_events": sum(w["badDebtEvents"] for _, w in ws),
        "liqs": sum(w["liquidations"] for _, w in ws),
        "opened": sum(w["opened"] for _, w in ws),
        "per_market": pnl,
        "solvent_liqs": sum(w.get("solventLiqs", 0) for _, w in ws),
        "trader_penalty": sum(usd(w.get("traderPenalty", 0)) for _, w in ws),
        "open_fees": sum(usd(w.get("openFees", 0)) for _, w in ws),
        "absorbed_debt": sum(usd(w.get("absorbedDebt", 0)) for _, w in ws),
        "recovered": sum(usd(w.get("recovered", 0)) for _, w in ws),
        "absorbed": sum(w.get("absorbed", 0) for _, w in ws),
    }
    # credit loss = fire-sale bad debt + absorbed debt not recovered (negative = net recovery gain)
    out["credit_loss"] = out["bad_debt"] + out["absorbed_debt"] - out["recovered"]
    return out


def fmt(s):
    return (
        f"LP PnL {s['lp_pnl']:>+11,.0f} | income {s['lp_pnl'] + s['credit_loss']:>9,.0f} | credit loss {s['credit_loss']:>9,.0f} "
        f"({s['bad_events']} events) | losing mkts {s['loss_markets']:>2}/{s['markets']} | "
        f"worst {s['worst'][1]:>+9,.0f} ({s['worst'][0][:38]}) | volume {s['volume']/1e6:6.1f}M | "
        f"util {s['avg_peak_util']:.0%}\n            traders: opened {s['opened']}, liquidated {s['liqs']/max(1,s['opened']):.0%} "
        f"(solvent {s['solvent_liqs']}), liq penalties {s['trader_penalty']:,.0f}, open fees {s['open_fees']:,.0f}"
    )


show_markets = "--markets" in sys.argv
tags = [a for a in sys.argv[1:] if not a.startswith("--")]
naive_shown = False
for tag in tags:
    rows = load(tag)
    cfg = open(os.path.join(ROOT, tag, "config.txt")).read().split() if os.path.exists(os.path.join(ROOT, tag, "config.txt")) else []
    p = world_stats(rows, "phoebe")
    print(f"[{tag}] {' '.join(cfg) or '(defaults)'}")
    print("   phoebe: " + fmt(p))
    if p["absorbed"]:
        print(f"           absorbed {p['absorbed']} positions: debt written off {p['absorbed_debt']:,.0f}, "
              f"recovered {p['recovered']:,.0f} (net {p['recovered']-p['absorbed_debt']:+,.0f})")
    if p["junior_min"] < 200_000:
        print(f"           junior min {p['junior_min']:,.0f}  (senior impaired in {p['senior_loss_markets']} mkts)")
    n = world_stats(rows, "naive")
    if n and not naive_shown:
        print("   naive : " + fmt(n))
        naive_shown = True
    if show_markets:
        for (m, pp) in sorted(p["per_market"], key=lambda x: x[1])[:12]:
            print(f"      {pp:>+10,.0f}  {m}")
