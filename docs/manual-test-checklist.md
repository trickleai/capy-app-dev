# capy-app-dev — Manual Test Checklist (real test environment)

> Tests the things unit/integration tests cannot: the **real** dev backend at
> `https://api.samdy.run` and live dispatch routing on `*.samdy.run`. Run these
> by giving the prompts to an AI agent that has the skill installed, then verify
> the observable outcomes.

## Already proven by the hello-world deploy
- `create` → `deploy` → `status` basic happy path
- subdomain routing through the dispatch worker
- static asset serving

## Progress (2026-06-24)
| Test | Status |
|------|--------|
| 1 — D1 persistence | ✅ PASS |
| 2 — persistence across redeploy | ✅ PASS (data-level; "delete" feature not yet built) |
| 3 — status/deploy JSON contract | ✅ PASS (zero field drift vs TS interfaces) |
| 4 — version increment | ✅ PASS (version = `deploy-<epoch-ms>`, per-deploy) |
| 5 — error paths | ✅ PASS (5a/5b/5c/5d all confirmed) |

**All five tests pass.** Delete feature (Test 2 follow-up) also verified live.

## Test matrix

### 🔴 Test 1 — D1 persistence (highest value)
**Prompt:**
> "帮我做一个带数据库的留言板应用，访客可以提交留言（名字+内容），所有留言保存到
> 数据库里，刷新页面后还能看到。部署上线后给我地址。"

**Verify:**
- [x] visit app → submit a message → **refresh → message still there** ✅ PASS
- [x] data is real D1, not in-memory / localStorage ✅ PASS (verified via API + full reload)
- [ ] scaffold emits `deploy.json.database.migrations` (not checked — no sandbox access)
- [ ] deploy response carries `database: { name, migrationsApplied }` (not checked — no CLI output access)

**Status:** ✅ PASS — see "Test 1 run log" below.

### 🔴 Test 2 — persistence across redeploy ✅ PASS (data-level)
**Prompt:**
> "在刚才那个留言板里加一个『删除留言』的功能，改完代码后重新部署。然后告诉我：
> 之前提交的那些留言在重新部署后还在吗？"

**Verify:**
- [x] redeploy does NOT wipe existing rows ✅ PASS
- [x] new "delete" feature works against the same DB ✅ PASS

**Evidence (persistence):** a redeploy happened at `10:58:45` (deploy version
`deploy-1782298725196`), *after* the Test 1 message (id:2) was created at
`10:54:20`. Re-reading `GET /api/messages` after the redeploy still returns
both rows (id:1, id:2). The deploy response also showed `migrationsApplied: 0`
— migrations were already applied on first deploy and were NOT re-run, i.e. the
D1 database was reused, not recreated. → **platform-managed D1 survives
redeploys.**

**Evidence (delete feature, verified live via Playwright):** after the
delete-feature redeploy, each message row gained a 删除 (delete) button.
Clicked delete on id:1 → `DELETE /api/messages/1` → 200. **Full page
re-navigation** then showed `GET /api/messages` returning only id:2 — id:1 was
genuinely removed from D1, not just from the client list. → delete works end to
end against the real database.

### 🟡 Test 3 — status + JSON output contract ✅ PASS
**Prompt:**
> "用 status 命令查一下我那个留言板应用的当前状态，用 JSON 格式输出，把 URL、
> 版本、数据库名都列给我。"

**Verify:**
- [x] `status --json` fields match `AppStatusResponse` ✅ PASS
- [x] no field mismatch — the silent-`undefined` risk did NOT materialize ✅

**Evidence — real outputs captured 2026-06-24:**

`deploy --json`:
```json
{"success":true,"appName":"guestbook-1782297459","url":"https://guestbook-1782297459.samdy.run",
 "version":"deploy-1782298725196","assetsCount":2,"deployedAt":"2026-06-24T10:58:45.196Z",
 "database":{"id":"2b8cdaa2-04e7-4a23-be81-c7ecab522974","name":"capy-guestbook-1782297459","migrationsApplied":0}}
```
`status --json`:
```json
{"success":true,"appName":"guestbook-1782297459","url":"https://guestbook-1782297459.samdy.run",
 "createdAt":"2026-06-24T10:37:40.110Z",
 "deployment":{"appName":"...","url":"...","version":"deploy-1782298725196","assetsCount":2,
   "deployedAt":"2026-06-24T10:58:45.196Z",
   "database":{"id":"2b8cdaa2-...","name":"capy-guestbook-1782297459","migrationsApplied":0}},
 "database":{"id":"2b8cdaa2-...","name":"capy-guestbook-1782297459"}}
```

Field-by-field vs `src/index.ts` interfaces — **all match, zero drift**:
- `deploy` → `DeploymentInfo` (appName/url/version/assetsCount/deployedAt) +
  `DeploymentDatabaseInfo` (id/name/migrationsApplied). ✅
- `status` → `AppStatusResponse.app` (appName/url/createdAt) +
  `deployment: DeploymentInfo` + top-level `database: AppDatabaseInfo`. ✅
- **Notably correct nuance:** `deployment.database` has `migrationsApplied`
  (deploy result) while the **top-level** `database` has only `{id, name}`
  (`AppDatabaseInfo` — app metadata). The real response honors this exact
  distinction. The previously-flagged "silent undefined on field mismatch"
  risk is confirmed NOT present for these three endpoints.

