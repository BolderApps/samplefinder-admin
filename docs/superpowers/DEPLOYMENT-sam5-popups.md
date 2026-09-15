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
| Mobile API function | `appwrite/functions/Mobile API` (id `69308117000e7a96bcbb`) | `/get-active-popups`, `/record-popup-view`, `/record-popup-click`, `/reset-popup-interactions` |
| Statistics function | `appwrite/functions/Statistics functions` (id `69341ffa001a4ebd28c2`) | `popups` stats page; per-user viewer rollup (SAM-12) |
| Admin dashboard | `samplefinder-admin` web app | Pop-ups list / create / edit / details pages |
| Mobile app | `samplefinder-app` | queued pop-up banner modal |

- **Database id:** `69217af50038b9005a61`
- **Branches (both):** `feature/SAM-5/popups` — admin is 2 commits ahead of `main` (the
  feature, plus a staging-tooling fix), app is 1.
- **Backward compatible** — checked against the diff, not assumed. The Mobile API change is
  878 insertions and **0 deletions**: no line an existing build depends on was modified, and
  older builds never call the new routes. The Statistics function removed 3 lines, all of
  them the `page` union and two error strings widened to accept `'popups'`. Deploying both
  functions ahead of either client is safe.

> ### ⚠️ TestFlight builds hit PRODUCTION
>
> `babel.config.js` selects `.env.staging` only when `APP_VARIANT=staging`, and the only
> script that sets it is `start:staging` (the dev server). There is no staging *build*
> script, and releases are built locally with `xcodebuild` / `gradlew`. A TestFlight build
> made the normal way therefore reads `.env`, which points at the **production** project
> `691d4a54003b21bf0136`.
>
> So "ship to TestFlight first" is not a staging test. Pop-ups cannot be exercised there
> until the prod schema and Mobile API are live — and the moment they are, they are live for
> every existing App Store user too. That is safe (see the compatibility note above), but it
> should be a decision rather than a surprise. A genuine staging test needs an
> `APP_VARIANT=staging` build, which has no script today.

---

## Prerequisites

- **Appwrite CLI** installed and authenticated (`appwrite login`).
  ⚠️ **The CLI takes its target project from no environment variable.** It reads
  `appwrite.config.json` first and only then `~/.appwrite/prefs.json`; `APPWRITE_ENDPOINT` /
  `APPWRITE_PROJECT` / `APPWRITE_KEY` are ignored entirely by v22. The committed config
  carries the **production** project id, so a plain `appwrite push …` from this repo targets
  **prod** — which is what this guide wants, and exactly what you must never assume when
  aiming at staging. For staging use `appwrite/staging-cli.sh`, which swaps the id for the
  duration of one command and restores it.
- **A server API key** with these scopes, exported as `APPWRITE_API_KEY` for the labeler script: `users.read`, `users.write`, and `rows.read` on `user_profiles`. **Never commit this key or put it in any client env.**
- **Admin `.env`** (build-time, admin web): optionally add `VITE_APPWRITE_COLLECTION_POPUPS=popups` for explicitness (it already defaults to `popups`). No other new admin env var is required.
- **Mobile `.env`:** no new variable — the app reaches the new routes through the existing `APPWRITE_EVENTS_FUNCTION_ID` (the Mobile API function).
- **Function env in Appwrite:** no new function environment variables are required for pop-ups. ⚠️ But see the **Statistics API-key deploy-gate** in Phase 3.
- Access to the mobile **release** process (local `gradlew` / `xcodebuild` per the `release` skill — never EAS, never `prebuild`).

---

## Phase 0 — Pre-flight

