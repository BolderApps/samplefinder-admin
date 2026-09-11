# Deployment Guide — SAM-5 Pop-up Image Ads

End-to-end deployment for the pop-up ads feature ([SAM-5](https://linear.app/bolder-builders/issue/SAM-5)),
which spans both repos and the shared Appwrite backend. Follow the phases **in order** —
the ordering is load-bearing (notably: label admins *before* tightening permissions, and
verify stats *immediately after* deploying the Statistics function).

> **Deep-dive companion:** the permission-hardening steps (Phase 1–2) are documented in
> detail in [`RUNBOOK-popup-trivia-perms-hardening.md`](./RUNBOOK-popup-trivia-perms-hardening.md).
> This guide is the full sequence; the runbook is the reference for the hardening specifics
> and its rollback.

---

## What ships

| Component | Where | Change |
|---|---|---|
| Schema | `appwrite.config.json` | new tables `popups`, `popup_interactions`; tightened `popups`/`trivia` permissions |
| Mobile API function | `appwrite/functions/Mobile API` (id `69308117000e7a96bcbb`) | `/get-active-popups`, `/record-popup-click` |
| Statistics function | `appwrite/functions/Statistics functions` (id `69341ffa001a4ebd28c2`) | `popups` stats page |
| Admin dashboard | `samplefinder-admin` web app | Pop-ups list / create / edit / details pages |
| Mobile app | `samplefinder-app` | queued pop-up banner modal |

- **Database id:** `69217af50038b9005a61`
- **Branches (both):** `qudratillo/sam-5-pop-ups-in-the-application` — admin & app, one squashed commit each, rebased on latest `main`.
- **Backward compatible:** older mobile app builds simply never call the new routes; deploying the backend first is safe.

---

## Prerequisites

- **Appwrite CLI** installed and authenticated (`appwrite login`) against the correct project. (A newer CLI is fine; verify subcommands with `appwrite push --help` — this repo pushes from `appwrite.config.json`.)
- **A server API key** with these scopes, exported as `APPWRITE_API_KEY` for the labeler script: `users.read`, `users.write`, and `rows.read` on `user_profiles`. **Never commit this key or put it in any client env.**
- **Admin `.env`** (build-time, admin web): optionally add `VITE_APPWRITE_COLLECTION_POPUPS=popups` for explicitness (it already defaults to `popups`). No other new admin env var is required.
- **Mobile `.env`:** no new variable — the app reaches the new routes through the existing `APPWRITE_EVENTS_FUNCTION_ID` (the Mobile API function).
- **Function env in Appwrite:** no new function environment variables are required for pop-ups. ⚠️ But see the **Statistics API-key deploy-gate** in Phase 3.
- Access to the mobile **release** process (local `gradlew` / `xcodebuild` per the `release` skill — never EAS, never `prebuild`).

---

## Phase 0 — Pre-flight

```bash
cd samplefinder-admin

# You are on the feature branch, one commit ahead of the latest main:
git branch --show-current            # → qudratillo/sam-5-pop-ups-in-the-application
git log --oneline origin/main..HEAD  # → exactly 1 commit
git status --porcelain               # → clean

# Full build + lint (typechecks the whole admin app):
npm run build && npm run lint         # build must exit 0

# Rebuild both touched functions so src/main.js matches src/main.ts:
( cd "appwrite/functions/Mobile API" && npm run build )
( cd "appwrite/functions/Statistics functions" && npm run build )
git status --porcelain               # → still clean (main.js already committed)
```

In `samplefinder-app`:

```bash
cd samplefinder-app
git log --oneline origin/main..HEAD  # → exactly 1 commit
npm run typecheck                    # → exit 0
```

If the branches aren't merged to `main` yet, decide your integration path (open PRs and
merge, or deploy from the branches). The backend (Phases 1–3) can deploy from the admin
branch regardless; the admin/app builds (Phase 4) should come from whatever ref you ship.

---

## Phase 1 — Label admin users (**must precede Phase 2**)

Admin-ness is only a `user_profiles.role === 'admin'` document attribute today; Appwrite
permissions can't reference it. The tightened permissions (Phase 2) grant access to the
`label:admin` principal, so **every current admin's Auth user must carry the `admin`
label before those permissions go live**, or admins lose dashboard access to popups/trivia.

```bash
cd samplefinder-admin

# 1) Dry-run — confirm the count matches your known admin roster:
APPWRITE_API_KEY=… npm run label:admin-users -- --dry-run

# 2) Apply (idempotent — safe to re-run any time):
APPWRITE_API_KEY=… npm run label:admin-users
```

Then have admins **log out and back in** (belt-and-suspenders; not strictly required —
labels are evaluated per request).

See the [hardening runbook](./RUNBOOK-popup-trivia-perms-hardening.md) for details.

---

## Phase 2 — Push schema (tables + tightened permissions)

```bash
cd samplefinder-admin/appwrite

# New tables:
appwrite push tables --table-id popups --table-id popup_interactions

# Tightened permissions on popups (and trivia):
appwrite push tables --table-id popups --table-id trivia
```

- You can push all in one `appwrite push tables --table-id popups --table-id popup_interactions --table-id trivia` if preferred.
- `trivia` permission tightening is **separable** — to defer it, omit `--table-id trivia` now and push it later (the code doesn't depend on it).
- Verify no indexes were expected (there are none in v1, by design).

**Immediately verify (as a labeled admin, in the dashboard):** create/edit/delete a popup
**and** a trivia; confirm both list pages load. A `401`/`403` on a write means that admin
isn't labeled — re-run Phase 1 for them.

---

## Phase 3 — Deploy the functions

Build first (Phase 0 already did), then push:

```bash
cd samplefinder-admin/appwrite
appwrite push functions --function-id 69308117000e7a96bcbb   # Mobile API
appwrite push functions --function-id 69341ffa001a4ebd28c2   # Statistics functions
```

### ⚠️ Statistics API-key deploy-gate — verify right after deploying

The Statistics function's committed `src/main.js` was stale on `main` and has now been
rebuilt from source. Its API-key resolution order is `APPWRITE_API_KEY` →
`APPWRITE_FUNCTION_KEY` → request header — it already prioritizes a custom full-scope
`APPWRITE_API_KEY` over the auto-injected function key. Source (`main.ts`) and the deployed
artifact (`main.js`) match on this, so the deploy does **not** change key-resolution
behavior; the checks below are a post-deploy sanity check, not a gate.

**Immediately after deploying the Statistics function, load these admin pages and confirm
they populate (not `—`/error):**
- **Dashboard** (all stat tiles)
- **App Users** (emails + last-login must resolve)
- Spot-check **Clients**, **Notifications**, **Trivia**, and the new **Pop-ups** stats.

If any read breaks: because the function already prefers `APPWRITE_API_KEY` when it's set,
confirm that key has `users.read` + read on all reported collections. If it's under-scoped,
either broaden its scopes or unset `APPWRITE_API_KEY` so the function falls back to the
auto-injected `APPWRITE_FUNCTION_KEY`.

---

## Phase 4 — Deploy the clients

1. **Admin dashboard:** build and deploy from your shipping ref.
   ```bash
   cd samplefinder-admin && npm run build   # outputs dist/
   ```
   Deploy `dist/` via your normal admin hosting flow. Ensure the deploy env includes the
   Appwrite endpoint/project/db and (optionally) `VITE_APPWRITE_COLLECTION_POPUPS`.

2. **Mobile app:** the pop-up feature is **JS/TS only** — no native modules, no `app.json`
   changes — so it rides the normal app release. Use the `release` skill / your standard
   local build (gradlew / xcodebuild). ⚠️ Remember the release-signing fragility: native
   dirs are gitignored and signing/manifest fixes are wiped by `prebuild` — do **not**
   run `prebuild` for this release.

Because the backend is backward compatible, you may deploy Phases 1–3 ahead of the app
release without breaking existing installs.

---

## Post-deploy QA matrix

Run on a real signed-in device once the backend is live. (Full matrix: the plan's Task 11
and the senior-qa report; audit trail in `.superpowers/sdd/progress.md`.) Priority cases:

- **Happy path:** create a popup (audience *All*, 21+ ON, image + `https://` link, today).
  App shows it ~8s after launch on a non-Tuesday; tapping opens the browser and closes the
  modal; the admin details page shows Impressions ≥1, Unique Clickers 1, 21+ Clickers 1,
  CTR 100%.
- **Audience:** each type resolves the right users — *Targeted* (only listed users),
  *ZipCode*, *NewUsers (N days)*, *Tier1–5*, *Ambassadors/Influencers*.
- **21+ gating:** `only21Plus` ON with a user who is `idAdult=false` or `dob` < 21 → not
  shown; OFF → shown to all; a non-21+ clicker counts in Unique Clickers but **not** 21+
  Clickers.
- **Multi-day / frequency:** a multi-day popup shows once per day; a user who clicks on
  day 1 still sees it day 2 but stays **one** unique clicker; reshow needs a
  background→foreground (no polling by design).
- **Trivia coexistence:** on an Eastern Tuesday with a pending trivia, trivia shows first;
  the popup appears only after the trivia queue drains. (On slow networks a popup may
  briefly flash before trivia loads — expected, not a bug.)
- **No-link popup:** image isn't tappable; only the X closes it; no click recorded.
- **Broken image:** a popup with an unreachable `imageUrl` shows no empty modal — the
  queue advances silently.
- **Signed-out:** no popups ever render on the login screen.
- **Admin edit/delete:** replacing an image deletes the old storage file after save;
  deleting a popup removes its storage file and cascades its interaction rows; the details
  page still renders the popup card even if the stats call fails.

---

## Rollback

Permissions-only and code-only changes; no destructive data migration.

- **Permissions:** restore both tables to `create/read/update/delete("users")` and
  `appwrite push tables --table-id popups --table-id trivia` (see runbook). Admin labels
  left in place are harmless.
- **Functions:** redeploy the previous function version from Appwrite's deployment history
  (or from `main` before this branch), for Mobile API and/or Statistics.
- **Admin dashboard:** redeploy the previous build.
- **Mobile app:** the feature is inert without the backend routes; if needed, ship a build
  from before this change.
- **Tables:** `popups`/`popup_interactions` are new and empty at launch — they can be left
  in place on a rollback (nothing reads them once the functions are reverted) or deleted if
  you want a clean teardown.

---

## Operational notes (ongoing)

- **New admins must be labeled.** Creating an admin sets `user_profiles.role = 'admin'` but
  **cannot** set the Appwrite Auth label from the client (no server key in the browser, by
  design). After adding an admin, re-run `npm run label:admin-users` (idempotent) or add the
  `admin` label in the Appwrite console (Auth → user → Labels). Until then the new admin can
  log in but gets permission errors on popups/trivia.
- **Impressions are counted at fetch time** (spec decision 9). On a trivia day a popup
  fetched behind trivia is counted as an impression and consumes its once-per-day slot even
  if the user quits before it displays. Reach can therefore read **slightly higher** than
  actual views — keep this in mind when interpreting CTR.
- **Counters vs. rows:** the `views`/`clicks` counters on a popup doc are cheap
  approximations (non-atomic increments; a rare double-tap or cross-device race can drift).
  The **details page** figures (unique users shown, unique clickers, CTR) are computed from
  `popup_interactions` rows and are the source of truth.

---

## References

- Hardening runbook: [`RUNBOOK-popup-trivia-perms-hardening.md`](./RUNBOOK-popup-trivia-perms-hardening.md)
- Design spec: [`specs/2026-07-02-popup-ads-design.md`](./specs/2026-07-02-popup-ads-design.md)
- Implementation plan (full QA matrix in Task 11): [`plans/2026-07-02-sam5-popup-ads.md`](./plans/2026-07-02-sam5-popup-ads.md)
- Audit trail (per-task reviews, final review, fixes): `.superpowers/sdd/progress.md`
