# Manual Test Checklist

A manual end-to-end checklist for the paths that unit and integration tests
can't reach: the real backend API and live dispatch routing. Drive each test by
giving the prompt to an AI agent that has the skill installed (or by running the
CLI directly), then verify the observable outcomes.

Set `CAPY_API_URL` to the environment you want to exercise (it defaults to the
production API); every command below reads it automatically.

## Conventions

- **App URL** — an app is served at its main (live) URL once published, and at a
  separate preview URL after each `deploy`.
- **JSON checks** — prefer `--json` on `deploy` / `status` / `versions` so you can
  diff real output against the CLI's TypeScript response interfaces
  (`DeploymentInfo` / `AppStatusResponse` / `AppDatabaseInfo`); mismatched field
  names surface as silent `undefined`, so compare field-by-field.
- **Persistence** — always verify with a full page reload (fresh backend read),
  never trust an in-memory client list or a "deploy OK" message alone.

## Already covered by a basic hello-world deploy

- `create` → `deploy` → `publish` → `status` happy path
- subdomain routing through the dispatch worker
- static asset serving

---

## Test 1 — D1 persistence

**Prompt:**
> "帮我做一个带数据库的留言板应用，访客可以提交留言（名字+内容），所有留言保存到
> 数据库里，刷新页面后还能看到。部署上线后给我地址。"

**Verify:**
- [ ] Visit the app → submit a message → **full reload → the message is still there**
- [ ] The data is real D1 (readable via the app's API), not in-memory / localStorage
- [ ] The build output's `deploy.json` includes `database.migrations`
- [ ] The deploy response carries `database: { id, name, migrationsApplied }`

## Test 2 — persistence across redeploy

**Prompt:**
> "在刚才那个留言板里加一个『删除留言』的功能，改完代码后重新部署。然后告诉我：
> 之前提交的那些留言在重新部署后还在吗？"

**Verify:**
- [ ] A redeploy does NOT wipe existing rows (the D1 database is reused, not recreated)
- [ ] The deploy response shows `migrationsApplied: 0` on the redeploy (migrations
      already applied on first deploy, not re-run)
- [ ] The new "delete" feature works against the same database: delete a row →
      full reload → the row is gone from the backend, not just the client list

## Test 3 — status / deploy JSON contract

**Prompt:**
> "用 status 命令查一下我那个留言板应用的当前状态，用 JSON 格式输出，把 URL、
> 版本、数据库名都列给我。"

**Verify:**
- [ ] `deploy --json` fields match `DeploymentInfo` + `DeploymentDatabaseInfo`
      (appName / url / version / assetsCount / deployedAt / database{id,name,migrationsApplied})
- [ ] `status --json` fields match `AppStatusResponse` (app{appName,url,createdAt} +
      `deployment: DeploymentInfo` + top-level `database: AppDatabaseInfo`)
- [ ] The nuance holds: `deployment.database` has `migrationsApplied` (deploy result),
      while the **top-level** `database` has only `{id, name}` (app metadata)
- [ ] No field drift → no silent `undefined`

## Test 4 — version increment

**Prompt:**
> "把留言板的标题改个颜色，重新部署，然后查 status，告诉我版本号有没有变。"

**Verify:**
- [ ] `version` follows `deploy-<epoch-ms>` and is distinct on each deploy
- [ ] The version token differs from the app's `createdAt` (deploy time ≠ create time)

## Test 5 — versioned deploy / publish / rollback

**Prompts (in sequence, same app):**
> "改一下首页文案，部署一个预览版本，先别上线。给我预览地址。"
> "确认预览没问题，把它发布上线。"
> "再改一次文案，部署预览。然后回滚到上一个版本。"

**Verify:**
- [ ] `deploy` is preview-only — `published` is `false` and the live URL is unchanged,
      **including the very first deploy**
- [ ] The preview URL serves the new version while the live URL still serves the old one
- [ ] `publish` (no deployId) promotes the latest preview to live
- [ ] `publish <deployId>` promotes a specific version to live
- [ ] `rollback <deployId>` re-deploys that version into the **preview** slot
      (live URL unchanged); a following `publish` makes it live
- [ ] `versions` shows exactly one `live` row; others are `preview` / `superseded`

## Test 6 — rollback --with-data (D1 Time Travel)

**Prereq:** an app with D1 and a writable API (e.g. the guestbook).

**Steps:**
1. Write a few rows, note the count.
2. Deploy + publish a new version (this captures a Time Travel bookmark).
3. Write more rows after that publish, confirm the higher count.
4. `rollback <deployId> --with-data --yes` for the version from step 2, then `publish`.

**Verify:**
- [ ] The command succeeds (destructive, so `--yes` is required; `--with-data`
      without `--yes` returns `CONFIRMATION_REQUIRED`)
- [ ] After restore, the row count matches the **deploy-instant snapshot** of the
      target version — rows written *after* that deploy are gone; rows present at
      that instant remain
- [ ] Publishing/rolling back a D1 app never returns `DATABASE_CREATE_FAILED`
      (the existing database is reused, not recreated)

## Test 7 — env vars / secrets

**Verify:**
- [ ] `secret set NAME value` then `secret list` shows the stored var
- [ ] Env values are snapshotted into the worker at deploy time and survive a
      `publish` / `rollback` (accumulate/merge semantics: a redeploy that omits a
      key keeps the stored value)
- [ ] `secret unset NAME` removes it
- [ ] The legacy `env` alias still works but is deprecated in favor of `secret`

## Test 8 — delete lifecycle

**Verify:**
- [ ] `delete --yes` (soft) stops both the live URL and the preview URL, but keeps
      the registry row + name lock + D1 data (the name cannot be reused)
- [ ] `delete --hard --yes` removes everything (all scripts, routing, D1 database,
      deployment history, env vars, registry row) and **releases the name for reuse**
- [ ] `delete --hard` without `--yes` returns `CONFIRMATION_REQUIRED` and makes no
      network call

## Test 9 — error paths

**Prompts (separate):**
> "创建一个叫 `API` 的应用" → reject (reserved / uppercase)
> "创建一个叫 `我的应用` 的应用" → reject (non-ASCII)
> "在一个已经创建过应用的目录里再创建一个应用" → guarded
> "给一个不存在的应用查 status" → not-found handling

**Verify:**
- [ ] Reserved / uppercase name → `INVALID_APP_NAME`
- [ ] Non-ASCII name → `INVALID_APP_NAME` (message matches `validateAppName`)
- [ ] Re-create in a bound directory → the CLI confirms before overwriting
      `.capy-app.json`, and cancels on decline
- [ ] `status` on a nonexistent app → `APP_NOT_FOUND`, exit 1, no crash/hang
- [ ] Every error uses the uniform envelope
      `{"success":false,"error":{"code","message"}}`

---

## What to watch across all tests

1. **Response shape match** — diff real `--json` output against the TS interfaces;
   mismatched field names yield silent `undefined` (no runtime validation).
2. **D1 really lands** — write → full reload → read back; don't trust "deploy OK".
3. **Timeout behavior** — fetch (30s) and git clone (60s) under real network.

## Known scaffold-side notes (not CLI or platform issues)

- Timestamp rendering: the default scaffold's date formatting may show
  "Invalid Date" even when the API returns valid ISO-8601 — a frontend parsing
  issue in **capy-scaffold-default**, not this CLI.
- `favicon.ico` 404 is cosmetic; the default scaffold ships no favicon.
