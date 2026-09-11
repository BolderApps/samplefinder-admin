# Pop-up Image Ads (SAM-5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-managed pop-up banner images shown in the mobile app on scheduled days, with notification-style audience targeting, per-pop-up 21+ gating, and unique-clicker stats.

**Architecture:** Mirrors the trivia feature end-to-end: two new Appwrite tables (`popups`, `popup_interactions`), two new Mobile API function routes (`/get-active-popups`, `/record-popup-click`) that evaluate audience + 21+ eligibility per user at serve time and record interactions server-side, a new admin "Pop-ups" page group (list / create / edit / details), a `popups` stats page in the Statistics function, and a global `PopupImageModal` queued behind trivia in the mobile app's `App.tsx`.

**Tech Stack:** Appwrite (TablesDB + Functions, `node-appwrite` v14, node-22 runtime), React 19 + Vite + Tailwind (admin, `appwrite` web SDK), Expo SDK 54 / RN 0.81 TS-strict (`react-native-appwrite`).

**Spec:** `docs/superpowers/specs/2026-07-02-popup-ads-design.md` (approved). Read it before starting any task.

## Global Constraints

- **No test framework exists in either repo** (per workspace CLAUDE.md). Every task's verification is: function build (`npm run build` in the function dir), admin `npm run build` + `npm run lint`, app `npm run typecheck` — plus the manual QA matrix in Task 11. Do not add a test framework.
- **Branches:** admin repo work happens on the existing branch `qudratillo/sam-5-pop-ups-in-the-application`; the app repo gets a branch of the same name (created in Task 8).
- **Database ID** everywhere: `69217af50038b9005a61`. New table IDs: `popups`, `popup_interactions`.
- **Audience enum values, verbatim** (must match the `notifications` table exactly): `All`, `NewUsers`, `BrandAmbassadors`, `Influencers`, `Tier1`, `Tier2`, `Tier3`, `Tier4`, `Tier5`, `ZipCode`, `Targeted`.
- **Tier name map, verbatim:** Tier1→`NewbieSampler`, Tier2→`SampleFan`, Tier3→`SuperSampler`, Tier4→`VIS`, Tier5→`SampleMaster`.
- **21+ rule:** eligible iff `idAdult === true` AND (`dob` absent/unparseable OR computed age ≥ 21). Applied server-side only.
- **Frequency rule:** one serve per (popup, user, app-timezone day). Day key format `YYYY-MM-DD` computed in `America/New_York`.
- **Counter semantics:** `popups.views` = serve events (impressions); `popups.clicks` = unique clickers (increment only on a user's first-ever click for that popup).
- **App timezone:** `America/New_York` (same constant the trivia code uses). Admin date pickers convert full days via `appTimeToUTC(date, '00:00'|'23:59', appTimezone)`.
- **Appwrite SDK style:** new `functions.createExecution` calls use the object-based signature (house rule). `databases.*`/`storage.*` calls in admin/web and node functions keep the positional style the surrounding file already uses.
- **Never put server API keys in the mobile client** — the app only calls the Mobile API function.
- **No indexes on the new tables in v1.** Deviation from one spec line: no existing table in this project defines indexes, and `trivia_responses` is already queried by relationship + equality unindexed in production. Add indexes later only if serve latency demands it.
- **TypeScript strict in both repos**: no `any` in new code (functions' existing `catch {}`/`as unknown as` idioms are acceptable).
- **Commit messages** follow the existing `feat(scope): …` / `fix(scope): …` style and end with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

## File Structure

**samplefinder-admin repo** (all paths relative to repo root):
- Modify `appwrite/appwrite.config.json` — add 2 tables (Task 1)
- Modify `appwrite/functions/Mobile API/src/main.ts` — popup types, constants, helpers, 2 handlers, 2 routes (Task 2)
- Modify `appwrite/functions/Statistics functions/src/main.ts` — `popups` stats page (Task 3)
- Modify `src/lib/appwrite.ts` — `collections.popups` entry (Task 4)
- Modify `src/lib/services.ts` — `PopupDocument`, `popupsService`, `PopupsStats`, `PopupDetailStatistics`, extend `statisticsService` (Task 4)
- Create `src/lib/storageUtils.ts` — shared upload/delete helpers (Task 4)
- Create `src/pages/Popups/components/CreatePopupModal.tsx` (Task 5)
- Create `src/pages/Popups/components/EditPopupModal.tsx` (Task 5)
- Create `src/pages/Popups/components/index.ts` (Task 5)
- Create `src/pages/Popups/Popups.tsx` — list page (Task 6)
- Create `src/pages/Popups/PopupDetails.tsx` — details/stats page (Task 7)
- Modify `src/App.tsx`, `src/components/DashboardLayout.tsx`, `.env.example` (Tasks 6–7)

**samplefinder-app repo:**
- Create `src/lib/database/popups.ts`; modify `src/lib/database/index.ts` (Task 8)
- Create `src/components/popup/PopupImageModal.tsx` + `src/components/popup/index.ts` (Task 9)
- Modify `App.tsx` — queue state, fetch effects, render (Task 10)

---

### Task 1: Schema — `popups` and `popup_interactions` tables

**Files:**
- Modify: `samplefinder-admin/appwrite/appwrite.config.json` (the `"tables"` array)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `popups` and `popup_interactions` with the exact column keys/types below. Every later task depends on these names: `title`, `imageUrl`, `imageFileId`, `link`, `startDate`, `endDate`, `only21Plus`, `targetAudience`, `selectedUserIds`, `selectedZipCodes`, `newUsersTimeRange`, `views`, `clicks` (popups) and `popup`, `user`, `dayKey`, `shownAt`, `clicked`, `clickedAt`, `is21Plus` (popup_interactions).

- [ ] **Step 1: Add the two table objects to the `tables` array**

In `appwrite/appwrite.config.json`, append these two entries to the `"tables"` array (after the `report_logs` entry, before the closing `]`). Shapes copied from the existing `trivia`/`trivia_responses`/`notifications` entries:

```json
{
 "$id": "popups",
 "$permissions": [
  "create(\"users\")",
  "read(\"users\")",
  "update(\"users\")",
  "delete(\"users\")"
 ],
 "databaseId": "69217af50038b9005a61",
 "name": "Popups",
 "enabled": true,
 "rowSecurity": false,
 "columns": [
  { "key": "title", "type": "string", "required": true, "array": false, "size": 200, "default": null, "encrypt": false },
  { "key": "imageUrl", "type": "string", "required": true, "array": false, "size": 2000, "default": null, "encrypt": false },
  { "key": "imageFileId", "type": "string", "required": true, "array": false, "size": 100, "default": null, "encrypt": false },
  { "key": "link", "type": "string", "required": false, "array": false, "size": 2000, "default": null, "encrypt": false },
  { "key": "startDate", "type": "datetime", "required": true, "array": false, "format": "", "default": null },
  { "key": "endDate", "type": "datetime", "required": true, "array": false, "format": "", "default": null },
  { "key": "only21Plus", "type": "boolean", "required": false, "array": false, "default": true },
  { "key": "targetAudience", "type": "string", "required": true, "array": false, "elements": ["All", "NewUsers", "BrandAmbassadors", "Influencers", "Tier1", "Tier2", "Tier3", "Tier4", "Tier5", "ZipCode", "Targeted"], "format": "enum", "default": null },
  { "key": "selectedUserIds", "type": "string", "required": false, "array": true, "size": 1000, "default": null, "encrypt": false },
  { "key": "selectedZipCodes", "type": "string", "required": false, "array": true, "size": 1000, "default": null, "encrypt": false },
  { "key": "newUsersTimeRange", "type": "integer", "required": false, "array": false, "min": 1, "max": 365, "default": null },
  { "key": "views", "type": "integer", "required": false, "array": false, "min": 0, "max": 10000000, "default": 0 },
  { "key": "clicks", "type": "integer", "required": false, "array": false, "min": 0, "max": 10000000, "default": 0 }
 ],
 "indexes": []
},
{
 "$id": "popup_interactions",
 "$permissions": [],
 "databaseId": "69217af50038b9005a61",
 "name": "Popup Interactions",
 "enabled": true,
 "rowSecurity": false,
 "columns": [
  { "key": "popup", "type": "relationship", "required": false, "array": false, "relatedTable": "popups", "relationType": "manyToOne", "twoWay": false, "twoWayKey": "interactions", "onDelete": "cascade", "side": "parent" },
  { "key": "user", "type": "relationship", "required": false, "array": false, "relatedTable": "user_profiles", "relationType": "manyToOne", "twoWay": false, "twoWayKey": "popupInteractions", "onDelete": "cascade", "side": "parent" },
  { "key": "dayKey", "type": "string", "required": true, "array": false, "size": 10, "default": null, "encrypt": false },
  { "key": "shownAt", "type": "datetime", "required": true, "array": false, "format": "", "default": null },
  { "key": "clicked", "type": "boolean", "required": false, "array": false, "default": false },
  { "key": "clickedAt", "type": "datetime", "required": false, "array": false, "format": "", "default": null },
  { "key": "is21Plus", "type": "boolean", "required": false, "array": false, "default": false }
 ],
 "indexes": []
}
```

Why these choices: `popups` permissions match `trivia` (admin web CRUD via session); `popup_interactions` permissions are empty like `trivia_responses` (server-only via function API key). `rowSecurity: false` matches every table in this project.

- [ ] **Step 2: Validate the JSON**

Run from `samplefinder-admin/`:
```bash
python3 -c "import json; cfg=json.load(open('appwrite/appwrite.config.json')); ts=[t['\$id'] for t in cfg['tables']]; assert 'popups' in ts and 'popup_interactions' in ts, ts; print('OK', len(cfg['tables']), 'tables')"
```
Expected: `OK 15 tables`

- [ ] **Step 3: Push the tables to Appwrite**

Run from `samplefinder-admin/appwrite/`:
```bash
appwrite push tables --table-id popups --table-id popup_interactions
```
Expected: CLI reports both tables created. **Checkpoint:** if the CLI is not installed/authenticated (`appwrite login`), or the subcommand differs on the installed CLI version (older CLIs use `appwrite push collections`), stop and ask the user to run the push; do not guess destructive flags. Do NOT proceed to manual admin QA (Task 6+) until the push has succeeded — builds and typechecks are unaffected.

- [ ] **Step 4: Commit**

```bash
git add appwrite/appwrite.config.json
git commit -m "feat(popups): add popups + popup_interactions tables for SAM-5

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Mobile API — `/get-active-popups` and `/record-popup-click`

**Files:**
- Modify: `samplefinder-admin/appwrite/functions/Mobile API/src/main.ts`

**Interfaces:**
- Consumes: Task 1 table/column names; existing constants `DATABASE_ID`, `USER_PROFILES_TABLE_ID`; existing imports `Query`, `ID`, `Databases`.
- Produces (consumed by Task 8 and QA):
  - `POST /get-active-popups` body `{ userId: string }` (user_profiles `$id`) → `{ success: true, popups: Array<{ $id: string; title: string; imageUrl: string; link: string | null }>, count: number }`; errors `{ success: false, error: string }` with HTTP 400/404.
  - `POST /record-popup-click` body `{ userId: string, popupId: string }` → `{ success: true, alreadyClicked: boolean }`; errors as above.

- [ ] **Step 1: Add request/response/document types**

In `src/main.ts`, directly below the existing `DismissTriviaRequest` interface (around line 99–102), add:

```ts
// Popup (SAM-5) types
interface GetActivePopupsRequest {
  userId: string;
}

interface RecordPopupClickRequest {
  userId: string;
  popupId: string;
}

interface PopupDocument {
  $id: string;
  title: string;
  imageUrl: string;
  link?: string | null;
  startDate: string;
  endDate: string;
  only21Plus?: boolean;
  targetAudience?: string;
  selectedUserIds?: string[];
  selectedZipCodes?: string[];
  newUsersTimeRange?: number | null;
  views?: number;
  clicks?: number;
}

interface ActivePopupResponse {
  $id: string;
  title: string;
  imageUrl: string;
  link: string | null;
}

interface PopupTargetingProfile {
  $id: string;
  $createdAt: string;
  idAdult?: boolean;
  dob?: string | null;
  isAmbassador?: boolean;
  isInfluencer?: boolean;
  tierLevel?: string;
  zipCode?: string;
}

interface PopupInteractionRow {
  $id: string;
  popup?: string | { $id?: string };
  user?: string | { $id?: string };
  dayKey?: string;
  clicked?: boolean;
}
```

- [ ] **Step 2: Add table ID constants**

In the CONSTANTS block (after `const TRIVIA_RESPONSES_TABLE_ID = 'trivia_responses';`, ~line 446), add:

```ts
const POPUPS_TABLE_ID = 'popups';
const POPUP_INTERACTIONS_TABLE_ID = 'popup_interactions';
```

- [ ] **Step 3: Add the popup section — helpers + handlers**

Insert a new section directly after the `dismissTrivia` function ends (~line 1186), before `// USER STATUS MANAGEMENT FUNCTION`:

```ts
// ============================================================================
// POPUP FUNCTIONS (SAM-5)
// ============================================================================

const POPUP_APP_TIMEZONE = 'America/New_York';
const GET_ACTIVE_POPUPS_LIMIT = 100;
const POPUP_INTERACTIONS_TODAY_LIMIT = 200;

/** Day key (YYYY-MM-DD) in the app timezone; one serve per user per popup per day key. */
function getPopupDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: POPUP_APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function computeAgeInYears(dobIso: string, now: Date): number | null {
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

/**
 * 21+ eligibility: requires the signup attestation (idAdult) AND, when a birthdate
 * exists and parses, a computed age of at least 21.
 */
function isUser21Plus(profile: PopupTargetingProfile, now: Date): boolean {
  if (profile.idAdult !== true) return false;
  if (profile.dob) {
    const age = computeAgeInYears(profile.dob, now);
    if (age !== null && age < 21) return false;
  }
  return true;
}

/** Same tier names the Notification function targets. */
const POPUP_TIER_AUDIENCE_MAP: Record<string, string> = {
  Tier1: 'NewbieSampler',
  Tier2: 'SampleFan',
  Tier3: 'SuperSampler',
  Tier4: 'VIS',
  Tier5: 'SampleMaster',
};

const POPUP_NEW_USERS_DEFAULT_DAYS = 30;

/** Serve-time inversion of the notification audience resolution: does THIS user match? */
function popupAudienceMatches(
  popup: PopupDocument,
  profile: PopupTargetingProfile,
  now: Date
): boolean {
  const audience = popup.targetAudience || 'All';
  switch (audience) {
    case 'All':
      return true;
    case 'NewUsers': {
      const days =
        typeof popup.newUsersTimeRange === 'number' && popup.newUsersTimeRange > 0
          ? popup.newUsersTimeRange
          : POPUP_NEW_USERS_DEFAULT_DAYS;
      const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
      const createdMs = new Date(profile.$createdAt).getTime();
      return Number.isFinite(createdMs) && createdMs >= cutoffMs;
    }
    case 'BrandAmbassadors':
      return profile.isAmbassador === true;
    case 'Influencers':
      return profile.isInfluencer === true;
    case 'Tier1':
    case 'Tier2':
    case 'Tier3':
    case 'Tier4':
    case 'Tier5':
      return (profile.tierLevel || 'NewbieSampler') === POPUP_TIER_AUDIENCE_MAP[audience];
    case 'ZipCode':
      return (
        Array.isArray(popup.selectedZipCodes) &&
        !!profile.zipCode &&
        popup.selectedZipCodes.includes(profile.zipCode)
      );
    case 'Targeted':
      return (
        Array.isArray(popup.selectedUserIds) &&
        popup.selectedUserIds.includes(profile.$id)
      );
    default:
      return false;
  }
}

function extractRelId(ref: string | { $id?: string } | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === 'string' ? ref : ref.$id;
}

/**
 * Get pop-ups to show this user right now. Serving records the impression
 * (one popup_interactions row per popup/user/day + views counter), which also
 * prevents re-serving the same popup to the same user on the same app-TZ day.
 */
async function getActivePopups(
  databases: Databases,
  userId: string,
  log: (message: string) => void
): Promise<ActivePopupResponse[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = getPopupDayKey(now);

  let profile: PopupTargetingProfile;
  try {
    profile = (await databases.getDocument(
      DATABASE_ID,
      USER_PROFILES_TABLE_ID,
      userId
    )) as unknown as PopupTargetingProfile;
  } catch {
    throw { code: 404, message: 'User not found' };
  }

  const [activePopupsResult, todaysInteractionsResult] = await Promise.all([
    databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
      Query.lessThanEqual('startDate', nowIso),
      Query.greaterThanEqual('endDate', nowIso),
      Query.limit(GET_ACTIVE_POPUPS_LIMIT),
    ]),
    databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
      Query.equal('user', userId),
      Query.equal('dayKey', dayKey),
      Query.limit(POPUP_INTERACTIONS_TODAY_LIMIT),
    ]),
  ]);

  log(
    `Popups: ${activePopupsResult.total} active, user has ${todaysInteractionsResult.total} interactions for ${dayKey}`
  );

  const servedTodayIds = new Set<string>();
  for (const row of todaysInteractionsResult.documents as unknown as PopupInteractionRow[]) {
    const popupId = extractRelId(row.popup);
    if (popupId) servedTodayIds.add(popupId);
  }

  const user21Plus = isUser21Plus(profile, now);
  const eligible: PopupDocument[] = [];
  for (const popup of activePopupsResult.documents as unknown as PopupDocument[]) {
    if (servedTodayIds.has(popup.$id)) continue;
    // only21Plus defaults to true; treat missing as gated (safe default for ads).
    if (popup.only21Plus !== false && !user21Plus) continue;
    if (!popupAudienceMatches(popup, profile, now)) continue;
    eligible.push(popup);
  }

  // Serve == impression: create the per-day row and bump the views counter.
  await Promise.allSettled(
    eligible.map(async (popup) => {
      try {
        await databases.createDocument(
          DATABASE_ID,
          POPUP_INTERACTIONS_TABLE_ID,
          ID.unique(),
          {
            popup: popup.$id,
            user: userId,
            dayKey,
            shownAt: nowIso,
            is21Plus: user21Plus,
          }
        );
        await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popup.$id, {
          views: (popup.views ?? 0) + 1,
        });
      } catch (err) {
        log(`Failed to record popup serve for ${popup.$id}: ${String(err)}`);
      }
    })
  );

  log(`Returning ${eligible.length} popups`);

  return eligible.map((p) => ({
    $id: p.$id,
    title: p.title,
    imageUrl: p.imageUrl,
    link: p.link ?? null,
  }));
}

/**
 * Record a banner tap. `clicks` on the popup doc counts UNIQUE clickers:
 * it is incremented only when this user has never clicked this popup before.
 */
async function recordPopupClick(
  databases: Databases,
  userId: string,
  popupId: string,
  log: (message: string) => void
): Promise<{ alreadyClicked: boolean }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = getPopupDayKey(now);

  let profile: PopupTargetingProfile;
  try {
    profile = (await databases.getDocument(
      DATABASE_ID,
      USER_PROFILES_TABLE_ID,
      userId
    )) as unknown as PopupTargetingProfile;
  } catch {
    throw { code: 404, message: 'User not found' };
  }

  let popup: PopupDocument;
  try {
    popup = (await databases.getDocument(
      DATABASE_ID,
      POPUPS_TABLE_ID,
      popupId
    )) as unknown as PopupDocument;
  } catch {
    throw { code: 404, message: 'Popup not found' };
  }

  const [previousClicksResult, todaysRowsResult] = await Promise.all([
    databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
      Query.equal('user', userId),
      Query.equal('popup', popupId),
      Query.equal('clicked', true),
      Query.limit(1),
    ]),
    databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
      Query.equal('user', userId),
      Query.equal('popup', popupId),
      Query.equal('dayKey', dayKey),
      Query.limit(1),
    ]),
  ]);

  const hadClickedBefore = previousClicksResult.total > 0;
  const todaysRow = todaysRowsResult.documents[0] as unknown as
    | PopupInteractionRow
    | undefined;

  if (todaysRow) {
    if (todaysRow.clicked !== true) {
      await databases.updateDocument(
        DATABASE_ID,
        POPUP_INTERACTIONS_TABLE_ID,
        todaysRow.$id,
        { clicked: true, clickedAt: nowIso }
      );
    }
  } else {
    // Edge: app-TZ day rolled over while the modal stayed open — record the
    // click on a fresh row for today rather than losing it.
    await databases.createDocument(
      DATABASE_ID,
      POPUP_INTERACTIONS_TABLE_ID,
      ID.unique(),
      {
        popup: popupId,
        user: userId,
        dayKey,
        shownAt: nowIso,
        clicked: true,
        clickedAt: nowIso,
        is21Plus: isUser21Plus(profile, now),
      }
    );
  }

  if (!hadClickedBefore) {
    await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId, {
      clicks: (popup.clicks ?? 0) + 1,
    });
    log(`First click by user ${userId} on popup ${popupId}; clicks incremented`);
  }

  return { alreadyClicked: hadClickedBefore };
}
```

- [ ] **Step 4: Add the two routes**

In the router, directly after the `/dismiss-trivia` block closes (~line 1987) and before `// ACCOUNT DELETION ENDPOINT`, add:

```ts
    // ========================================================================
    // POPUP ENDPOINTS (SAM-5)
    // ========================================================================

    // GET active popups for user (serving also records the impression)
    if (req.path === '/get-active-popups' && req.method === 'POST') {
      log('Processing get-active-popups request');

      const body = req.body as GetActivePopupsRequest;

      if (!body || !body.userId) {
        return res.json({ success: false, error: 'userId is required' }, 400);
      }

      try {
        const popups = await getActivePopups(databases, body.userId, log);
        return res.json({ success: true, popups, count: popups.length });
      } catch (err: unknown) {
        const typedErr = err as { code?: number; message?: string };
        if (typedErr.code != null && typedErr.message) {
          return res.json(
            { success: false, error: typedErr.message },
            typedErr.code
          );
        }
        throw err;
      }
    }

    // RECORD popup click (banner tapped; opens link in browser client-side)
    if (req.path === '/record-popup-click' && req.method === 'POST') {
      log('Processing record-popup-click request');

      const body = req.body as RecordPopupClickRequest;

      if (!body || !body.userId) {
        return res.json({ success: false, error: 'userId is required' }, 400);
      }
      if (!body.popupId) {
        return res.json({ success: false, error: 'popupId is required' }, 400);
      }

      try {
        const result = await recordPopupClick(
          databases,
          body.userId,
          body.popupId,
          log
        );
        return res.json({ success: true, ...result });
      } catch (err: unknown) {
        const typedErr = err as { code?: number; message?: string };
        if (typedErr.code != null && typedErr.message) {
          return res.json(
            { success: false, error: typedErr.message },
            typedErr.code
          );
        }
        throw err;
      }
    }
```

- [ ] **Step 5: Build the function**

Run from `samplefinder-admin/appwrite/functions/Mobile API/`:
```bash
npm run build
```
Expected: `tsc` exits 0 and `src/main.js` is refreshed (check `git status` shows `src/main.js` modified).

- [ ] **Step 6: Commit**

```bash
git add "appwrite/functions/Mobile API/src/main.ts" "appwrite/functions/Mobile API/src/main.js"
git commit -m "feat(popups): Mobile API routes to serve popups and record clicks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(If the build emits `dist/`, leave it untracked as the repo already does.)

---

### Task 3: Statistics function — `popups` page

**Files:**
- Modify: `samplefinder-admin/appwrite/functions/Statistics functions/src/main.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (consumed by Task 4's `statisticsService`):
  - `POST /get-statistics` `{ page: 'popups' }` → `{ success: true, page: 'popups', statistics: PopupsStats }` where `PopupsStats = { totalPopups: number; scheduled: number; active: number; completed: number }`.
  - `POST /get-statistics` `{ page: 'popups', popupId: string }` → `statistics: PopupDetailStats = { totalImpressions: number; uniqueUsersShown: number; uniqueClickers: number; clickers21Plus: number; ctr: number }` (`ctr` is 0–1, rounded to 4 decimals).

- [ ] **Step 1: Add types and constants**

Below the existing `TriviaStats` interface (~line 47), add:

```ts
interface PopupsStats {
  totalPopups: number;
  scheduled: number;
  active: number;
  completed: number;
}

interface PopupDetailStats {
  totalImpressions: number;
  uniqueUsersShown: number;
  uniqueClickers: number;
  clickers21Plus: number;
  ctr: number;
}
```

After `const NOTIFICATIONS_TABLE_ID = 'notifications';` (~line 57), add:

```ts
const POPUPS_TABLE_ID = 'popups';
const POPUP_INTERACTIONS_TABLE_ID = 'popup_interactions';
```

- [ ] **Step 2: Add the two stat functions**

Directly after `getTriviaStats` ends (~line 511), add:

```ts
/**
 * Get Popups list statistics (counts by schedule status), mirroring getTriviaStats.
 */
async function getPopupsStats(
  databases: Databases,
  log: (message: string) => void
): Promise<PopupsStats> {
  try {
    const nowISO = new Date().toISOString();

    const [totalResponse, scheduledResponse, activeResponse, completedResponse] =
      await Promise.all([
        databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID),
        databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
          Query.greaterThan('startDate', nowISO),
        ]),
        databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
          Query.lessThanEqual('startDate', nowISO),
          Query.greaterThanEqual('endDate', nowISO),
        ]),
        databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
          Query.lessThan('endDate', nowISO),
        ]),
      ]);

    return {
      totalPopups: totalResponse.total,
      scheduled: scheduledResponse.total,
      active: activeResponse.total,
      completed: completedResponse.total,
    };
  } catch (error: unknown) {
    log(`Error getting popups stats: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Per-popup detail stats aggregated from popup_interactions rows (cursor-paginated).
 * uniqueClickers/clickers21Plus dedupe by user; ctr = uniqueClickers / uniqueUsersShown.
 */
async function getPopupDetailStats(
  databases: Databases,
  popupId: string,
  log: (message: string) => void
): Promise<PopupDetailStats> {
  const PAGE_SIZE = 500;
  const shownUsers = new Set<string>();
  const clickedUsers = new Set<string>();
  const clickers21Plus = new Set<string>();
  let totalImpressions = 0;
  let cursor: string | undefined;

  try {
    for (;;) {
      const queries = [Query.equal('popup', popupId), Query.limit(PAGE_SIZE)];
      if (cursor) {
        queries.push(Query.cursorAfter(cursor));
      }
      const page = await databases.listDocuments(
        DATABASE_ID,
        POPUP_INTERACTIONS_TABLE_ID,
        queries
      );

      for (const row of page.documents as unknown as Array<{
        $id: string;
        user?: string | { $id?: string };
        clicked?: boolean;
        is21Plus?: boolean;
      }>) {
        totalImpressions++;
        const userRef = row.user;
        const userId = typeof userRef === 'string' ? userRef : userRef?.$id;
        if (!userId) continue;
        shownUsers.add(userId);
        if (row.clicked === true) {
          clickedUsers.add(userId);
          if (row.is21Plus === true) {
            clickers21Plus.add(userId);
          }
        }
      }

      if (page.documents.length < PAGE_SIZE) break;
      cursor = page.documents[page.documents.length - 1].$id;
    }

    const uniqueUsersShown = shownUsers.size;
    const uniqueClickers = clickedUsers.size;
    const ctr =
      uniqueUsersShown > 0
        ? Math.round((uniqueClickers / uniqueUsersShown) * 10000) / 10000
        : 0;

    return {
      totalImpressions,
      uniqueUsersShown,
      uniqueClickers,
      clickers21Plus: clickers21Plus.size,
      ctr,
    };
  } catch (error: unknown) {
    log(`Error getting popup detail stats for ${popupId}: ${(error as Error).message}`);
    throw error;
  }
}
```

- [ ] **Step 3: Wire the routing**

In the `/get-statistics` handler:

1. Change the `validPages` array to include popups:
```ts
      const validPages = [
        'dashboard',
        'clients',
        'users',
        'notifications',
        'trivia',
        'popups',
      ];
```
2. Add a case to the `switch (body.page)` before `default:`:
```ts
        case 'popups':
          statistics = body.popupId
            ? await getPopupDetailStats(databases, String(body.popupId), log)
            : await getPopupsStats(databases, log);
          break;
```
3. The `body` in this handler is accessed as an untyped object; `body.popupId` needs no type change if `body` is `any`-ish. If `body` is typed as `{ page?: string }`, widen it to `{ page?: string; popupId?: string }`.

- [ ] **Step 4: Build**

Run from `samplefinder-admin/appwrite/functions/Statistics functions/`:
```bash
npm run build
```
Expected: exit 0, `src/main.js` refreshed.

- [ ] **Step 5: Commit**

```bash
git add "appwrite/functions/Statistics functions/src/main.ts" "appwrite/functions/Statistics functions/src/main.js"
git commit -m "feat(popups): statistics page for popup reach and unique clickers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Admin data layer — config entry, services, storage helpers

**Files:**
- Modify: `samplefinder-admin/src/lib/appwrite.ts`
- Modify: `samplefinder-admin/src/lib/services.ts`
- Create: `samplefinder-admin/src/lib/storageUtils.ts`
- Modify: `samplefinder-admin/.env.example`

**Interfaces:**
- Consumes: Task 3 response shapes; existing `DatabaseService`, `NotificationAudience`, `statisticsService`, `appwriteConfig`, `storage`.
- Produces (consumed by Tasks 5–7):
  - `appwriteConfig.collections.popups: string`
  - `interface PopupDocument extends Models.Document` (fields as below)
  - `popupsService.{create,getById,list,update,delete}` (same call shapes as `triviaService`)
  - `interface PopupsStats { totalPopups; scheduled; active; completed }`, `interface PopupDetailStatistics { totalImpressions; uniqueUsersShown; uniqueClickers; clickers21Plus; ctr }`
  - `statisticsService.getStatistics<T>(page, extra?: { popupId?: string })` now accepts `'popups'`
  - `uploadImageToStorage(file: File): Promise<{ fileId: string; fileUrl: string }>`, `deleteStorageFile(fileId: string): Promise<void>` from `storageUtils.ts`

- [ ] **Step 1: Register the collection ID**

In `src/lib/appwrite.ts`, inside `appwriteConfig.collections` after the `locations` line, add:
```ts
    popups: import.meta.env.VITE_APPWRITE_COLLECTION_POPUPS || 'popups', // Table ID
```
In `.env.example`, next to the other `VITE_APPWRITE_COLLECTION_*` lines, add:
```
VITE_APPWRITE_COLLECTION_POPUPS=popups
```

- [ ] **Step 2: Create `src/lib/storageUtils.ts`**

The upload logic is currently copy-pasted inside Dashboard/Users/ClientsBrands pages; the popup modals need it too, so extract a shared helper (do NOT refactor the existing pages in this task):

```ts
import { storage, appwriteConfig, ID } from './appwrite'

export interface UploadedImage {
  fileId: string
  fileUrl: string
}

/** Upload an image to the shared files bucket and return its id + public view URL. */
export const uploadImageToStorage = async (file: File): Promise<UploadedImage> => {
  if (!appwriteConfig.storage.bucketId) {
    throw new Error('Storage bucket ID is not configured')
  }
  const result = await storage.createFile(
    appwriteConfig.storage.bucketId,
    ID.unique(),
    file
  )
  const fileUrl = `${appwriteConfig.endpoint}/storage/buckets/${appwriteConfig.storage.bucketId}/files/${result.$id}/view?project=${appwriteConfig.projectId}`
  return { fileId: result.$id, fileUrl }
}

/** Best-effort delete; storage orphans must never block a save/delete flow. */
export const deleteStorageFile = async (fileId: string): Promise<void> => {
  if (!appwriteConfig.storage.bucketId || !fileId) return
  try {
    await storage.deleteFile(appwriteConfig.storage.bucketId, fileId)
  } catch (error) {
    console.warn('Failed to delete storage file:', fileId, error)
  }
}
```

- [ ] **Step 3: Add popup types + service to `src/lib/services.ts`**

Append after the notifications service section (i.e., after `notificationsService`'s closing `}`; `NotificationAudience` is declared above it around line 1780 so it is in scope):

```ts
// ============================================================================
// Popups (SAM-5)
// ============================================================================

// Popup Document interface — banner image pop-ups shown in the mobile app
export interface PopupDocument extends Models.Document {
  title: string
  imageUrl: string
  imageFileId: string
  link?: string | null
  startDate: string
  endDate: string
  /** Display gate: only serve to 21+ verified users. Defaults to true. */
  only21Plus?: boolean
  targetAudience: NotificationAudience
  selectedUserIds?: string[]
  selectedZipCodes?: string[]
  newUsersTimeRange?: number
  /** Serve events (impressions), maintained by the Mobile API function */
  views?: number
  /** Unique clickers, maintained by the Mobile API function */
  clicks?: number
  [key: string]: unknown
}

export const popupsService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<PopupDocument>(appwriteConfig.collections.popups, data),
  getById: (id: string) =>
    DatabaseService.getById<PopupDocument>(appwriteConfig.collections.popups, id),
  list: (queries?: string[]) =>
    DatabaseService.list<PopupDocument>(appwriteConfig.collections.popups, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<PopupDocument>(appwriteConfig.collections.popups, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.popups, id),
}
```

- [ ] **Step 4: Add the stats interfaces and extend `statisticsService`**

Below the existing `TriviaStats` interface (~line 1414), add:

```ts
export interface PopupsStats {
  totalPopups: number
  scheduled: number
  active: number
  completed: number
}

export interface PopupDetailStatistics {
  totalImpressions: number
  uniqueUsersShown: number
  uniqueClickers: number
  clickers21Plus: number
  /** uniqueClickers / uniqueUsersShown, 0–1 */
  ctr: number
}
```

Then modify `statisticsService.getStatistics`. Replace:

```ts
  getStatistics: async <T extends DashboardStats | ClientsStats | UsersStats | NotificationsStats | TriviaStats>(
    page: 'dashboard' | 'clients' | 'users' | 'notifications' | 'trivia'
  ): Promise<T> => {
```
with:
```ts
  getStatistics: async <T extends DashboardStats | ClientsStats | UsersStats | NotificationsStats | TriviaStats | PopupsStats | PopupDetailStatistics>(
    page: 'dashboard' | 'clients' | 'users' | 'notifications' | 'trivia' | 'popups',
    extra?: { popupId?: string }
  ): Promise<T> => {
```
and replace its body line:
```ts
        body: JSON.stringify({ page }),
```
with:
```ts
        body: JSON.stringify({ page, ...(extra ?? {}) }),
```

- [ ] **Step 5: Verify build + lint**

Run from `samplefinder-admin/`:
```bash
npm run build && npm run lint
```
Expected: both exit 0 (pre-existing lint warnings unrelated to these files are acceptable if the repo already has them; new files must be clean).

- [ ] **Step 6: Commit**

```bash
git add src/lib/appwrite.ts src/lib/services.ts src/lib/storageUtils.ts .env.example
git commit -m "feat(popups): admin data layer — popupsService, stats types, storage helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Admin — Create and Edit pop-up modals

**Files:**
- Create: `samplefinder-admin/src/pages/Popups/components/CreatePopupModal.tsx`
- Create: `samplefinder-admin/src/pages/Popups/components/EditPopupModal.tsx`
- Create: `samplefinder-admin/src/pages/Popups/components/index.ts`

**Interfaces:**
- Consumes: Task 4 (`PopupDocument`, `NotificationAudience`, `uploadImageToStorage`, `deleteStorageFile`), existing `appUsersService.listAll()`, `locationsService.list()`, `appTimeToUTC`, `useTimezoneStore`.
- Produces (consumed by Task 6):
  - `CreatePopupModal` props `{ isOpen: boolean; onClose: () => void; onSave: (data: PopupFormPayload) => Promise<void> }`
  - `EditPopupModal` props `{ isOpen: boolean; popup: PopupDocument | null; onClose: () => void; onSave: (id: string, data: PopupFormPayload) => Promise<void> }`
  - `type PopupFormPayload = { title: string; imageUrl: string; imageFileId: string; link: string | null; startDate: string; endDate: string; only21Plus: boolean; targetAudience: NotificationAudience; selectedUserIds: string[]; selectedZipCodes: string[]; newUsersTimeRange: number | null }` (exported from `CreatePopupModal.tsx`)

- [ ] **Step 1: Write `CreatePopupModal.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { appUsersService, locationsService } from '../../../lib/services'
import type { AppUser, NotificationAudience } from '../../../lib/services'
import { uploadImageToStorage } from '../../../lib/storageUtils'
import { appTimeToUTC } from '../../../lib/dateUtils'
import { useTimezoneStore } from '../../../stores/timezoneStore'

export interface PopupFormPayload {
  title: string
  imageUrl: string
  imageFileId: string
  link: string | null
  startDate: string // ISO 8601 UTC (00:00 app TZ)
  endDate: string // ISO 8601 UTC (23:59 app TZ)
  only21Plus: boolean
  targetAudience: NotificationAudience
  selectedUserIds: string[]
  selectedZipCodes: string[]
  newUsersTimeRange: number | null
}

interface CreatePopupModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: PopupFormPayload) => Promise<void>
}

export interface PopupFormState {
  title: string
  link: string
  startDate: string // YYYY-MM-DD in app TZ (date input value)
  endDate: string // YYYY-MM-DD in app TZ
  only21Plus: boolean
  targetAudience: NotificationAudience
  selectedUserIds: string[]
  selectedZipCodes: string[]
  newUsersTimeRange: number | undefined
}

export const initialPopupFormState: PopupFormState = {
  title: '',
  link: '',
  startDate: '',
  endDate: '',
  only21Plus: true,
  targetAudience: 'All',
  selectedUserIds: [],
  selectedZipCodes: [],
  newUsersTimeRange: undefined,
}

export const getPopupUserDisplayName = (user: AppUser): string => {
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ')
  return name || user.username || user.email || user.$id
}

/** Validate form fields shared by create/edit. Returns an error message or null. */
export const validatePopupForm = (
  form: PopupFormState,
  hasImage: boolean
): string | null => {
  if (!form.title.trim()) return 'Please enter a title.'
  if (!hasImage) return 'Please select a banner image.'
  if (form.link.trim()) {
    try {
      const url = new URL(form.link.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'Link must start with http:// or https://'
      }
    } catch {
      return 'Link must be a valid URL (e.g. https://example.com)'
    }
  }
  if (!form.startDate) return 'Please select a start date.'
  if (!form.endDate) return 'Please select an end date.'
  if (form.endDate < form.startDate) return 'End date must be on or after the start date.'
  if (form.targetAudience === 'Targeted' && form.selectedUserIds.length === 0) {
    return 'Please select at least one user.'
  }
  if (form.targetAudience === 'ZipCode' && form.selectedZipCodes.length === 0) {
    return 'Please select at least one zip code.'
  }
  return null
}

/** Shared form body used by both Create and Edit modals. */
export const PopupFormFields = ({
  form,
  setForm,
  imagePreviewUrl,
  onImageSelected,
}: {
  form: PopupFormState
  setForm: React.Dispatch<React.SetStateAction<PopupFormState>>
  imagePreviewUrl: string | null
  onImageSelected: (file: File) => void
}) => {
  const [users, setUsers] = useState<AppUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showUserDropdown, setShowUserDropdown] = useState(false)
  const [availableZipCodes, setAvailableZipCodes] = useState<string[]>([])
  const [isLoadingZipCodes, setIsLoadingZipCodes] = useState(false)

  useEffect(() => {
    const fetchUsers = async () => {
      setLoadingUsers(true)
      try {
        setUsers(await appUsersService.listAll())
      } catch (error) {
        console.error('Error fetching users:', error)
      } finally {
        setLoadingUsers(false)
      }
    }
    if (form.targetAudience === 'Targeted' && users.length === 0) {
      void fetchUsers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.targetAudience])

  useEffect(() => {
    const fetchZipCodes = async () => {
      setIsLoadingZipCodes(true)
      try {
        const locations = await locationsService.list()
        const zips = Array.from(
          new Set(
            (locations.documents || [])
              .map((loc) => (loc as { zipCode?: string }).zipCode)
              .filter((z): z is string => !!z)
          )
        ).sort()
        setAvailableZipCodes(zips)
      } catch (error) {
        console.error('Error fetching zip codes:', error)
      } finally {
        setIsLoadingZipCodes(false)
      }
    }
    if (form.targetAudience === 'ZipCode' && availableZipCodes.length === 0) {
      void fetchZipCodes()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.targetAudience])

  const filteredUsers = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase()
    if (!q) return users.slice(0, 50)
    return users
      .filter((u) =>
        [u.firstname, u.lastname, u.username, u.email]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
      .slice(0, 50)
  }, [users, userSearchQuery])

  const inputClass =
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent'

  return (
    <div className="space-y-4">
      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Title *</label>
        <input
          type="text"
          maxLength={200}
          value={form.title}
          onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          className={inputClass}
          placeholder="Internal name, e.g. Summer IPA promo"
        />
      </div>

      {/* Image */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Banner Image *</label>
        {imagePreviewUrl && (
          <img
            src={imagePreviewUrl}
            alt="Banner preview"
            className="mb-2 max-h-48 rounded-lg border border-gray-200 object-contain"
          />
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImageSelected(file)
          }}
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-[#1D0A74] file:px-4 file:py-2 file:text-white"
        />
      </div>

      {/* Link */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Link (optional — opens in browser when the banner is tapped)
        </label>
        <input
          type="url"
          value={form.link}
          onChange={(e) => setForm((prev) => ({ ...prev, link: e.target.value }))}
          className={inputClass}
          placeholder="https://example.com/promo"
        />
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Start Date *</label>
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">End Date *</label>
          <input
            type="date"
            value={form.endDate}
            min={form.startDate || undefined}
            onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
            className={inputClass}
          />
        </div>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        The pop-up shows each day of this range (inclusive), once per user per day.
      </p>

      {/* 21+ gate */}
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={form.only21Plus}
          onChange={(e) => setForm((prev) => ({ ...prev, only21Plus: e.target.checked }))}
          className="h-4 w-4 rounded border-gray-300 text-[#1D0A74] focus:ring-[#1D0A74]"
        />
        <span className="text-sm font-medium text-gray-700">
          21+ only (show only to age-verified users — required for alcohol ads)
        </span>
      </label>

      {/* Audience (mirrors CreateNotificationModal) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Target Audience</label>
        <div className="relative">
          <select
            value={form.targetAudience}
            onChange={(e) => {
              const audience = e.target.value as NotificationAudience
              setForm((prev) => ({
                ...prev,
                targetAudience: audience,
                selectedUserIds: [],
                selectedZipCodes: [],
                newUsersTimeRange: undefined,
              }))
            }}
            className={`${inputClass} appearance-none bg-white pr-10`}
          >
            <option value="All">All Users</option>
            <option value="NewUsers">New Users</option>
            <option value="BrandAmbassadors">Certified Brand Ambassadors (BA)</option>
            <option value="Influencers">Certified Influencers</option>
            <option value="Tier1">Tier 1 Users - NewbieSamplers</option>
            <option value="Tier2">Tier 2 Users - SampleFans</option>
            <option value="Tier3">Tier 3 Users - SuperSamplers</option>
            <option value="Tier4">Tier 4 Users - VIS</option>
            <option value="Tier5">Tier 5 Users - SampleMasters</option>
            <option value="ZipCode">All Users within specific zip code area (multi-select)</option>
            <option value="Targeted">Specific Users</option>
          </select>
          <Icon
            icon="mdi:chevron-down"
            className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
          />
        </div>
      </div>

      {form.targetAudience === 'NewUsers' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            New Users Time Range (days)
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={form.newUsersTimeRange ?? ''}
            onChange={(e) => {
              const val = e.target.value
                ? Math.max(1, Math.min(365, Number(e.target.value)))
                : undefined
              setForm((prev) => ({ ...prev, newUsersTimeRange: val }))
            }}
            className={inputClass}
            placeholder="e.g. 30"
          />
          <p className="text-xs text-gray-500 mt-1">
            Show to users who signed up within the last N days (default 30).
          </p>
        </div>
      )}

      {form.targetAudience === 'ZipCode' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Zip Codes</label>
          <select
            multiple
            value={form.selectedZipCodes}
            onChange={(e) => {
              const options = Array.from(e.target.selectedOptions).map((o) => o.value)
              setForm((prev) => ({ ...prev, selectedZipCodes: options }))
            }}
            className={`${inputClass} min-h-[120px]`}
          >
            {isLoadingZipCodes && <option disabled>Loading zip codes...</option>}
            {!isLoadingZipCodes &&
              availableZipCodes.map((zip) => (
                <option key={zip} value={zip}>
                  {zip}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Hold Ctrl (Windows) or Command (Mac) to select multiple zip codes.
          </p>
        </div>
      )}

      {form.targetAudience === 'Targeted' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Select Users</label>
          {form.selectedUserIds.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {form.selectedUserIds.map((userId) => {
                const user = users.find((u) => u.$id === userId)
                if (!user) return null
                return (
                  <div
                    key={userId}
                    className="inline-flex items-center gap-2 px-3 py-1 bg-[#1D0A74] text-white rounded-full text-sm"
                  >
                    <span>{getPopupUserDisplayName(user)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          selectedUserIds: prev.selectedUserIds.filter((id) => id !== userId),
                        }))
                      }
                      className="hover:bg-white/20 rounded-full p-0.5"
                    >
                      <Icon icon="mdi:close" className="w-4 h-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <div className="relative popup-user-dropdown-container">
            <input
              type="text"
              placeholder="Search users by name, email or username..."
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              onFocus={() => setShowUserDropdown(true)}
              onBlur={() => setTimeout(() => setShowUserDropdown(false), 200)}
              className={inputClass}
            />
            {showUserDropdown && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {loadingUsers ? (
                  <div className="px-4 py-3 text-center text-gray-500">
                    <Icon icon="mdi:loading" className="w-5 h-5 animate-spin mx-auto" />
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="px-4 py-3 text-center text-gray-500">No users found</div>
                ) : (
                  filteredUsers.map((user) => {
                    const isSelected = form.selectedUserIds.includes(user.$id)
                    return (
                      <div
                        key={user.$id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            selectedUserIds: isSelected
                              ? prev.selectedUserIds.filter((id) => id !== user.$id)
                              : [...prev.selectedUserIds, user.$id],
                          }))
                        }
                        className={`px-4 py-2 cursor-pointer hover:bg-gray-100 flex items-center justify-between ${
                          isSelected ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div>
                          <div className="font-medium text-gray-900">
                            {getPopupUserDisplayName(user)}
                          </div>
                          {user.email && <div className="text-xs text-gray-500">{user.email}</div>}
                        </div>
                        {isSelected && <Icon icon="mdi:check" className="w-5 h-5 text-[#1D0A74]" />}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Selected {form.selectedUserIds.length} user(s)
          </p>
        </div>
      )}
    </div>
  )
}

/** Convert the date-input form to the persisted payload (full-day UTC window). */
export const buildPopupPayload = (
  form: PopupFormState,
  image: { fileId: string; fileUrl: string },
  appTimezone: string
): PopupFormPayload => ({
  title: form.title.trim(),
  imageUrl: image.fileUrl,
  imageFileId: image.fileId,
  link: form.link.trim() ? form.link.trim() : null,
  startDate: appTimeToUTC(form.startDate, '00:00', appTimezone).toISOString(),
  endDate: appTimeToUTC(form.endDate, '23:59', appTimezone).toISOString(),
  only21Plus: form.only21Plus,
  targetAudience: form.targetAudience,
  selectedUserIds: form.selectedUserIds,
  selectedZipCodes: form.selectedZipCodes,
  newUsersTimeRange: form.newUsersTimeRange ?? null,
})

const CreatePopupModal = ({ isOpen, onClose, onSave }: CreatePopupModalProps) => {
  const { appTimezone } = useTimezoneStore()
  const [form, setForm] = useState<PopupFormState>(initialPopupFormState)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)

  useEffect(() => {
    if (isOpen) {
      setForm(initialPopupFormState)
      setImageFile(null)
      setImagePreviewUrl(null)
      setError(null)
    }
  }, [isOpen])

  const handleImageSelected = (file: File) => {
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    const validationError = validatePopupForm(form, imageFile !== null)
    if (validationError) {
      setError(validationError)
      return
    }
    isSubmittingRef.current = true
    setIsSubmitting(true)
    setError(null)
    try {
      const uploaded = await uploadImageToStorage(imageFile as File)
      await onSave(buildPopupPayload(form, uploaded, appTimezone))
      onClose()
    } catch (err) {
      console.error('Error saving popup:', err)
      setError('Failed to save pop-up. Please try again.')
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">Create Pop-up</h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 hover:bg-gray-100">
            <Icon icon="mdi:close" className="h-6 w-6 text-gray-500" />
          </button>
        </div>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <form onSubmit={handleSubmit}>
          <PopupFormFields
            form={form}
            setForm={setForm}
            imagePreviewUrl={imagePreviewUrl}
            onImageSelected={handleImageSelected}
          />
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Create Pop-up'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CreatePopupModal
```

- [ ] **Step 2: Write `EditPopupModal.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PopupDocument } from '../../../lib/services'
import { uploadImageToStorage, deleteStorageFile } from '../../../lib/storageUtils'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import CreatePopupModalDefault, {
  PopupFormFields,
  buildPopupPayload,
  initialPopupFormState,
  validatePopupForm,
} from './CreatePopupModal'
import type { PopupFormPayload, PopupFormState } from './CreatePopupModal'

// Reference the default import so tooling keeps the shared module tree-shaken correctly.
void CreatePopupModalDefault

interface EditPopupModalProps {
  isOpen: boolean
  popup: PopupDocument | null
  onClose: () => void
  onSave: (id: string, data: PopupFormPayload) => Promise<void>
}

/** ISO datetime → YYYY-MM-DD date-input value in the app timezone. */
const isoToDateInput = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))

const EditPopupModal = ({ isOpen, popup, onClose, onSave }: EditPopupModalProps) => {
  const { appTimezone } = useTimezoneStore()
  const [form, setForm] = useState<PopupFormState>(initialPopupFormState)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)

  useEffect(() => {
    if (isOpen && popup) {
      setForm({
        title: popup.title,
        link: popup.link ?? '',
        startDate: isoToDateInput(popup.startDate, appTimezone),
        endDate: isoToDateInput(popup.endDate, appTimezone),
        only21Plus: popup.only21Plus !== false,
        targetAudience: popup.targetAudience,
        selectedUserIds: popup.selectedUserIds ?? [],
        selectedZipCodes: popup.selectedZipCodes ?? [],
        newUsersTimeRange: popup.newUsersTimeRange ?? undefined,
      })
      setImageFile(null)
      setImagePreviewUrl(popup.imageUrl)
      setError(null)
    }
  }, [isOpen, popup, appTimezone])

  if (!isOpen || !popup) return null

  const handleImageSelected = (file: File) => {
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    const validationError = validatePopupForm(form, true) // an image always exists in edit
    if (validationError) {
      setError(validationError)
      return
    }
    isSubmittingRef.current = true
    setIsSubmitting(true)
    setError(null)
    try {
      const image = imageFile
        ? await uploadImageToStorage(imageFile)
        : { fileId: popup.imageFileId, fileUrl: popup.imageUrl }
      await onSave(popup.$id, buildPopupPayload(form, image, appTimezone))
      if (imageFile && popup.imageFileId && popup.imageFileId !== image.fileId) {
        await deleteStorageFile(popup.imageFileId)
      }
      onClose()
    } catch (err) {
      console.error('Error updating popup:', err)
      setError('Failed to update pop-up. Please try again.')
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">Edit Pop-up</h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 hover:bg-gray-100">
            <Icon icon="mdi:close" className="h-6 w-6 text-gray-500" />
          </button>
        </div>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <form onSubmit={handleSubmit}>
          <PopupFormFields
            form={form}
            setForm={setForm}
            imagePreviewUrl={imagePreviewUrl}
            onImageSelected={handleImageSelected}
          />
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default EditPopupModal
```

(`AppUser` extends `UserProfile`, which declares `firstname?`/`lastname?`/`username?` — verified in `src/lib/services.ts` — so `getPopupUserDisplayName` typechecks as written.)

- [ ] **Step 3: Write `components/index.ts`**

```ts
export { default as CreatePopupModal } from './CreatePopupModal'
export type { PopupFormPayload } from './CreatePopupModal'
export { default as EditPopupModal } from './EditPopupModal'
```

- [ ] **Step 4: Verify build + lint**

```bash
npm run build && npm run lint
```
Expected: exit 0. (The components are not yet imported anywhere; `tsc -b` still typechecks them.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/Popups/
git commit -m "feat(popups): create/edit pop-up modals with audience targeting and 21+ toggle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Admin — Pop-ups list page, route, sidebar

**Files:**
- Create: `samplefinder-admin/src/pages/Popups/Popups.tsx`
- Modify: `samplefinder-admin/src/App.tsx` (routes `/popups`, import)
- Modify: `samplefinder-admin/src/components/DashboardLayout.tsx` (nav item)

**Interfaces:**
- Consumes: Task 4 services, Task 5 modals.
- Produces: route `/popups`; navigation to `/popups/:popupId` (page added in Task 7).

- [ ] **Step 1: Write `Popups.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { DashboardLayout, ConfirmationModal } from '../../components'
import { CreatePopupModal, EditPopupModal } from './components'
import type { PopupFormPayload } from './components'
import {
  popupsService,
  statisticsService,
  type PopupDocument,
  type PopupsStats,
} from '../../lib/services'
import { deleteStorageFile } from '../../lib/storageUtils'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'
import { Query } from '../../lib/appwrite'

type PopupStatus = 'Scheduled' | 'Active' | 'Completed'

const getPopupStatus = (popup: PopupDocument): PopupStatus => {
  const now = new Date()
  if (now < new Date(popup.startDate)) return 'Scheduled'
  if (now > new Date(popup.endDate)) return 'Completed'
  return 'Active'
}

const statusStyles: Record<PopupStatus, string> = {
  Scheduled: 'bg-blue-100 text-blue-800',
  Active: 'bg-green-100 text-green-800',
  Completed: 'bg-gray-100 text-gray-700',
}

const AUDIENCE_LABELS: Record<string, string> = {
  All: 'All Users',
  NewUsers: 'New Users',
  BrandAmbassadors: 'Brand Ambassadors',
  Influencers: 'Influencers',
  Tier1: 'Tier 1',
  Tier2: 'Tier 2',
  Tier3: 'Tier 3',
  Tier4: 'Tier 4',
  Tier5: 'Tier 5',
  ZipCode: 'Zip Codes',
  Targeted: 'Specific Users',
}

const Popups = () => {
  const navigate = useNavigate()
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [popups, setPopups] = useState<PopupDocument[]>([])
  const [stats, setStats] = useState<PopupsStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [popupToEdit, setPopupToEdit] = useState<PopupDocument | null>(null)
  const [popupToDelete, setPopupToDelete] = useState<PopupDocument | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const fetchPopups = useCallback(async () => {
    try {
      const result = await popupsService.list([
        Query.orderDesc('startDate'),
        Query.limit(200),
      ])
      setPopups(result.documents)
    } catch (err) {
      console.error('Error fetching popups:', err)
      addNotification({
        type: 'error',
        title: 'Failed to load pop-ups',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsLoading(false)
    }
  }, [addNotification])

  const fetchStats = useCallback(async () => {
    try {
      setStats(await statisticsService.getStatistics<PopupsStats>('popups'))
    } catch (err) {
      console.error('Error fetching popup stats:', err)
    }
  }, [])

  useEffect(() => {
    void fetchPopups()
    void fetchStats()
  }, [fetchPopups, fetchStats])

  const filteredPopups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return popups
    return popups.filter((p) => p.title.toLowerCase().includes(q))
  }, [popups, searchQuery])

  const handleCreate = async (data: PopupFormPayload) => {
    await popupsService.create(data as unknown as Record<string, unknown>)
    addNotification({ type: 'success', title: 'Pop-up created', message: data.title })
    await Promise.all([fetchPopups(), fetchStats()])
  }

  const handleUpdate = async (id: string, data: PopupFormPayload) => {
    await popupsService.update(id, data as unknown as Record<string, unknown>)
    addNotification({ type: 'success', title: 'Pop-up updated', message: data.title })
    await Promise.all([fetchPopups(), fetchStats()])
  }

  const handleDelete = async () => {
    if (!popupToDelete || isDeleting) return
    setIsDeleting(true)
    try {
      await popupsService.delete(popupToDelete.$id)
      await deleteStorageFile(popupToDelete.imageFileId)
      addNotification({ type: 'success', title: 'Pop-up deleted', message: popupToDelete.title })
      setPopupToDelete(null)
      await Promise.all([fetchPopups(), fetchStats()])
    } catch (err) {
      console.error('Error deleting popup:', err)
      addNotification({
        type: 'error',
        title: 'Failed to delete pop-up',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const statCards = [
    { label: 'Total Pop-ups', value: stats?.totalPopups },
    { label: 'Scheduled', value: stats?.scheduled },
    { label: 'Active', value: stats?.active },
    { label: 'Completed', value: stats?.completed },
  ]

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pop-ups</h1>
            <p className="text-sm text-gray-500">
              Banner images shown in the mobile app on scheduled days
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90"
          >
            <Icon icon="mdi:plus" className="h-5 w-5" />
            New Pop-up
          </button>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {statCards.map((card) => (
            <div key={card.label} className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">{card.label}</p>
              <p className="text-2xl font-semibold text-gray-900">{card.value ?? '—'}</p>
            </div>
          ))}
        </div>

        <div className="mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by title..."
            className="w-full max-w-sm rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Image</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">21+</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Views</th>
                <th className="px-4 py-3 text-right">Clicks</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : filteredPopups.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No pop-ups yet. Create the first one.
                  </td>
                </tr>
              ) : (
                filteredPopups.map((popup) => {
                  const status = getPopupStatus(popup)
                  return (
                    <tr key={popup.$id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <img
                          src={popup.imageUrl}
                          alt={popup.title}
                          className="h-12 w-12 rounded-lg border border-gray-200 object-cover"
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{popup.title}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatDateInAppTimezone(popup.startDate, appTimezone)} –{' '}
                        {formatDateInAppTimezone(popup.endDate, appTimezone)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {AUDIENCE_LABELS[popup.targetAudience] ?? popup.targetAudience}
                      </td>
                      <td className="px-4 py-3">
                        {popup.only21Plus !== false ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            21+
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[status]}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{popup.views ?? 0}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{popup.clicks ?? 0}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            title="Details"
                            onClick={() => navigate(`/popups/${popup.$id}`)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <Icon icon="mdi:chart-bar" className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            title="Edit"
                            onClick={() => setPopupToEdit(popup)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <Icon icon="mdi:pencil-outline" className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            title="Delete"
                            onClick={() => setPopupToDelete(popup)}
                            className="rounded p-1 text-red-500 hover:bg-red-50"
                          >
                            <Icon icon="mdi:trash-can-outline" className="h-5 w-5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreatePopupModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSave={handleCreate}
      />
      <EditPopupModal
        isOpen={popupToEdit !== null}
        popup={popupToEdit}
        onClose={() => setPopupToEdit(null)}
        onSave={handleUpdate}
      />
      <ConfirmationModal
        isOpen={popupToDelete !== null}
        onClose={() => setPopupToDelete(null)}
        onConfirm={handleDelete}
        type="delete"
        title="Delete Pop-up"
        message={`Are you sure you want to delete "${popupToDelete?.title ?? ''}"? Its stats will be deleted too.`}
        isLoading={isDeleting}
      />
    </DashboardLayout>
  )
}

export default Popups
```

(`ConfirmationModal`'s props verified against `src/components/ConfirmationModal.tsx`: `isOpen, onClose, onConfirm, type: 'delete' | …, title?, message?, isLoading?`.)

- [ ] **Step 2: Register route and nav**

In `src/App.tsx` add the import next to the Trivia imports:
```tsx
import Popups from './pages/Popups/Popups'
```
and the route before the closing `</Routes>` (after the `/trivia/:triviaId` route):
```tsx
        <Route
          path="/popups"
          element={
            <ProtectedRoute>
              <Popups />
            </ProtectedRoute>
          }
        />
```

In `src/components/DashboardLayout.tsx`, append to `navItems` after the Trivia entry:
```ts
    { path: '/popups', label: 'Pop-ups', icon: 'mdi:image-multiple-outline' },
```

- [ ] **Step 3: Verify build + lint + manual smoke**

```bash
npm run build && npm run lint
```
Expected: exit 0. Then `npm run dev`, log into the admin, open **Pop-ups** in the sidebar: stats cards render (zeros), empty table, Create modal opens, creating a pop-up with an image + date range succeeds and appears in the table (requires Task 1 push + Task 3 deployment for stats; if the Statistics function is not yet redeployed the stat cards show `—` — acceptable until Task 11).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Popups/Popups.tsx src/App.tsx src/components/DashboardLayout.tsx
git commit -m "feat(popups): admin pop-ups list page with create/edit/delete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Admin — Pop-up details page (stats)

**Files:**
- Create: `samplefinder-admin/src/pages/Popups/PopupDetails.tsx`
- Modify: `samplefinder-admin/src/App.tsx` (route `/popups/:popupId`)

**Interfaces:**
- Consumes: `popupsService.getById`, `statisticsService.getStatistics<PopupDetailStatistics>('popups', { popupId })`, Task 6 route link.
- Produces: route `/popups/:popupId`.

- [ ] **Step 1: Write `PopupDetails.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { DashboardLayout } from '../../components'
import {
  popupsService,
  statisticsService,
  type PopupDocument,
  type PopupDetailStatistics,
} from '../../lib/services'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'

const PopupDetails = () => {
  const { popupId } = useParams<{ popupId: string }>()
  const navigate = useNavigate()
  const { appTimezone } = useTimezoneStore()
  const [popup, setPopup] = useState<PopupDocument | null>(null)
  const [stats, setStats] = useState<PopupDetailStatistics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!popupId) return
    const load = async () => {
      try {
        const [doc, detailStats] = await Promise.all([
          popupsService.getById(popupId),
          statisticsService.getStatistics<PopupDetailStatistics>('popups', { popupId }),
        ])
        setPopup(doc)
        setStats(detailStats)
      } catch (err) {
        console.error('Error loading popup details:', err)
        setError('Failed to load pop-up details.')
      }
    }
    void load()
  }, [popupId])

  const statTiles = [
    { label: 'Impressions', value: stats?.totalImpressions },
    { label: 'Unique Users Shown', value: stats?.uniqueUsersShown },
    { label: 'Unique Clickers', value: stats?.uniqueClickers },
    { label: '21+ Clickers', value: stats?.clickers21Plus },
    {
      label: 'CTR',
      value: stats ? `${(stats.ctr * 100).toFixed(1)}%` : undefined,
    },
  ]

  return (
    <DashboardLayout>
      <div className="p-6">
        <button
          type="button"
          onClick={() => navigate('/popups')}
          className="mb-4 flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <Icon icon="mdi:arrow-left" className="h-4 w-4" />
          Back to Pop-ups
        </button>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {popup && (
          <>
            <div className="mb-6 flex flex-col gap-6 md:flex-row">
              <img
                src={popup.imageUrl}
                alt={popup.title}
                className="max-h-72 w-full max-w-sm rounded-xl border border-gray-200 object-contain"
              />
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{popup.title}</h1>
                <dl className="mt-3 space-y-2 text-sm text-gray-600">
                  <div>
                    <dt className="inline font-medium text-gray-800">Schedule: </dt>
                    <dd className="inline">
                      {formatDateInAppTimezone(popup.startDate, appTimezone)} –{' '}
                      {formatDateInAppTimezone(popup.endDate, appTimezone)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-gray-800">Audience: </dt>
                    <dd className="inline">{popup.targetAudience}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-gray-800">21+ only: </dt>
                    <dd className="inline">{popup.only21Plus !== false ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-gray-800">Link: </dt>
                    <dd className="inline">
                      {popup.link ? (
                        <a
                          href={popup.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#1D0A74] underline"
                        >
                          {popup.link}
                        </a>
                      ) : (
                        'None (not clickable)'
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              {statTiles.map((tile) => (
                <div key={tile.label} className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">{tile.label}</p>
                  <p className="text-2xl font-semibold text-gray-900">{tile.value ?? '—'}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Unique counts dedupe by user across the whole campaign. CTR = unique clickers ÷
              unique users shown. “Impressions” counts one serve per user per day.
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

export default PopupDetails
```

- [ ] **Step 2: Register the route**

In `src/App.tsx`, next to the Popups import add:
```tsx
import PopupDetails from './pages/Popups/PopupDetails'
```
and after the `/popups` route:
```tsx
        <Route
          path="/popups/:popupId"
          element={
            <ProtectedRoute>
              <PopupDetails />
            </ProtectedRoute>
          }
        />
```

- [ ] **Step 3: Verify build + lint**

```bash
npm run build && npm run lint
```
Expected: exit 0. Manual: from the list page, the chart icon opens `/popups/<id>`; before the Statistics function is redeployed the tiles show `—` with a console error — acceptable until Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Popups/PopupDetails.tsx src/App.tsx
git commit -m "feat(popups): pop-up details page with reach and click stats

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: App — popups database layer

**Files:**
- Create: `samplefinder-app/src/lib/database/popups.ts`
- Modify: `samplefinder-app/src/lib/database/index.ts`

**Interfaces:**
- Consumes: Task 2 endpoints; existing `functions` from `./config`, `APPWRITE_EVENTS_FUNCTION_ID` from `@env`.
- Produces (consumed by Tasks 9–10):
  - `interface ActivePopup { $id: string; title: string; imageUrl: string; link: string | null }`
  - `getActivePopups(userId: string): Promise<ActivePopup[]>`
  - `recordPopupClick(userId: string, popupId: string): Promise<void>` (never throws — click recording must not break UX)

- [ ] **Step 1: Create the app repo branch**

Run from `samplefinder-app/`:
```bash
git switch -c qudratillo/sam-5-pop-ups-in-the-application
```

- [ ] **Step 2: Write `src/lib/database/popups.ts`** (mirrors `trivia.ts`)

```ts
import { ExecutionMethod } from 'react-native-appwrite';
import { functions } from './config';
import { APPWRITE_EVENTS_FUNCTION_ID } from '@env';

/**
 * Pop-up banner served by the Mobile API (SAM-5).
 * Targeting/counter fields are intentionally stripped server-side.
 */
export interface ActivePopup {
  $id: string;
  title: string;
  imageUrl: string;
  link: string | null;
}

interface GetActivePopupsResponse {
  success: boolean;
  popups?: ActivePopup[];
  count?: number;
  error?: string;
}

/**
 * Fetch pop-ups to show right now. The server evaluates schedule window,
 * audience and 21+ eligibility, and records the impression — anything
 * returned should be displayed.
 * @param userId - The user's profile document ID from user_profiles table
 */
export const getActivePopups = async (userId: string): Promise<ActivePopup[]> => {
  const functionId = APPWRITE_EVENTS_FUNCTION_ID || '';

  if (!functionId) {
    throw new Error('APPWRITE_EVENTS_FUNCTION_ID must be configured. Please check your .env file.');
  }

  if (!userId) {
    throw new Error('userId is required');
  }

  try {
    const execution = await functions.createExecution({
      functionId,
      body: JSON.stringify({ userId }),
      method: ExecutionMethod.POST,
      xpath: '/get-active-popups',
      headers: {
        'Content-Type': 'application/json',
      },
      async: false,
    });

    if (execution.status === 'failed') {
      let errorMessage = 'Function execution failed';
      if (execution.responseBody) {
        try {
          const errorResponse = JSON.parse(execution.responseBody);
          errorMessage = errorResponse.error || errorResponse.message || execution.responseBody;
        } catch {
          errorMessage = execution.responseBody;
        }
      }
      console.error('[popups.getActivePopups] Function execution failed:', errorMessage);
      throw new Error(`Function execution failed: ${errorMessage}`);
    }

    if (!execution.responseBody) {
      throw new Error('Function execution returned empty response body');
    }

    let result: GetActivePopupsResponse;
    try {
      result = JSON.parse(execution.responseBody);
    } catch {
      console.error('[popups.getActivePopups] Failed to parse response body:', execution.responseBody);
      throw new Error('Invalid JSON response from function');
    }

    if (execution.responseStatusCode && execution.responseStatusCode >= 400) {
      const errorMessage = result.error || execution.responseBody || `HTTP ${execution.responseStatusCode}`;
      console.error('[popups.getActivePopups] Function returned error status:', {
        statusCode: execution.responseStatusCode,
        body: errorMessage,
      });
      throw new Error(`Function returned error: ${errorMessage}`);
    }

    if (!result.success) {
      console.error('[popups.getActivePopups] API returned error:', result);
      throw new Error(result.error || 'Failed to fetch popups');
    }

    return result.popups || [];
  } catch (error: any) {
    console.error('[popups.getActivePopups] Error fetching popups:', error);
    if (error.message?.includes('must be') || error.message?.includes('is required')) {
      throw error;
    }
    throw new Error(error.message || 'Failed to fetch active popups');
  }
};

/**
 * Record that the user tapped a pop-up banner. Fire-and-forget semantics:
 * failures are logged, never thrown — opening the link must not be blocked.
 * @param userId - The user's profile document ID
 * @param popupId - The popup document ID that was tapped
 */
export const recordPopupClick = async (userId: string, popupId: string): Promise<void> => {
  const functionId = APPWRITE_EVENTS_FUNCTION_ID || '';

  if (!functionId || !userId || !popupId) {
    return;
  }

  try {
    const execution = await functions.createExecution({
      functionId,
      body: JSON.stringify({ userId, popupId }),
      method: ExecutionMethod.POST,
      xpath: '/record-popup-click',
      headers: {
        'Content-Type': 'application/json',
      },
      async: false,
    });

    if (execution.status === 'failed' && execution.responseBody) {
      console.warn('[popups.recordPopupClick] Execution failed:', execution.responseBody);
    }
  } catch (error) {
    console.warn('[popups.recordPopupClick] Error recording click:', error);
  }
};
```

- [ ] **Step 3: Re-export from `src/lib/database/index.ts`**

Add alongside the trivia re-exports:
```ts
// Re-export popup functions (SAM-5)
export { getActivePopups, recordPopupClick } from './popups';
export type { ActivePopup } from './popups';
```

- [ ] **Step 4: Typecheck**

Run from `samplefinder-app/`:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/database/popups.ts src/lib/database/index.ts
git commit -m "feat(popups): database layer for pop-up banners via Mobile API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: App — `PopupImageModal` component

**Files:**
- Create: `samplefinder-app/src/components/popup/PopupImageModal.tsx`
- Create: `samplefinder-app/src/components/popup/index.ts`

**Interfaces:**
- Consumes: `ActivePopup` from Task 8.
- Produces (consumed by Task 10): `PopupImageModal` with props `{ visible: boolean; popup: ActivePopup; onClose: () => void; onPress: () => void }`. Behavior contract: broken image ⇒ calls `onClose()` exactly once and renders nothing; tap on image calls `onPress` only when `popup.link` is set; X always calls `onClose`.

- [ ] **Step 1: Write `PopupImageModal.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ActivePopup } from '@/lib/database/popups';

interface PopupImageModalProps {
  visible: boolean;
  popup: ActivePopup;
  onClose: () => void;
  onPress: () => void;
}

const SCREEN = Dimensions.get('window');
const CARD_WIDTH = Math.min(SCREEN.width * 0.85, 400);
const MAX_IMAGE_HEIGHT = SCREEN.height * 0.65;
const DEFAULT_ASPECT_RATIO = 4 / 5;

/**
 * Full-screen pop-up banner (SAM-5). Tapping the image opens the campaign
 * link (handled by the parent); the X dismisses. A broken image URL closes
 * the modal instead of showing an empty card.
 */
export const PopupImageModal = ({ visible, popup, onClose, onPress }: PopupImageModalProps) => {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const closedRef = useRef(false);

  const closeOnce = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  useEffect(() => {
    let mounted = true;
    Image.getSize(
      popup.imageUrl,
      (width, height) => {
        if (mounted && width > 0 && height > 0) {
          setAspectRatio(width / height);
        }
      },
      () => {
        if (mounted) setLoadFailed(true);
      }
    );
    return () => {
      mounted = false;
    };
  }, [popup.imageUrl]);

  useEffect(() => {
    if (visible && loadFailed) {
      closeOnce();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, loadFailed]);

  if (loadFailed) {
    return null;
  }

  const imageHeight = Math.min(CARD_WIDTH / aspectRatio, MAX_IMAGE_HEIGHT);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closeOnce}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Pressable
            accessibilityRole={popup.link ? 'link' : 'image'}
            accessibilityLabel={popup.title}
            onPress={popup.link ? onPress : undefined}
            disabled={!popup.link}
          >
            <Image
              source={{ uri: popup.imageUrl }}
              style={[styles.image, { width: CARD_WIDTH, height: imageHeight }]}
              resizeMode="contain"
              onLoadEnd={() => setIsLoading(false)}
              onError={() => setLoadFailed(true)}
            />
          </Pressable>
          {isLoading && (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#FFFFFF" />
            </View>
          )}
          <Pressable
            style={styles.closeButton}
            onPress={closeOnce}
            accessibilityRole="button"
            accessibilityLabel="Close pop-up"
            hitSlop={12}
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: 16,
    overflow: 'visible',
  },
  image: {
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: -14,
    right: -14,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  closeText: {
    fontSize: 16,
    color: '#1F2937',
    fontWeight: '600',
  },
});
```

(A plain `✕` glyph avoids touching the Monicon icon pipeline.)

- [ ] **Step 2: Write `index.ts`**

```ts
export { PopupImageModal } from './PopupImageModal';
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/popup/
git commit -m "feat(popups): PopupImageModal banner component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: App — wire pop-ups into `App.tsx` (queued behind trivia)

**Files:**
- Modify: `samplefinder-app/App.tsx`

**Interfaces:**
- Consumes: Task 8 (`getActivePopups`, `recordPopupClick`, `ActivePopup`), Task 9 (`PopupImageModal`), existing `resolveUserProfileIdForTrivia`, `getUserProfile`, `useAuthStore`, `AppState`, `isTriviaOfferedToday`, `triviaDayActive`.
- Produces: pop-ups display after trivia on launch/foreground.

- [ ] **Step 1: Add imports**

Add `Linking` to the existing `react-native` import (line 36 currently imports `AppState, AppStateStatus`):
```ts
import { AppState, AppStateStatus, Linking } from 'react-native';
```
Add below the trivia imports (near line 24–26):
```ts
import { PopupImageModal } from '@/components/popup';
import { getActivePopups, recordPopupClick } from '@/lib/database';
import type { ActivePopup } from '@/lib/database';
```
(Extend the existing `@/lib/database` import line instead of adding a duplicate import if the linter prefers.)

- [ ] **Step 2: Add pop-up state (next to the trivia state, inside `App()` before any effect)**

```ts
  /** Pop-up banner queue (SAM-5); shown one at a time, only while no trivia is pending. */
  const [popupQueue, setPopupQueue] = useState<ActivePopup[]>([]);
  const popupQueueRef = useRef(popupQueue);
  popupQueueRef.current = popupQueue;
  const popupFetchInFlightRef = useRef(false);
  const popupFetchedOnceRef = useRef(false);
  const currentPopup = popupQueue[0] ?? null;

  const mergePopupsIntoQueue = useCallback((incoming: ActivePopup[]) => {
    if (incoming.length === 0) return;
    setPopupQueue((prev) => {
      const seen = new Set(prev.map((p) => p.$id));
      const merged = [...prev];
      for (const p of incoming) {
        if (!seen.has(p.$id)) {
          merged.push(p);
          seen.add(p.$id);
        }
      }
      return merged;
    });
  }, []);
```

- [ ] **Step 3: Reset pop-up state on logout**

In the existing sign-out cleanup effect (the one that starts `if (authUser) return;` and clears trivia state, ~line 100–108), add two lines before its closing brace:
```ts
    setPopupQueue([]);
    popupFetchedOnceRef.current = false;
```

- [ ] **Step 4: Add the two fetch effects (before the `if (!appIsReady)` early return, next to the trivia effects)**

```ts
  // Fetch pop-up banners 8s after app is ready — 3s after the trivia fetch so
  // trivia (which has queue priority) surfaces first. Server-side day-dedup makes
  // repeat calls idempotent.
  useEffect(() => {
    if (!appIsReady || popupFetchedOnceRef.current) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || popupFetchInFlightRef.current) return;
      popupFetchInFlightRef.current = true;
      try {
        const user = useAuthStore.getState().user;
        if (cancelled || !user) return;
        const profile = await getUserProfile(user.$id);
        if (cancelled || !profile) return;
        const popups = await getActivePopups(profile.$id);
        if (cancelled) return;
        popupFetchedOnceRef.current = true;
        mergePopupsIntoQueue(popups);
      } catch (error) {
        if (!cancelled) console.error('[App] Failed to fetch popups:', error);
      } finally {
        popupFetchInFlightRef.current = false;
      }
    }, 8000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [appIsReady, mergePopupsIntoQueue]);

  // Refetch pop-ups on foreground (e.g. a new campaign day started while backgrounded).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      if (nextState !== 'active' || popupFetchInFlightRef.current) return;
      popupFetchInFlightRef.current = true;
      try {
        const user = useAuthStore.getState().user;
        if (!user) return;
        const profile = await getUserProfile(user.$id);
        if (!profile) return;
        mergePopupsIntoQueue(await getActivePopups(profile.$id));
      } catch (error) {
        console.error('[App] Failed to refetch popups on foreground:', error);
      } finally {
        popupFetchInFlightRef.current = false;
      }
    });

    return () => subscription.remove();
  }, [mergePopupsIntoQueue]);
```

- [ ] **Step 5: Add handlers (after the trivia handlers, below the early return)**

```ts
  const handlePopupClose = () => {
    setPopupQueue((prev) => prev.slice(1));
  };

  const handlePopupPress = async () => {
    const popup = popupQueueRef.current[0];
    if (!popup) return;
    if (popup.link) {
      const profileId = await resolveUserProfileIdForTrivia();
      if (profileId) {
        void recordPopupClick(profileId, popup.$id);
      }
      try {
        const supported = await Linking.canOpenURL(popup.link);
        if (supported) {
          await Linking.openURL(popup.link);
        } else {
          console.warn('[App] Cannot open popup link:', popup.link);
        }
      } catch (error) {
        console.warn('[App] Failed to open popup link:', error);
      }
    }
    handlePopupClose();
  };
```

- [ ] **Step 6: Render the modal (in the JSX, directly after the `TriviaModal` block)**

```tsx
          {authUser && currentPopup && (!triviaDayActive || !currentQuestion) && (
            <PopupImageModal
              key={currentPopup.$id}
              visible={true}
              popup={currentPopup}
              onClose={handlePopupClose}
              onPress={handlePopupPress}
            />
          )}
```
This keeps trivia priority: while a trivia question is pending on a trivia day, the pop-up waits; when the trivia queue empties (or it isn't a trivia day) the first pop-up appears.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add App.tsx
git commit -m "feat(popups): show scheduled pop-up banners after trivia on launch/foreground

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Deploy, end-to-end QA, review gates

**Files:** none (operations + verification).

- [ ] **Step 1: Push schema (if Task 1 Step 3 was deferred)**

From `samplefinder-admin/appwrite/`:
```bash
appwrite push tables --table-id popups --table-id popup_interactions
```
**Checkpoint:** requires `appwrite login`; ask the user if not authenticated.

- [ ] **Step 2: Deploy both functions**

From `samplefinder-admin/appwrite/`:
```bash
appwrite push functions --function-id 69308117000e7a96bcbb   # Mobile API
appwrite push functions --function-id 69341ffa001a4ebd28c2   # Statistics functions
```
Expected: both deployments become active. **Checkpoint:** same CLI-auth caveat; deployment to production is user-facing — confirm with the user before pushing if anything about the environment looks unusual.

- [ ] **Step 3: Manual QA matrix**

Admin (`npm run dev` in `samplefinder-admin/`):
1. Create a pop-up: image, title, link `https://example.com`, today→today, audience All, 21+ ON → appears as Active in the list; stat cards update.
2. Create a second pop-up with audience `Targeted` → your test user only; and a third with 21+ OFF, audience All.
3. Edit a pop-up: change end date to tomorrow and replace the image → saves; old image file is deleted from the bucket (check Appwrite console → Storage).
4. Details page shows `—`→zeros before any serves.

App (dev build, signed in as a 21+-verified test user whose profile is in the `Targeted` list):
5. Launch app → ~8s after ready, pop-up 1 appears (after trivia if it's a trivia day). Tap image → browser opens `https://example.com`; modal closes. Queue advances to pop-up 2, then 3.
6. Kill + relaunch app → no pop-ups re-shown (same app-TZ day).
7. Admin details for pop-up 1 → Impressions 1, Unique Users Shown 1, Unique Clickers 1, 21+ Clickers 1, CTR 100.0%; list shows Views 1 / Clicks 1.
8. Sign in as a NON-21+ user (or set `idAdult` false on a test profile): only the 21+ OFF pop-up appears.
9. Sign in as a user NOT in the `Targeted` list: pop-up 2 never appears.
10. No-link pop-up: tapping the image does nothing; only X closes it.
11. Create a pop-up with a broken imageUrl (edit the doc in Appwrite console): app must not show an empty modal (queue advances silently).
12. Tomorrow (or by editing `dayKey` rows): a multi-day pop-up re-shows once; clicking again does NOT increment unique Clicks a second time (Views does).

Record pass/fail for each numbered case; any failure blocks completion.

- [ ] **Step 4: Reviews and gates**

- Dispatch the workspace `senior-appwrite` agent with the admin-repo diff (schema + functions + call sites).
- Run `/pr-check` in `samplefinder-admin` (build, lint, parallel reviewers).
- Run `/app-check` for `samplefinder-app` (typecheck + senior-react-native + senior-typescript + senior-qa + senior-appwrite since the diff touches Appwrite call sites).
- Fix everything actionable; re-run gates until clean.

- [ ] **Step 5: Final commits and PRs**

Both repos: push branches `qudratillo/sam-5-pop-ups-in-the-application` and open PRs referencing SAM-5 (bodies end with the standard Claude Code attribution line). **Checkpoint:** confirm with the user before opening PRs if the repos' PR conventions are unclear.

---

## Plan Self-Review Notes

- **Spec coverage:** schema (Task 1), serve/click endpoints + 21+/audience/frequency rules (Task 2), stats (Task 3), admin data layer (Task 4), create/edit incl. image upload + audience UI (Task 5), list page + nav (Task 6), details stats page (Task 7), app data layer (Task 8), modal UI incl. broken-image behavior (Task 9), launch/foreground orchestration + trivia priority + link opening (Task 10), rollout + QA matrix + review gates (Task 11). Spec's "index on dayKey" intentionally dropped — recorded in Global Constraints with rationale.
- **Known judgment call an implementer may adjust with evidence:** the Appwrite CLI subcommand names vary by installed version (Tasks 1/11) — verify with `appwrite push --help` before running.
- **Type consistency:** `PopupFormPayload` produced in Task 5 = fields persisted by Task 6 handlers = `PopupDocument` columns (Task 1/4); `ActivePopup` (Task 8) = Task 2's `ActivePopupResponse`; `PopupDetailStatistics` (Task 4) = Task 3's `PopupDetailStats`.
