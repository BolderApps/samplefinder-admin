# Pop-up Image Ads (SAM-5) — Design

**Status: DRAFT — awaiting user review.** Items marked **[ASSUMPTION]** were decided without user input (user was away when clarifying questions were asked); each is independently reversible before implementation.

Linear: [SAM-5 "Pop-Ups in the application"](https://linear.app/bolder-builders/issue/SAM-5) — admin-configured pop-up images shown in the mobile app on certain days (e.g. advertisements); image + optional link that opens in the browser.

Additional requirements (from the requester, on top of the ticket):
- Report how many users clicked the link.
- Handle "users over 21".
- Target audience: same options as push notifications.

## Context: existing patterns this design mirrors

- **Trivia** is the established "pop-up on certain days" feature: `trivia` + `trivia_responses` tables, served through the **Mobile API** Appwrite Function (`/get-active-trivia`, `/submit-answer`, `/dismiss-trivia`) which filters by a `startDate`–`endDate` window and per-user dedup, and a **global modal in `App.tsx`** with a queue, launch/foreground triggers.
- **Notification targeting** (`notifications` table + `Notification functions`): `targetAudience` enum `All | NewUsers | BrandAmbassadors | Influencers | Tier1..Tier5 | ZipCode | Targeted` with companion fields `newUsersTimeRange`, `selectedZipCodes`, `selectedUserIds`, resolved against `user_profiles`.
- **Images**: admin uploads to the single storage bucket `files` (`6921b4ae002feef4b15e`) and stores the full `/view` URL string on the document (pattern of `clients.logoURL`, `events.discountImageURL`).
- **Age**: `user_profiles.idAdult` (boolean, required) is the existing 21+ attestation from signup's Age Verification modal and already gates adult (alcohol) categories in the app; `user_profiles.dob` (datetime) holds the birthdate.
- **No click tracking exists anywhere today** (notification open/click rates in Statistics are hardcoded placeholders).

## Goals

1. Admin can create/edit/delete pop-ups: banner image, optional link, schedule (which days), audience, 21+ gating.
2. The mobile app shows eligible pop-ups as a modal on the scheduled days; tapping the banner opens the link in the system browser.
3. Admin sees per-pop-up stats: impressions, unique users shown, unique users who clicked (total and 21+ split), CTR.

## Non-goals (v1)

- No push notification tied to pop-ups (they are in-app only).
- No brand/client association on a pop-up (easy later add, mirroring trivia's `client` relationship).
- No frequency capping beyond once/user/day, no A/B testing, no video/animated creatives, no daily-breakdown charts.
- No changes to how notifications themselves are targeted or sent.

## Decisions and assumptions

1. **[ASSUMPTION] 21+ is a per-pop-up display gate.** New boolean `only21Plus` (admin toggle, **default ON**). The server excludes ineligible users from serving. Eligibility: `idAdult === true` **AND** (`dob` absent **OR** computed age ≥ 21). Rationale: `idAdult` is the app's existing 21+ signal; the extra `dob` check prevents showing alcohol ads to a user whose stated birthdate contradicts their attestation. Additionally, every interaction row snapshots `is21Plus`, so stats can always report the 21+ split — this also covers the alternate reading of the requirement ("report clicks by 21+ users") even for non-gated pop-ups.
2. **[ASSUMPTION] Scheduling is a date range** (`startDate`–`endDate`), stored as full-day boundaries in the app timezone — exactly trivia's window mechanism, but allowing multi-day campaigns. A single-day pop-up is start = end.
3. **[ASSUMPTION] Frequency: once per user per active day.** A pop-up running Fri–Sun is shown to each eligible user once on each of those days. Dedup = one `popup_interactions` row per (popup, user, day), created at serve time.
4. **Audience mirrors notifications exactly** — same enum values and companion field names/types as the `notifications` table, so the admin UI section can be copied nearly verbatim. Evaluated **per-user at serve time** in the Mobile API (the inverse of notifications' send-time fan-out); every predicate reads fields already on `user_profiles` (`$createdAt`, `isAmbassador`, `isInfluencer`, `tierLevel`, `zipCode`, `$id`).
5. **Serving goes through the Mobile API function**, not direct client table reads — keeps targeting data (e.g. `selectedUserIds`) out of client queries and makes dedup + stats server-authoritative. House pattern (trivia).
6. **[ASSUMPTION] Trivia has priority.** On a day with both, trivia question(s) show first; pop-ups appear only when no trivia modal is pending.
7. **[ASSUMPTION] Multiple simultaneously-active pop-ups queue sequentially**, like trivia questions.
8. **Click semantics**: tapping the banner (only when a link is set) records the click, opens the browser via `Linking.openURL`, and closes the modal. `clicks` counts **unique clickers per pop-up** (a user clicking on two different days counts once).
9. **Counter semantics**: `views` on the doc = serve events (impressions, may count a user once per day); the list page shows Views and Clicks raw counters; the details page shows true unique-user stats and CTR (= unique clickers / unique users shown) computed from interaction rows by the Statistics function.

## Schema (two new tables, database `69217af50038b9005a61`)

### `popups`

Permissions: `create/read/update/delete("users")`, `rowSecurity: false` (house pattern, same as `trivia`).

| key | type | notes |
|---|---|---|
| `title` | string(200), required | internal label; also used as the image accessibility label |
| `imageUrl` | string(2000), required | full `/view` URL in the `files` bucket |
| `imageFileId` | string(100), required | for replacement/cleanup |
| `link` | string(2000) | optional; banner is clickable only when set |
| `startDate` | datetime, required | window start (00:00 app TZ) |
| `endDate` | datetime, required | window end (23:59 app TZ) |
| `only21Plus` | boolean, default `true` | display gate (decision 1) |
| `targetAudience` | enum `All, NewUsers, BrandAmbassadors, Influencers, Tier1, Tier2, Tier3, Tier4, Tier5, ZipCode, Targeted`, required | mirrors `notifications.targetAudience` |
| `selectedUserIds` | string(1000) array | for `Targeted` |
| `selectedZipCodes` | string(1000) array | for `ZipCode` |
| `newUsersTimeRange` | integer | days, for `NewUsers` (default 30 at evaluation) |
| `views` | integer, default 0 | serve events |
| `clicks` | integer, default 0 | unique clickers |

### `popup_interactions`

Permissions: `[]` (server-only, like `trivia_responses`), `rowSecurity: false`.

| key | type | notes |
|---|---|---|
| `popup` | relationship → `popups` (manyToOne, onDelete cascade) | |
| `user` | relationship → `user_profiles` (manyToOne, onDelete cascade) | |
| `dayKey` | string(10), required | `YYYY-MM-DD` in app timezone; per-day dedup key |
| `shownAt` | datetime, required | |
| `clicked` | boolean, default `false` | |
| `clickedAt` | datetime | |
| `is21Plus` | boolean, default `false` | snapshot of eligibility at serve time |

Indexes: none in v1 — no table in this project defines indexes, and `trivia_responses` is already queried by relationship + equality unindexed in production; add a `dayKey` index later only if serve latency demands it. (Queries filter by the `user` relationship exactly as `trivia_responses` is queried today.)

## Mobile API function — two new routes

In `samplefinder-admin/appwrite/functions/Mobile API/src/main.ts`, alongside the trivia routes.

### `POST /get-active-popups` — body `{ userId }` (user_profiles `$id`, same convention as trivia)

1. Load the user profile; 404 if missing.
2. Query `popups` where `startDate ≤ now ≤ endDate` (limit 100).
3. Query `popup_interactions` where `user == userId` and `dayKey == today(appTZ)` (limit 100).
4. Keep each popup only if: **(a)** no interaction row for it today; **(b)** audience predicate passes — `All` → true; `NewUsers` → `profile.$createdAt ≥ now − (newUsersTimeRange ?? 30) days`; `BrandAmbassadors` → `isAmbassador`; `Influencers` → `isInfluencer`; `TierN` → `tierLevel === map[N]` (same map as Notification functions); `ZipCode` → `selectedZipCodes` contains `profile.zipCode`; `Targeted` → `selectedUserIds` contains `profile.$id`; **(c)** if `only21Plus` → `is21Plus(profile)`.
5. For each popup that will be returned: create the interaction row `{popup, user, dayKey, shownAt, is21Plus}` and increment `popups.views`. Serving **is** the impression (same simplification trivia makes with `views`; the app displays everything it receives via the global modal queue).
6. Respond `{ success, popups: [{ $id, title, imageUrl, link }], count }` — targeting/counter fields stripped.

`is21Plus(profile)` = `profile.idAdult === true && (!profile.dob || ageInYears(profile.dob, now) >= 21)`.

### `POST /record-popup-click` — body `{ userId, popupId }`

1. Query one interaction row `(user, popup, clicked == true)` → `hadClickedBefore`.
2. Load today's row `(user, popup, dayKey == today)`; if present and not clicked, update `clicked = true, clickedAt = now`. If absent (edge: day rolled over while modal open), create it with `clicked = true` and `is21Plus` recomputed.
3. If `!hadClickedBefore`, increment `popups.clicks` (keeps `clicks` = unique clickers).
4. Respond `{ success }`.

Known accepted imprecision: two concurrent serve calls could rarely double-create a day row / double-increment `views` (client single-flight guard makes this unlikely; unique-user stats are computed from rows and dedup by user, so they stay correct).

## Statistics function — one new page

`POST /get-statistics` with `{ page: 'popups', popupId? }`: paginates `popup_interactions` (all rows for the popup, cursor-based) and aggregates in the function: `totalImpressions`, `uniqueUsersShown`, `uniqueClickers`, `clickers21Plus`, `ctr = uniqueClickers / uniqueUsersShown`. Used by the admin details page. (List page uses the cheap doc counters.)

## Admin UI (`samplefinder-admin`)

New page group `src/pages/Popups/`, mirroring `src/pages/Trivia/` structure:

- **`Popups.tsx`** — list: image thumbnail, title, schedule, audience summary, 21+ badge, derived status (Scheduled / Active / Completed from the window, like trivia), Views, Clicks; search; create/edit/delete.
- **`components/CreatePopupModal.tsx`** — image upload (required; to `files` bucket, then store view URL + file ID), title, optional link (URL-validated), start/end date pickers producing full-day windows via the existing app-timezone helpers (validate end ≥ start), **Audience section copied from `CreateNotificationModal.tsx`** (zip multi-select fed by `locationsService`, user search for `Targeted`, N-days input for `NewUsers`), "21+ only" toggle (default on).
- **`components/EditPopupModal.tsx`** — same fields prefilled; replacing the image deletes the old storage file after a successful save.
- **`PopupDetails.tsx`** — info card + stats from the Statistics function: impressions, unique users shown, unique clickers (total and 21+), CTR.
- Supporting `PopupsTable.tsx` / header / `index.ts` per the Trivia folder conventions.

Wiring: `PopupDocument` type + `popupsService` in `src/lib/services.ts` (collection ID constant alongside the existing ones), route + sidebar entry, delete flow also removes the storage file. Deleting a popup cascades its interaction rows.

## Mobile app (`samplefinder-app`)

- **`src/lib/database/popups.ts`** — `getActivePopups(profileId)`, `recordPopupClick(profileId, popupId)` via `functions.createExecution` against the Mobile API (mirror of `src/lib/database/trivia.ts`); types + re-export from `src/lib/database/index.ts`.
- **`src/components/popup/PopupImageModal.tsx`** — backdrop + banner card: image (aspect-fit, loading indicator; `onError` skips/advances the queue so a broken URL never shows an empty modal), close (X) button, tap on image (only when `link` present) → fire-and-forget `recordPopupClick`, `Linking.canOpenURL` → `openURL(link)`, close modal.
- **`App.tsx`** — `popupQueue` state next to the trivia state: fetch on app-ready for signed-in users and on foreground (`AppState`), mirroring the trivia effects but **without** the 60-second polling; render the first queued popup only when the trivia modal is not visible and the trivia queue is empty (decision 6); advance the queue on close; in-memory processed set + single-flight fetch guard for the session (server rows are the durable dedup).
- No client-side weekday gate (unlike trivia's Tuesday check): the date window is fully server-evaluated.

## Edge cases

- Signed-out users never see pop-ups (profile required, like trivia).
- No link → banner is not clickable; only X closes; no click stats accrue.
- Day boundaries (`dayKey`, windows) computed in the app timezone used by trivia scheduling (America/New_York helpers).
- Editing audience/dates mid-campaign affects only future serves; existing interaction rows are kept.
- A user who clicks on day 1 still sees the pop-up on day 2 (per-day frequency), but remains one unique clicker.
- `dob` missing on legacy accounts → 21+ gate falls back to `idAdult` alone.

## Security considerations

- `popups` is readable by any authenticated user at the table level (house pattern — same exposure class as `trivia`, whose `correctOptionIndex` is likewise table-readable today). Targeting lists on it are visible to a crafted client query. Accepted for v1 to stay consistent; recommend a follow-up hardening pass covering both tables.
- `popup_interactions` has empty permissions — user activity is never exposed to other users; admin reads go through the Statistics function.
- No server API keys in the mobile client; new routes validate the user like the trivia routes do.

## Testing (no test framework configured)

- `npm run typecheck` (app), `npm run build` + `npm run lint` (admin), `npm run build` in both touched functions.
- Manual QA matrix: each audience type; `only21Plus` on/off × (`idAdult` true/false × `dob` over/under 21/absent); no-link popup; multi-day reshow across a day boundary; trivia-Tuesday coexistence (order); unique-clicker counting across days; foreground refresh; signed-out user; broken image URL.
- Reviews at implementation time: `senior-appwrite`, `senior-react-native`, `senior-typescript`, `senior-qa`; gates: `/pr-check` (admin), `/app-check` (app).

## Rollout

1. `appwrite push` the two new tables (config-first in `appwrite.config.json`).
2. Deploy updated **Mobile API** and **Statistics** functions.
3. Deploy admin dashboard.
4. Mobile app release (server changes are backward-compatible; older clients simply never fetch pop-ups).

## Alternatives considered

- **Client-direct reads/writes** (checkins pattern; no function changes): rejected — exposes targeting lists to clients, client-mutable stats, weaker dedup.
- **Piggyback on the `notifications` table** (`type: 'Popup'`; audience columns already exist): rejected — muddles push semantics, notification list/stats UI, and the mobile app never reads that table today.
- **`dob`-only age check**: rejected as the sole signal (absent on legacy accounts); combined `idAdult` + `dob` check chosen.
