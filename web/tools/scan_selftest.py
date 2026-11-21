#!/usr/bin/env python3
"""Runs scan_fixtures.json through the Python scan engine. Exit code 1 on any mismatch."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import scan
F = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scan_fixtures.json"), encoding="utf-8"))
bad = 0
def chk(name, got, want):
    global bad
    if got != want: bad += 1; print("FAIL", name, "got", got, "want", want)
for c in F["files"]: chk(c["name"], scan.scan_text(c["path"], c["cls"], c["text"]), c["expect"])
for i, c in enumerate(F["tree"]): chk("tree %d" % i, scan.scan_tree(c["entries"]), c["expect"])
for c in F["meta"]: chk("meta " + c["repo"]["full_name"], scan.scan_meta(c["repo"]), c["expect"])
for i, c in enumerate(F["pick"]): chk("pick %d" % i, [[p["path"], p["cls"]] for p in scan.pick_files([{"path": p, "size": 10} for p in c["paths"]])], c["expect"])
for i, c in enumerate(F["hooks"]): chk("hooks %d" % i, [list(x) for x in scan.hook_scripts(c["text"])], [c["codes"], c["scripts"]])
for i, c in enumerate(F["verdict"]): chk("verdict %d" % i, list(scan.verdict(c["codes"])), [c["level"], c["reasons"]])
for i, c in enumerate(F["cluster"]): chk("cluster %d" % i, sorted(scan.find_clusters(c["repos"])), c["expect"])
n = sum(len(F[k]) for k in F)
print("scan selftest:", n - bad, "/", n, "passed"); sys.exit(1 if bad else 0)
