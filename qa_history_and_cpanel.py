"""
QA: בדיקת היסטוריה + CPANEL — וידוא שהניתוחים מוצגים בכל הממשקים
═══════════════════════════════════════════════════════════════════
"""
import asyncio, httpx, json, os, sys

BASE = os.getenv("QA_BASE_URL", "http://127.0.0.1:8899")
CPANEL_USER = os.getenv("CPANEL_USER", "admin")
CPANEL_PASS = os.getenv("CPANEL_PASS", "")

passed = 0
failed = 0

def ok(label):
    global passed
    passed += 1
    print(f"  ✅ {label}")

def fail(label, detail=""):
    global failed
    failed += 1
    print(f"  ❌ {label} — {detail}")


async def run():
    global passed, failed
    async with httpx.AsyncClient(base_url=BASE, timeout=15) as c:

        # ─── 1. בדיקת /api/reports ───
        print("\n═══ 1. API — /api/reports ═══")
        r = await c.get("/api/reports?limit=50")
        if r.status_code == 200:
            ok(f"GET /api/reports → {r.status_code}")
        else:
            fail("GET /api/reports", f"status={r.status_code}")
            return

        data = r.json()
        reports = data.get("reports", [])
        total = data.get("total", 0)
        print(f"  📊 Total reports on server: {total}, returned: {len(reports)}")

        if len(reports) > 0:
            ok(f"Server has {len(reports)} reports")
        else:
            fail("No reports on server", "Expected at least 1 report")

        # ─── 2. בדיקת שדות חיוניים בדוח ───
        print("\n═══ 2. Report fields ═══")
        required_fields = ["id", "date", "fileName", "mediaType", "truthScore", "narrative", "riskLevel"]
        if reports:
            sample = reports[0]
            for f in required_fields:
                if f in sample:
                    ok(f"Report has field '{f}' = {str(sample[f])[:50]}")
                else:
                    fail(f"Missing field '{f}'", f"keys={list(sample.keys())}")

        # ─── 3. בדיקת דוח בודד עם fullData ───
        print("\n═══ 3. Single report with fullData ═══")
        if reports:
            rid = reports[0]["id"]
            r2 = await c.get(f"/api/reports/{rid}")
            if r2.status_code == 200:
                ok(f"GET /api/reports/{rid[:20]}...")
                full = r2.json()
                if full.get("fullData"):
                    ok("fullData exists in single report")
                    fd = full["fullData"]
                    if fd.get("ui_data"):
                        ok("fullData.ui_data exists")
                    else:
                        fail("fullData.ui_data missing")
                else:
                    fail("fullData missing in single report")
            else:
                fail(f"GET single report", f"status={r2.status_code}")

        # ─── 4. בדיקת estimatedCost ───
        print("\n═══ 4. estimatedCost ═══")
        reports_with_cost = [r for r in reports if r.get("estimatedCost")]
        if reports_with_cost:
            ok(f"{len(reports_with_cost)}/{len(reports)} reports have estimatedCost")
            ec = reports_with_cost[0]["estimatedCost"]
            cost_val = ec.get("estimated_cost_usd") or ec.get("total_cost_usd") or 0
            if cost_val > 0:
                ok(f"Cost value: ${cost_val}")
            else:
                fail("Cost value is 0")
        else:
            fail("No reports have estimatedCost")

        # ─── 5. CPANEL login ───
        print("\n═══ 5. CPANEL login ═══")
        r3 = await c.get("/cpanel")
        if r3.status_code == 200:
            ok("GET /cpanel → 200")
        else:
            fail("GET /cpanel", f"status={r3.status_code}")

        if not CPANEL_PASS:
            print("  ⚠️  CPANEL_PASS not set — skipping login test")
        else:
            r4 = await c.post("/api/admin/login", data={"username": CPANEL_USER, "password": CPANEL_PASS})
            if r4.status_code == 200 and r4.json().get("ok"):
                ok("Admin login successful")
                session = r4.json().get("session", "")

                # ─── 6. CPANEL reports ───
                print("\n═══ 6. CPANEL admin reports ═══")
                r5 = await c.get("/api/admin/reports", headers={"Authorization": f"Bearer {session}"})
                if r5.status_code == 200:
                    ok("GET /api/admin/reports → 200")
                    admin_data = r5.json()
                    admin_reports = admin_data.get("reports", [])
                    admin_total = admin_data.get("total", 0)
                    print(f"  📊 Admin reports: {len(admin_reports)}, total: {admin_total}")

                    if len(admin_reports) == len(reports):
                        ok(f"CPANEL count ({len(admin_reports)}) matches user reports ({len(reports)})")
                    else:
                        fail(f"Count mismatch", f"CPANEL={len(admin_reports)} vs user={len(reports)}")

                    # Check that all user report IDs exist in admin
                    user_ids = {r["id"] for r in reports}
                    admin_ids = {r["id"] for r in admin_reports}
                    missing = user_ids - admin_ids
                    if not missing:
                        ok("All user reports exist in CPANEL")
                    else:
                        fail(f"{len(missing)} reports missing from CPANEL", f"IDs: {list(missing)[:5]}")

                    # Check validation/pipeline in admin reports
                    print("\n═══ 7. CPANEL detail data ═══")
                    with_validation = [r for r in admin_reports if r.get("validation")]
                    with_pipeline = [r for r in admin_reports if r.get("pipeline")]
                    print(f"  📊 Reports with validation: {len(with_validation)}/{len(admin_reports)}")
                    print(f"  📊 Reports with pipeline: {len(with_pipeline)}/{len(admin_reports)}")
                    if with_validation:
                        ok("Validation data available in CPANEL")
                    if with_pipeline:
                        ok("Pipeline data available in CPANEL")

                else:
                    fail("GET /api/admin/reports", f"status={r5.status_code}")

                # ─── 8. Admin stats ───
                print("\n═══ 8. Admin stats ═══")
                r6 = await c.get("/api/admin/stats", headers={"Authorization": f"Bearer {session}"})
                if r6.status_code == 200:
                    ok("GET /api/admin/stats → 200")
                    stats = r6.json()
                    print(f"  📊 Stats: {json.dumps(stats, indent=2, ensure_ascii=False)[:300]}")
                else:
                    fail("GET /api/admin/stats", f"status={r6.status_code}")

            else:
                fail("Admin login failed", f"status={r4.status_code}, body={r4.text[:200]}")

        # ─── 9. index.html loads correctly ───
        print("\n═══ 9. Frontend files ═══")
        r7 = await c.get("/stage1/index.html")
        if r7.status_code == 200:
            ok("GET /stage1/index.html → 200")
            html = r7.text
            if "app.js" in html:
                ok("index.html references app.js")
            else:
                fail("app.js not found in index.html")
            # Verify the removed sections ARE gone
            if "validContent" not in html:
                ok("validContent removed from user page ✓")
            else:
                fail("validContent should be removed from index.html")
            if "pipeContent" not in html:
                ok("pipeContent removed from user page ✓")
            else:
                fail("pipeContent should be removed from index.html")
            if "rawJson" not in html:
                ok("rawJson removed from user page ✓")
            else:
                fail("rawJson should be removed from index.html")
            if "btnNewAnalysis" not in html:
                ok("btnNewAnalysis removed ✓")
            else:
                fail("btnNewAnalysis should be removed from index.html")
        else:
            fail("GET index.html", f"status={r7.status_code}")

        # ─── 10. app.js server-first check ───
        print("\n═══ 10. app.js server-first ═══")
        r8 = await c.get("/stage1/app.js")
        if r8.status_code == 200:
            js = r8.text
            if "Server is THE source of truth" in js:
                ok("app.js has server-first logic")
            else:
                fail("app.js missing server-first comment")
            if "mergeHistoryLists(serverHistory" not in js:
                ok("Old merge logic removed")
            else:
                fail("Old merge logic still in app.js")
            if "btnNewAnalysis" not in js:
                ok("btnNewAnalysis reference removed from JS")
            else:
                fail("btnNewAnalysis still referenced in JS")
        else:
            fail("GET app.js", f"status={r8.status_code}")


    # ─── Summary ───
    print(f"\n{'='*50}")
    print(f"  ✅ Passed: {passed}")
    print(f"  ❌ Failed: {failed}")
    print(f"{'='*50}")
    return failed == 0


if __name__ == "__main__":
    success = asyncio.run(run())
    sys.exit(0 if success else 1)
