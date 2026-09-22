# Design — Bulk location import with Google address validation

Implements [SAM-8](https://linear.app/bolder-builders/issue/SAM-8). Scoped to
`samplefinder-admin` only; no mobile app or Appwrite Function changes.

---

## Background — the manual bottleneck

The event CSV importer (`Dashboard.tsx` → `handleCSVUpload`) resolves a row's venue by taking the
`Location Name` column and looking for an **exact** name match in the `locations` table. When no
match exists it hard-fails the row:

```
Location "<name>" not found. Use an existing Location name from the admin panel.
```

Address and coordinates are read from the location record and never from the event CSV. So every
venue must exist before events referencing it can be imported — and the only way to create one is
`Locations` → "Add Location", one modal at a time, typing the address and dragging a map pin.
Onboarding a chain means hundreds of manual entries.

The client also wants addresses checked against Google as they come in, so that transcription
errors — a dropped `N`/`S` directional, a misspelling — surface before the data lands rather than
after an event is scheduled at the wrong address.

They were explicit that **location names must not be validated or rewritten**: their naming
convention is deliberate and differs from Google's listing names, e.g. `Vitamin Shoppe #60
Philadelphia`, `Total Wine & More #941 Vero Beach`.

---

## Scope

| # | Change | Where |
|---|---|---|
| 1 | CSV parse + structural validation for locations | `src/lib/locationImport/` |
| 2 | Duplicate detection (against the table and within the file) | `src/lib/locationImport/` |
| 3 | Google Geocoding validation with a concurrency pool | `src/lib/locationImport/` |
| 4 | Two-step import modal with a per-row review/correction table | `src/pages/Locations/components/` |
| 5 | "Bulk Import" entry point | `LocationsHeader.tsx`, `Locations.tsx` |
| 6 | Offline verification script | `scripts/verify-location-import.mjs` |

### Non-goals

- **The event CSV is untouched.** It keeps requiring pre-existing locations. Folding address
  columns into the event upload is a plausible follow-up (the client said it "may also" be
  needed) but is deliberately not in this spec: it would give the event importer a
  review/correction stage it does not have today, and a partially-failed event import that had
  already created locations is a materially harder failure mode. Decide it separately once this
  ships.
- **No location-name validation, normalization, or deduplication by fuzzy match.** Names pass
  through verbatim. Exact-name matching is used only to detect duplicates.
- **No edit/update of existing locations.** Import creates new rows only (see §4).
- **No change to `locations` table permissions.** The open `users`-role grant is a known, accepted
  decision and is out of scope here.

---

## Prerequisite — confirm whether `locations.location` is required

`appwrite.config.json` declares the `location` point column as `required: true`, but
`locationsService.create` passes `location: data.location || null`, which would be rejected
outright against a required column. The manual flow never exercises the null branch because
`LocationPicker` always produces coordinates. The committed config has drifted from live before,
so **verify against the live project, not the config file**, before implementation starts.

This is not cosmetic — it decides whether an unverifiable address can be imported at all:

- **If `location` is required** — a `failed` row (Google returned nothing) has no coordinates and
  therefore cannot be created. The only paths are *Edit until it resolves* or *Skip*. The review
  table must not offer a force-import action, because it would fail at write time.
- **If `location` is nullable** — `failed` rows may be imported with a null point and an explicit
  "no coordinates — will not appear on the map" warning in the review table.

Implement the required-column behaviour (the stricter branch) by default. If verification shows the
column is nullable, the nullable branch is a small additive change to `classifyRow` and one extra
action button.

---

## 1. CSV contract

Required columns, in template order:

| Column | Maps to | Notes |
|---|---|---|
| `Name` | `name` | Verbatim. Identity key for duplicate detection. |
| `Address` | `address` | Street address only, no city/state/zip. |
| `City` | `city` | |
| `State` | `state` | Two-letter code or full name; both accepted (see §2.3). |
| `Zip` | `zipCode` | 5-digit or ZIP+4. |

There are no optional columns. Header matching is case-insensitive and whitespace-tolerant, and
accepts `Zip Code` / `Zip` and `Location Name` / `Name` as aliases, mirroring how the event
importer normalizes headers.

Structural rejections, reported before any network call:

- missing required header → whole file rejected, naming the missing columns
- more than **1000 data rows** → whole file rejected (cost and runtime guard)
- a row with any required field blank → row marked `failed`, reason `Missing required field: <col>`

Step 1 of the modal offers a **Download Template** button producing a header row plus one
`[REPLACE WITH ...]` sample row, exactly as `CSVUploadModal` does today.

---

## 2. Pipeline

```
parse CSV
  → structural validation
  → duplicate detection        (no network)
  → geocode remaining rows     (≈8 concurrent)
  → classify
  → review table
  → commit
```

Duplicate detection runs **before** geocoding so that skipped rows never consume API quota. On a
re-upload of a mostly-already-imported sheet — the common case after correcting a few rows — this
is the difference between a handful of calls and several hundred.

### 2.1 Duplicate detection

Page the `locations` table for names only (`Query.select(['name'])`, `Query.limit(100)`, cursor
pagination) and build a `Set` of names normalized by trim + case-fold. A row is `duplicate` if:

- its normalized name is already in the table, **or**
- its normalized name appeared in an earlier row of the same file

The second case matters more than it looks. Two rows naming the same store would create two
records with the same name, and the event importer's exact-name lookup would then silently bind
events to whichever one it happened to read first.

### 2.2 Geocoding

One request per row against the Geocoding REST API, the same endpoint `LocationPicker.tsx`
already calls from the browser:

```
GET https://maps.googleapis.com/maps/api/geocode/json
    ?address=<urlencoded "Address, City, State Zip">
    &components=country:US
    &key=<key>
```

Run through a promise pool with **8 in flight**. Transient `UNKNOWN_ERROR` responses retry twice
with exponential backoff (250ms, 1s).

Batch-fatal statuses stop the run immediately and surface a single clear message rather than
marking every row `failed`:

| Status | Handling |
|---|---|
| `OVER_QUERY_LIMIT` | abort batch — "Google Maps quota exceeded. Try again later." |
| `REQUEST_DENIED` | abort batch — "Google Maps rejected the request. Check the API key." |
| `ZERO_RESULTS` | per-row `failed` |
| `INVALID_REQUEST` | per-row `failed` |

Rows already classified when an abort happens are discarded; nothing has been written, so the
operator simply retries the file.

### 2.3 Address comparison

Google's `address_components` are reassembled into street (`street_number` + `route`), city
(`locality`), state (`administrative_area_level_1`) and zip (`postal_code`), then compared against
the typed values after normalization:

- uppercase, collapse internal whitespace, strip trailing punctuation
- normalize street-type suffixes: `STREET`→`ST`, `AVENUE`→`AVE`, `ROAD`→`RD`, `BOULEVARD`→`BLVD`,
  `DRIVE`→`DR`, `LANE`→`LN`, `COURT`→`CT`, `PARKWAY`→`PKWY`, `HIGHWAY`→`HWY`, `SUITE`→`STE`
- **directional word forms fold to their abbreviation** (`NORTH`→`N`, `SOUTH`→`S`, `EAST`→`E`,
  `WEST`→`W`, `NORTHEAST`→`NE`, …), but a directional is **never added or removed**

That last rule is the point of the feature, and the distinction is exact: folding `NORTH`→`N`
keeps `North Broad St` from being flagged against Google's `N Broad St`, because that is a
spelling style difference and not an error. Dropping the token entirely is a different thing, so
`1650 Broad St` vs `1650 S Broad St` — the client's own example — still surfaces for review.
Normalizing suffixes likewise keeps `1650 S Broad Street` from being flagged against
`1650 S Broad St`.

Zip comparison uses the first 5 digits, so a typed ZIP+4 matches Google's 5-digit answer.

**State matches against either form.** A typed value equal to Google's `short_name` (`PA`) *or*
its `long_name` (`Pennsylvania`) compares equal; only a genuinely different state is flagged.

**Which spelling gets stored** is decided by `resolveStateForWrite`, and it depends on whether the
two names denote the same state:

- **They agree** (typed `PA`, or `Pennsylvania`, against Google's `Pennsylvania`) → the
  **`long_name` is stored**. `AddressAutocomplete.tsx` and `LocationPicker.tsx` both persist
  `long_name` today, so imported records must match or the `locations` table ends up holding two
  spellings of the same state and name-independent filtering gets unreliable. This applies to a
  clean `ready` row too, not only to one that adopted Google's answer — otherwise a tidy CSV
  typing `PA` would quietly seed the second spelling.
- **They differ** (typed `New Jersey`, Google `Pennsylvania`) → the row is flagged `review`, and if
  the operator resolves it with **Keep mine** the **typed value is stored unchanged**. A state the
  operator looked at and chose to keep is the correction this review step exists to collect;
  overwriting it with Google's would discard the very answer we stopped to ask for.

---

## 3. Classification

| Status | Condition |
|---|---|
| `ready` | `status: OK`, not `partial_match`, `location_type` is `ROOFTOP` or `RANGE_INTERPOLATED`, and street/city/state/zip all compare equal |
| `review` | `status: OK` but any of: `partial_match: true`, `location_type` is `GEOMETRIC_CENTER` or `APPROXIMATE`, or any component differs |
| `failed` | `ZERO_RESULTS`, `INVALID_REQUEST`, or a missing required field |
| `duplicate` | name collides with the table or an earlier row in the file |

Coordinates are stored as `[longitude, latitude]`, matching the existing convention documented on
`locationsService`.

---

## 4. Review step

Rows are grouped by status with a count summary at the top
(`✅ 71 ready · ⚠️ 9 need review · ❌ 4 failed · ℹ️ 4 duplicates`). `ready` rows are collapsed by
default; `review` and `failed` are expanded.

| Status | Actions | Effect |
|---|---|---|
| `review` | **Use Google** | adopt Google's street/city/state/zip **and** coordinates → `ready` |
| | **Keep mine** | keep the typed address *including its state*, adopt Google's coordinates → `ready` |
| | **Edit** | inline edit of the four address fields → re-geocode that row → reclassify |
| | **Skip** | excluded from import |
| `failed` | **Edit**, **Skip** | edit re-geocodes and reclassifies |
| `duplicate` | **Skip** (fixed) | shown with the existing record's address for context |

**"Keep mine" keeps the typed street string but takes Google's coordinates.** The client sometimes
knows better than Google about the address text; they never know better about the lat/lng, and a
location without a correct pin is broken on the mobile map.

**`Name` is not editable in the review step.** Only the four address fields can be edited. A
`duplicate` row therefore cannot be resolved by renaming it in place — the operator fixes the name
in the source CSV and re-uploads, which is safe because duplicates are skipped rather than
updated. This keeps the name strictly a pass-through value, as the client required.

**A row rejected for a blank `Name` is therefore unfixable in review**, and is not offered an
**Edit** action at all. Editing only the address fields must never clear that rejection
(`applyAddressEdit` preserves it): a row that reached `ready` with an empty name would write a
nameless record — the exact junk this feature exists to keep out, and one the event importer's
exact-name lookup could never resolve. The operator is sent back to the CSV, which is the only
place the name can be supplied.

The primary button reads `Import N locations`, where N is the live count of `ready` rows. It is
disabled at N = 0.

Nothing is written to Appwrite until that button is pressed. Closing the modal discards everything.

---

## 5. Commit

`ready` rows are created via `locationsService.create` with a concurrency of 4. Per-row write
failures do not abort the batch: the row stays in the table annotated with its error, and the rest
proceed. On completion the modal shows a summary (`Imported 80 · 4 skipped · 0 failed`), fires the
existing notification store, and refreshes the locations list.

Because duplicates are skipped rather than updated, re-uploading a corrected sheet is safe and
idempotent — the rows that already landed are recognized and skipped.

---

## 6. Module layout

Logic lives in pure modules; the page components stay thin.

```
src/lib/locationImport/
  types.ts               ImportRow, RowStatus, GeocodeOutcome, ClassifiedRow
  parseLocationsCsv.ts   quote-aware parser, header normalization, structural validation
  normalizeAddress.ts    comparison normalization (suffixes yes, directionals no);
                         resolveStateForWrite picks the stored state spelling
  findDuplicates.ts      name collisions against the table and within the file
  geocodeAddress.ts      single Google call + response mapping
  classifyAll.ts         concurrency pool, retry, batch-abort semantics
  classifyRow.ts         ready | review | failed decision;
                         applyAddressEdit folds an inline edit back into a row
  index.ts

src/pages/Locations/components/
  ImportLocationsModal.tsx   two-step shell; step 1 = file select + template
  ImportReviewTable.tsx      step 2, grouping and summary
  ImportRowCard.tsx          one row, its diff, and its actions
```

The event importer keeps its parser inline in `Dashboard.tsx`; this spec does not refactor it.
The new parser is written fresh rather than extracted from it, because the event importer's
version is coupled to event-specific header normalization and changing it would put a working
client-facing import at risk for no benefit to SAM-8.

`LocationsHeader.tsx` gains a secondary "Bulk Import" button beside "Add Location".
`Locations.tsx` owns the modal's open state and the commit loop.

---

## 7. Security note (pre-existing, not introduced here)

The Google Maps API key is hardcoded in `src/components/AddressAutocomplete.tsx:4` and
`src/components/LocationPicker.tsx:21`, and is present in git history (commit `88b3279`). It ships
in the Vite bundle, so it is already public.

This feature does not change that exposure — it reuses the same key from the same place — but it
does raise the value of abusing it, since bulk geocoding is a billable path. Recommended
separately, not as part of SAM-8: rotate the key, apply HTTP-referrer restrictions and an API
restriction limited to Geocoding + Places, and move it to `VITE_GOOGLE_MAPS_API_KEY`.

Cost for this feature at current rates: Geocoding is ~$5 per 1000 requests, so a 500-row import is
roughly $2.50, less whatever duplicate detection skips.

---

## 8. Verification

No test framework is configured in either project, so verification follows the repo's existing
`scripts/verify-*.mjs` idiom.

`scripts/verify-location-import.mjs` exercises the pure modules against fixtures with **no network
access**, using recorded Geocoding JSON responses:

| Case | Expected |
|---|---|
| clean row, exact Google match | `ready` |
| `1650 Broad St` vs Google `1650 S Broad St` | `review`, diff shows the missing `S` |
| `1650 S Broad Street` vs Google `1650 S Broad St` | `ready` (suffix normalized) |
| typed ZIP+4 vs Google 5-digit | `ready` |
| typed `PA` vs Google `Pennsylvania` | `ready` |
| typed `Pennsylvania` vs Google `Pennsylvania` | `ready` |
| adopting Google's answer stores `Pennsylvania`, not `PA` | asserted |
| a clean row typed `PA` also stores `Pennsylvania` | asserted |
| **Keep mine** on a state diff stores the typed state, not Google's | asserted |
| typed `NJ` vs Google `Pennsylvania` | `review` |
| editing the address cannot clear a blank-`Name` rejection | `failed` |
| a whitespace-only name still counts as blank | `failed` |
| typed `North Broad St` vs Google `N Broad St` | `ready` (directional folded, not dropped) |
| typed `Broad St` vs Google `N Broad St` | `review` (directional missing) |
| `partial_match: true` | `review` |
| `location_type: APPROXIMATE` | `review` |
| `ZERO_RESULTS` | `failed` |
| name already in table | `duplicate`, not geocoded |
| same name twice in one file | second row `duplicate` |
| blank required field | `failed`, no geocode |
| missing header | file rejected |
| 1001 rows | file rejected |
| `OVER_QUERY_LIMIT` mid-batch | batch aborts, nothing classified |

Plus `npm run build` (typechecks via `tsc -b`), `npm run lint`, a manual QA pass on a real ~50-row
CSV against staging, and `/pr-check` before merge.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| `locations.location` required-ness unknown | Blocking prerequisite; both branches specified above |
| Comparison too noisy → every row lands in `review` | Suffix normalization + 5-digit zip compare; the verify script's fixtures are the regression net |
| Geocoding cost or quota surprise | 1000-row cap, duplicates skipped before the API, batch-abort on `OVER_QUERY_LIMIT` |
| Browser rate-limiting on large files | 8-way concurrency with backoff; revisit as an Appwrite Function if imports outgrow it |
| Public API key abused | Pre-existing; rotation + restriction recommended separately (§7) |
| Duplicate names still reachable via the manual Add Location modal | Out of scope; the importer does not make it worse |

---

## 10. Rollout

Admin-only, client-side change. No schema migration, no Appwrite Function deploy, no mobile
release. Ships with a normal admin deploy; verify against staging with a real client CSV before
production.