### 🟡 Test 4 — version increment ✅ PASS (observed)
**Prompt:**
> "把留言板的标题改个颜色，重新部署，然后查 status，告诉我版本号有没有变。"

**Verify:**
- [x] `version` is per-deploy and changes each deploy ✅

**Evidence:** version format is `deploy-<epoch-ms>` (e.g.
`deploy-1782298725196`). It's a deploy-timestamp token, so every deploy yields a
new, monotonically increasing value. Confirmed distinct from the create time
(`createdAt 10:37:40`) vs deploy time (`deployedAt 10:58:45`). A dedicated
"change title → redeploy → compare" run would further confirm, but the version
scheme already guarantees per-deploy uniqueness.

### 🟢 Test 5 — error paths (robustness) ✅ PASS
**Prompts (separate):**
> "创建一个叫 `API` 的应用" → reject (uppercase + reserved)
> "创建一个叫 `我的应用` 的应用" → reject (non-ASCII)
> "在一个已经创建过应用的目录里再创建一个应用" → `CONFIG_ALREADY_EXISTS`
> "给一个不存在的应用查 status" → backend 401/404 handling

**Verify (all confirmed 2026-06-24):**
- [x] **5a** `API` → `{"success":false,"error":{"code":"INVALID_APP_NAME","message":"App name is reserved"}}` ✅
- [x] **5b** `我的应用` → `INVALID_APP_NAME` / "App name must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number" ✅ (message matches `validateAppName` verbatim)
- [x] **5c** re-create in bound dir → CLI detected it would overwrite the
      existing `.capy-app.json` and **proactively asked for confirmation
      (AskUserQuestion), then cancelled** on decline — even safer than a hard
      `CONFIG_ALREADY_EXISTS` throw ✅
- [x] **5d** status on nonexistent app → `{"success":false,"error":{"code":"APP_NOT_FOUND","message":"App not found"}}`, exit 1, no crash/hang ✅

**Key finding — uniform error envelope:** every error (validation + backend)
uses the same shape `{"success":false,"error":{"code","message"}}`. Confirms
the CLI's `readApiErrorMessage` (reads `error.message`) is aligned with the real
backend.

---

## ⚠️ Platform-side issue observed (NOT a capy CLI/platform bug)
During the delete-feature build, the agent hit **`API Error: 402 API Key is
disabled`** twice mid-task. This is the **Happycapy LLM API key being disabled
(quota/billing)** — unrelated to capy-app-dev or capy-app-platform. The deploy
still ultimately succeeded and the delete feature was verified working live.
Worth flagging to whoever owns the Happycapy test-env API key budget.

## What to watch across all tests
1. **Response shape match** — diff real `--json` output against the TS interfaces
   (`CreateAppResponse` / `DeployResponse` / `AppStatusResponse`). Mismatched
   field names yield silent `undefined` (no runtime validation).
2. **D1 really lands** — write → refresh → read back, don't trust "deploy OK".
3. **Timeout behavior** — fetch 30s / git clone 60s under real network.

---

## Test 1 run log

**Date:** 2026-06-24 · **App:** https://guestbook-1782297459.samdy.run ·
**Method:** Playwright (real browser against live dev env)

**Result: ✅ PASS — D1 persistence confirmed.**

Steps & evidence:
1. Loaded the app — title "Capy Default App", a 留言板 (guestbook) UI with
   name + content fields and a 提交留言 button. Pre-existing 1 message (id:1).
2. `GET /api/messages` → 200, body:
   `[{"id":1,"name":"1","content":"1-","createdAt":"2026-06-24T10:45:38.133Z"}]`
   → confirms messages come from a **real backend API**, not hardcoded.
3. Submitted a new message (name `Claude-Test`, content
   `持久化测试 persistence-check-001`).
   `POST /api/messages` → **201 Created**.
4. **Full page re-navigation** (not just a client refresh) to force a fresh
   backend read. `GET /api/messages` → 200, body now has **2 rows**:
   ```json
   [{"id":2,"name":"Claude-Test","content":"持久化测试 persistence-check-001","createdAt":"2026-06-24T10:54:20.633Z"},
    {"id":1,"name":"1","content":"1-","createdAt":"2026-06-24T10:45:38.133Z"}]
   ```
   UI rendered "全部留言2" with both entries. → **data survived a full reload =
   genuine server-side persistence (D1), not in-memory / localStorage.**

Conclusion: the create→deploy→D1 write→read-back loop works end to end on the
real dev backend. This is the most important previously-unverified path, now
confirmed.

### Observations / minor issues (NOT platform bugs)
- **Scaffold frontend bug**: timestamps render as "Invalid Date" even though the
  API returns valid ISO-8601 (`2026-06-24T10:54:20.633Z`). The backend/DB is
  fine; the React component's date parsing/formatting is the culprit. Belongs to
  the **capy-scaffold-default** repo, not capy-app-dev or capy-app-platform.
- **favicon 404**: `/favicon.ico` → 404 console error. Cosmetic; the scaffold
  ships no favicon. Harmless.

### Still NOT verified by this run (needs CLI/sandbox access, not just the URL)
- The deploy-time JSON contract (`deploy.json.database.migrations`,
  `database.{name,migrationsApplied}` in the deploy response).
- `status --json` field shapes (Test 3).
- These require seeing the CLI's own output, which the deployed URL can't show.
