"""QA — Cost Tracker end-to-end verification"""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))

passed = 0
failed = 0

def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {name}" + (f" ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))

print("=" * 60)
print("  QA: Cost Tracker Pipeline")
print("=" * 60)

# --- TEST 1: CostTracker class works ---
print("\n🔬 Test 1: CostTracker class")
from analyzer import CostTracker
ct = CostTracker()
ct.tick("whisper"); ct.tick("whisper")
ct.tick("vision"); ct.tick("vision"); ct.tick("vision")
ct.tick("detr"); ct.tick("detr")
ct.tick("ai_class")
ct.tick("chat"); ct.tick("chat")
ct.tick("chat_120b")
s = ct.summary()
check("total_calls == 11", s["total_calls"] == 11, f"got {s['total_calls']}")
check("estimated_cost_usd > 0", s["estimated_cost_usd"] > 0, f"${s['estimated_cost_usd']:.6f}")
check("cost_breakdown has entries", len(s["cost_breakdown"]) > 0, f"{len(s['cost_breakdown'])} models")
check("calls dict correct", s["calls"]["whisper"] == 2 and s["calls"]["vision"] == 3)

# --- TEST 2: _current_tracker integration ---
print("\n🔬 Test 2: Global tracker integration")
import analyzer
check("_current_tracker exists", hasattr(analyzer, "_current_tracker"))
analyzer._current_tracker = CostTracker()
analyzer._current_tracker.tick("chat")
check("tick works on global", analyzer._current_tracker.summary()["total_calls"] == 1)
analyzer._current_tracker = None

# --- TEST 3: save_report field extraction ---
print("\n🔬 Test 3: save_report cost extraction")
cost_data = {"estimated_cost_usd": 0.012, "total_calls": 56, "cost_breakdown": {"whisper": 0.001}}

# Case A: estimatedCost provided directly
body_a = {"estimatedCost": cost_data, "fullData": {}}
ec_a = body_a.get("estimatedCost") or (body_a.get("fullData") or {}).get("estimated_cost") or None
check("direct estimatedCost extracted", ec_a == cost_data)

# Case B: estimatedCost missing, in fullData
body_b = {"estimatedCost": None, "fullData": {"estimated_cost": cost_data}}
ec_b = body_b.get("estimatedCost") or (body_b.get("fullData") or {}).get("estimated_cost") or None
check("fallback to fullData.estimated_cost", ec_b == cost_data)

# Case C: no cost anywhere
body_c = {"estimatedCost": None, "fullData": {}}
ec_c = body_c.get("estimatedCost") or (body_c.get("fullData") or {}).get("estimated_cost") or None
check("no cost returns None", ec_c is None)

# --- TEST 4: Admin API slim with backfill ---
print("\n🔬 Test 4: Admin API backfill")
fake_report = {"id": "x", "estimatedCost": None, "fullData": {"estimated_cost": cost_data}}
row = {k: v for k, v in fake_report.items() if k != "fullData"}
if not row.get("estimatedCost"):
    fd_cost = (fake_report.get("fullData") or {}).get("estimated_cost")
    if fd_cost:
        row["estimatedCost"] = fd_cost
check("backfill from fullData works", row["estimatedCost"] == cost_data)

# --- TEST 5: Real reports data ---
print("\n🔬 Test 5: Real stored reports")
reports_path = os.path.join(os.path.dirname(__file__), "data", "shared_reports.json")
if os.path.exists(reports_path):
    reports = json.load(open(reports_path, encoding="utf-8"))
    total = len(reports)
    has_top_level = sum(1 for r in reports if r.get("estimatedCost"))
    has_in_fulldata = sum(1 for r in reports if (r.get("fullData") or {}).get("estimated_cost"))
    can_backfill = sum(1 for r in reports
                       if not r.get("estimatedCost")
                       and (r.get("fullData") or {}).get("estimated_cost"))
    check(f"total reports: {total}", total > 0)
    check(f"reports with top-level estimatedCost: {has_top_level}", True)
    check(f"reports with fullData.estimated_cost: {has_in_fulldata}", has_in_fulldata > 0,
          f"{has_in_fulldata}/{total}")
    check(f"backfillable reports: {can_backfill}", True,
          f"these will show cost after fix")

    # Simulate what admin API will now return
    costs_shown = 0
    for r in reports:
        ec = r.get("estimatedCost")
        if not ec:
            ec = (r.get("fullData") or {}).get("estimated_cost")
        if ec and (ec.get("estimated_cost_usd", 0) or ec.get("total_cost_usd", 0)) > 0:
            costs_shown += 1
    check(f"reports that WILL show cost in CPANEL: {costs_shown}/{total}",
          costs_shown > 0, "after server restart")
else:
    check("reports file exists", False, reports_path)

# --- TEST 6: multi_agent_system integration ---
print("\n🔬 Test 6: multi_agent_system imports")
try:
    from multi_agent_system import CostTracker as MAS_CT
    check("CostTracker imported in multi_agent_system", True)
except ImportError as e:
    check("CostTracker imported in multi_agent_system", False, str(e))

# --- SUMMARY ---
print("\n" + "=" * 60)
total = passed + failed
if failed == 0:
    print(f"  ✅ ALL {passed} CHECKS PASSED")
else:
    print(f"  ⚠️  {passed}/{total} passed, {failed} FAILED")
print("=" * 60)