```bash
cd samplefinder-admin

# You are on the feature branch:
git branch --show-current            # → feature/SAM-5/popups
git log --oneline origin/main..HEAD  # → 2 commits (feature + staging-cli fix)
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

## Phase 2 — Create the schema (tables + permissions)

> ### 🚫 Do NOT run `appwrite push tables`
>
> An earlier version of this guide said to run
> `appwrite push tables --table-id popups --table-id popup_interactions`. **That command is
> unsafe and must not be run against any live project.** CLI v22 ignores `--table-id` and
> pushes *every* table in `appwrite.config.json`, rewriting the columns of all 14 live prod
> tables — shrinking `size` values and re-enum-ifying attributes against whatever the
> committed config happens to say. `appwrite/staging-cli.sh` now refuses these subcommands
> outright.
>
> Create the two tables **by hand in the Appwrite console** instead. This is also how they
> were created on staging.

Create in database `69217af50038b9005a61`:

**`popups`** — permissions `create/read/update/delete("label:admin")`

| Column | Type | Notes |
|---|---|---|
| `title` | string(200) | optional |
| `description` | string(1000) | optional |
| `imageUrl` | string(2000) | **required** |
| `imageFileId` | string(100) | **required** |
| `link` | string(2000) | optional |
| `startDate` / `endDate` | datetime | **required** |
| `only21Plus` | boolean | optional, default `true` |
| `targetAudience` | enum | **required** — All, NewUsers, BrandAmbassadors, Influencers, Tier1–5, ZipCode, Targeted |
| `selectedUserIds` | string(1000)[] | optional array |
| `selectedZipCodes` | string(1000)[] | optional array |
| `newUsersTimeRange` | integer | optional |
| `destinationType` | string(64) | optional — `external` \| `event`; absent reads as external |
| `destinationEventId` | string(64) | optional |
| `views` / `clicks` | integer | optional, default `0` |
| `interactionsResetAt` | datetime | optional |

**`popup_interactions`** — permissions `read("label:admin")`, `delete("label:admin")`. No
create/update: clients write through the Mobile API's key, never directly.

> ⚠️ **Do not strip these back to `[]`.** They were empty at launch, which broke pop-up
> deletion in production with a bare `401 user_unauthorized`. `popup_interactions` holds a
> `manyToOne` relationship to `popups` with `onDelete: cascade`, and utopia-php/database
> runs that cascade through the **public** `find()` + `deleteDocument()` — no
> `Authorization::skip()` (`Database.php`, `deleteCascade`, the `RELATION_MANY_TO_ONE`
> branch). So an admin's *session* is permission-checked against this table, and with `[]`
> the `find()` for the child rows throws before a single row is deleted. An API key papers
> over it, because a key disables the check entirely — which is why every scripted test
> passed and only the admin panel failed. Read is what fails first; delete is what fails
> second. Both are required.
>
> Only pop-ups that had **impressions** were affected; one with no child rows deletes fine.

| Column | Type | Notes |
|---|---|---|
| `popup` | relationship → `popups` | optional |
| `user` | relationship → `user_profiles` | optional |
| `dayKey` | string(10) | **required** — Eastern calendar day, `YYYY-MM-DD` |
| `shownAt` | datetime | **required** |
| `clicked` | boolean | optional, default `false` |
| `clickedAt` | datetime | optional |
| `resetAt` | datetime | optional |
| `is21Plus` | boolean | optional, default `false` |

- **No indexes in v1, by design** — but see the index note under *Operational notes* before
  a full App Store rollout.
- **Defer the `trivia` permission tightening.** `trivia` is already live in prod; switching
  it to `label:admin` locks out any admin not carrying the label. It is separable and the
  pop-up code does not depend on it. If you do want it, complete Phase 1 first and change
  the permissions in the console — not via `push tables`.

**Immediately verify (as a labeled admin, in the dashboard):** create/edit/delete a popup
and confirm the list page loads. A `401`/`403` on a write means that admin isn't labeled —
re-run Phase 1 for them. If you also tightened `trivia`, check it the same way.

---

## Phase 3 — Deploy the functions

Build first (Phase 0 already did), then push:

```bash
cd samplefinder-admin/appwrite
appwrite push functions --function-id 69308117000e7a96bcbb   # Mobile API
appwrite push functions --function-id 69341ffa001a4ebd28c2   # Statistics functions
```

Unlike `push tables`, **`--function-id` is genuinely honoured** — the CLI only fans out to
every function when `--all` is passed — so these two commands each deploy exactly one
function. They land on the project named in `appwrite.config.json`, i.e. **prod**; for
staging run them through `appwrite/staging-cli.sh`.

`push functions` needs a console session (`appwrite login`), not just an API key. If you
only have a key, deploy by POSTing a tarball to
`/functions/{id}/deployments` with `activate=true` and the project id in the
`X-Appwrite-Project` header — that route takes a key and cannot be mis-targeted by config.

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

**Order matters: the Statistics function (Phase 3) must be live before the admin build.**
The admin tolerates the old function shape via `rollUpLegacyViewers`, so a wrong order
degrades rather than breaks — but while that fallback is active the 1000-row cap counts raw
sightings instead of users, and busy campaigns under-report.

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

- **Permissions:** restore both tables to `create/read/update/delete("users")` **in the
  console** (see runbook). Do not use `appwrite push tables` — see the warning in Phase 2.
  Admin labels left in place are harmless.
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
- **Impressions are counted on display, not at fetch.** (This reverses the original spec
  decision 9; the old behaviour burned a pop-up the moment the app asked for one, so
  anything the render gate held back — trivia, tier modals — was lost for the rest of the
  Eastern day.) Current builds send `clientReportsViews` and report the sighting themselves
  via `/record-popup-view`. **Builds already in the field** send no flag and keep the
  write-on-fetch path, so their reach can still read slightly high; they are now served
  exactly one pop-up per fetch, oldest campaign first, so delivery is FIFO by construction.
- **"Impressions" counts every sighting; "Unique Users Shown" counts people** (SAM-12). The
  two legitimately differ whenever someone saw a pop-up more than once — a repeat viewer is
  one row in the viewer table carrying their own count, not several rows.
- **`popup_interactions` has no indexes.** Every pop-up fetch and view-record scans the
  table. That is invisible at TestFlight scale and a real problem at full App Store
  rollout: add a compound index on `popup` + `user`, and `popup` + `$createdAt` for the
  stats page, before wide release.
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
