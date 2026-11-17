#!/usr/bin/env python3
"""Merge correlated markets into multi-market replay files (one shared pool per cluster).

    python3 sim/make-clusters.py

Clusters: markets of the same Polymarket event (mutually exclusive outcomes, e.g. World Cup winner) across the
batch + holdout sets, plus hand-picked themes. Output: sim/data/clusters/<name>.json + manifest.json.
Format: {"n", "t": [10-min buckets], "p<i>": [price*1e6 or 9999999 = no data], "resolutionTime<i>", "dailyVolume<i>"}
"""
import json, os, re, collections

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
NONE = 9_999_999
THEMES = {"iran-theme": re.compile(r"iran|hormuz|khamenei")}

markets = {}
for ds in ("batch", "holdout"):
    for m in json.load(open(os.path.join(ROOT, ds, "manifest.json"))):
        markets[m["slug"]] = (ds, m)

groups = collections.defaultdict(list)
for slug, (ds, m) in markets.items():
    groups[re.sub(r"[^a-z0-9]+", "-", m["event"].lower()).strip("-")].append(slug)
for name, rx in THEMES.items():
    groups[name] = [s for s in markets if rx.search(s)]
groups = {k: v for k, v in groups.items() if len(v) >= 2}

out_dir = os.path.join(ROOT, "clusters")
os.makedirs(out_dir, exist_ok=True)
manifest = []
for name, slugs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    series = []
    for s in slugs:
        ds, _ = markets[s]
        d = json.load(open(os.path.join(ROOT, ds, f"{s}.json")))
        series.append((s, d, {t - t % 600: p for t, p in zip(d["t"], d["p"])}))
    buckets = sorted(set().union(*(b.keys() for _, _, b in series)))
    out = {"name": name, "n": len(series), "t": buckets, "members": [s for s, _, _ in series]}
    for i, (s, d, b) in enumerate(series):
        out[f"p{i}"] = [b.get(t, NONE) for t in buckets]
        out[f"resolutionTime{i}"] = d["resolutionTime"]
        out[f"dailyVolume{i}"] = d.get("dailyVolume", 0)
    json.dump(out, open(os.path.join(out_dir, f"{name}.json"), "w"))
    days = (buckets[-1] - buckets[0]) / 86400
    manifest.append({"slug": name, "markets": len(series), "days": round(days), "members": out["members"]})
    print(f"{name:55s} {len(series):2d} markets  {len(buckets):6d} ticks  {days:5.0f} days")

json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=2)
