# Design — Pop-up delivery fix, in-app navigation, and per-user analytics

Follow-up to [SAM-5](https://linear.app/bolder-builders/issue/SAM-5), driven by client testing
feedback on staging (2026-09-10). Spans `samplefinder-admin` (Mobile API function, Statistics
function, admin UI) and `samplefinder-app` (pop-up modal).

Prior art: [`2026-07-02-popup-ads-design.md`](./2026-07-02-popup-ads-design.md),
[`2026-07-09-popup-enhancements-design.md`](./2026-07-09-popup-enhancements-design.md).

---

## Background — what the client hit

The client created five pop-ups in the staging admin panel and saw exactly one. Investigation
against staging (project `6a0ad92e0001d5e515ce`, db `69217af50038b9005a61`) found two
independent causes.

**Cause 1 — the 21+ gate (working as designed, bad test data).** Her profile
`6aa2e94f0028b82eb6e3` has `idAdult: true` but `dob: 2022-10-10`, so `isUser21Plus()` computes
age 3 and returns false. Three of her five pop-ups were `only21Plus: true` (the create form's
default), so they were filtered out. Both `popup_interactions` rows recorded `is21Plus: false`,
confirming it. No code defect — the test account's DOB is wrong.

**Cause 2 — impressions are burned at fetch time (real defect).** `getActivePopups()` writes a
`popup_interactions` row and increments `views` for *every eligible pop-up* at the moment the app
fetches, before anything reaches the screen. The app fetches 3s after launch and on every
foreground, then renders one at a time from an **in-memory** queue gated on `triviaChecked` and
the tier modals. Anything fetched but not displayed is silently consumed for the rest of the
Eastern day, and because the dedup is server-side it survives app restart, logout, and reinstall —
exactly the symptom reported. One of her pop-ups was consumed 7 seconds after she created it.

Secondary effect: `views` counts serves, not sightings, so reported impressions overstate reality.

---

## Scope

| # | Change | Where |
|---|---|---|
| 1 | Count an impression on display, not on fetch | Mobile API + app |
| 2 | In-app navigation to an event | schema + Mobile API + admin + app |
| 3 | Accept a bare domain in the link field | admin |
| 4 | Per-user interaction table on the pop-up detail page | Statistics function + admin |
| 5 | Correct the client's staging DOB | data only |

Explicitly out of scope: the signup DOB validation gap (a profile with a 2022 DOB exists although
signup blocks under-13). Noted, not chased here.

---

## 1. Serve protocol — impression on display

### Endpoints

`POST /get-active-popups` becomes **read-only** when the caller opts in. Gates are unchanged:
schedule window, not-already-viewed-today, 21+ eligibility, audience match.

`POST /record-popup-view` — new. Body `{ userId, popupId }`. Re-checks eligibility server-side
rather than trusting the client — schedule window, 21+, audience — then writes the
`popup_interactions` row for today's `dayKey` and increments `views`.

The already-viewed-today filter is deliberately *not* part of that check: it is the idempotency
key instead. If a row already exists for user+popup+day the call is a successful no-op, so a
re-render or double-fire cannot double-count. A pop-up that fails the *other* gates is rejected.

`POST /record-popup-click` — unchanged.

### Backward compatibility

Builds already in the field (including the client's current staging build) never call
`/record-popup-view`. If the fetch became unconditionally read-only, those builds would re-show
the same pop-up on every foreground forever.

So `/get-active-popups` accepts an optional `clientReportsViews: boolean`:

- `true` (new app builds) → read-only fetch, the full eligible list; the view is
  recorded by `/record-popup-view`.
- absent/false (existing builds) → still writes on fetch, but is handed **at most one**
  pop-up per call rather than the whole batch.

That cap is a deliberate addition, not the original plan. Those builds take an impression
for everything handed to them while rendering one at a time from an in-memory queue, so
returning the batch is precisely what burned the remainder of the day. One per fetch is
slower — the next foreground delivers the next — but nothing is silently lost, and it is
the only path the client's current install can take until a new build ships.

This keeps old builds correct and lets the backend deploy ahead of the app release, matching the
deployment posture already established for SAM-5.

### App side

`recordPopupView(userId, popupId)` in `src/lib/database/popups.ts`, fire-and-forget with the same
error posture as `recordPopupClick` (log, never throw — reporting must never block display).

`App.tsx` sends `clientReportsViews: true` and fires the report when the modal actually becomes
visible, guarded by a `Set` ref of already-reported ids so a re-render cannot re-fire.

The trigger belongs at the point the modal is really on screen, not where the queue head changes —
the render gate (`triviaChecked`, trivia question pending, tier modals) can hold a queued pop-up
back indefinitely, and that hold is precisely what must no longer count as a view.

---

## 2. In-app navigation

### Schema (additive)

Two optional columns on `popups`:

| Column | Type | Notes |
|---|---|---|
| `destinationType` | string (64) | `'external'` or `'event'` |
| `destinationEventId` | string (64) | set only when `destinationType === 'event'` |

Both optional with no default, so existing rows read as external + `link` and nothing breaks.
Created **directly against each project** rather than via `appwrite push tables`, which rewrites
existing column definitions (see the workspace notes on that hazard).

### Admin

A Destination radio in the shared `PopupFormFields`:

- **External website** — today's URL input, unchanged behaviour.
- **Event** — searchable dropdown with a selected-event chip, mirroring the existing user picker
  in `CreatePopupModal.tsx` (same input, dropdown, and `#1D0A74` chip styling) so the modal stays
  visually consistent.

Validation: event mode requires a selected event; external mode keeps the URL rule. Switching
modes clears the other mode's value so a stale event id or URL is never persisted.

### Mobile API

`ActivePopupResponse` gains `destinationType` and `destinationEventId`. The event id is only
emitted for event destinations.

### App

`handlePopupPress` routes on destination type:

- `event` with an id → `navigateToEventDetails(eventId)` (the helper push notifications already
  use: `MainTabs → Home → BrandDetails`), record the click, close the modal.
- otherwise → the existing `Linking.openURL` path.

Click recording stays fire-and-forget and must not block navigation.

---

## 3. Bare-domain links

A shared `normalizePopupLink(raw)` that prepends `https://` when the input has no scheme, applied
on blur (so the admin sees what will be saved) and again in the payload builder used by both
create and edit. `new URL()` validation runs after normalization. `www.` was never required — only
the scheme was — so this closes the actual gap the client reported.

---

## 4. Per-user analytics

`getPopupDetailStats` in the Statistics function already cursor-paginates `popup_interactions` to
compute the aggregate tiles. Extend it to also collect a `viewers` array:

```
{ userId, name, email, shownAt, clickedAt, is21Plus }
```

Profiles are resolved with the batched lookup already used elsewhere in the function rather than
per-row reads. Capped at 1000 rows with a `viewersTruncated` flag so a long-running campaign
cannot blow up the response.

`PopupDetails.tsx` renders a table under the existing stat tiles — User / Shown / Clicked, a
"Clicked only" filter, client-side pagination — styled to match the admin's other tables.

---

## 5. Data fix

Correct `dob` on staging profile `6aa2e94f0028b82eb6e3` and clear that account's stale
same-day `popup_interactions` rows so the client can retest immediately without waiting for the
Eastern day to roll over.

---

## Verification

Neither repo has a test framework, so verification is build-gates plus live staging exercise:

1. `npm run build` (admin, typechecks) and `npm run lint`; `npm run typecheck` (app); `npm run
   build` in both touched function directories.
2. Against staging via the Appwrite CLI, with fixture pop-ups:
   - a fetch with `clientReportsViews: true` writes **no** interaction row;
   - `/record-popup-view` writes exactly one row and bumps `views`; a second call is a no-op;
   - an un-viewed pop-up is still returned by the next fetch (the regression that started this);
   - a fetch *without* the flag still writes on fetch (old-build path intact);
   - the 21+ gate still excludes gated pop-ups for a non-21+ profile;
   - event-destination pop-ups round-trip `destinationType`/`destinationEventId`.
3. Review agents: `/pr-check` (admin) and `/app-check` (app).

Fixture rows created during verification are deleted afterwards.

## Risks

- **Live schema change on staging and production.** Additive optional columns only; no existing
  column is modified. Must not be applied with `push tables`.
- **Mobile release required.** None of the app-side behaviour reaches the client until a new
  staging build ships.
- **Old builds keep the old semantics** by design until users update — acceptable, and the
  alternative (unconditional read-only fetch) actively breaks them.
