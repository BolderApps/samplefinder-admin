# Bulk Location Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CSV bulk importer to the admin Locations page that validates every address against Google Maps and lets the operator correct mismatches before anything is written.

**Architecture:** Pure logic modules under `src/lib/locationImport/` (parse → duplicate-detect → geocode → classify), consumed by a two-step modal under `src/pages/Locations/components/`. Nothing touches Appwrite until the operator presses Import. Geocoding runs in the browser behind an injected function interface, so the whole pipeline is testable offline.

**Tech Stack:** React 19, TypeScript strict, Tailwind 4, Vite, Appwrite Web SDK, Google Geocoding REST API. Verification via the repo's existing `tsc`-to-temp-dir + `node scripts/verify-*.mjs` harness.

**Spec:** [`docs/superpowers/specs/2026-09-22-bulk-location-import-design.md`](../specs/2026-09-22-bulk-location-import-design.md)

## Global Constraints

- **Run all commands from `samplefinder-admin/`.** This is a sibling repo in a workspace; there is no root `package.json`.
- **TypeScript strict.** No `any`. `npm run build` runs `tsc -b` and must stay green.
- **Location names are never validated, normalized, or rewritten.** Names are used only as an identity key for duplicate detection (trim + case-fold).
- **State is stored as Google's `long_name`** (`Pennsylvania`, not `PA`) to match what `AddressAutocomplete.tsx:272` and `LocationPicker.tsx:178` already persist.
- **Coordinates are `[longitude, latitude]`** — the order documented on `locationsService`.
- **Row cap: 1000** data rows per file.
- **Geocoding concurrency: 8**, with 2 retries on `UNKNOWN_ERROR` at 250ms then 1000ms.
- **Nothing is written to Appwrite before the operator presses Import.**
- **Appwrite SDK style:** object-based function signatures, never positional.
- **Do not modify the event importer** (`src/pages/Dashboard/Dashboard.tsx`) or `CSVUploadModal.tsx`.
- **Commit after every task.** Branch is `feature/SAM-8/location-bulk-import`.

## Blocking prerequisite (do this before Task 7)

Confirm whether `locations.location` is required in the **live** Appwrite project. `appwrite.config.json` says `required: true`; `locationsService.create` passes `location: data.location || null`, which contradicts it. Tasks 1–6 are unaffected. Task 7's review UI depends on the answer:

- **required** (assume this) → a `failed` row can never be imported; offer only Edit and Skip.
- **nullable** → additionally offer "Import without coordinates" on `failed` rows, with a visible warning that the location will not appear on the mobile map.

Build the **required** behaviour. If verification says nullable, that is an additive follow-up, not a rewrite.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/locationImport/types.ts` | Shared types only. No logic. |
| `src/lib/locationImport/parseLocationsCsv.ts` | CSV text → rows + file-level rejection |
| `src/lib/locationImport/normalizeAddress.ts` | Comparison normalization and field diffing |
| `src/lib/locationImport/findDuplicates.ts` | Name collisions against the table and within the file |
| `src/lib/locationImport/geocodeAddress.ts` | Google query building, response mapping, live geocoder factory |
| `src/lib/locationImport/classifyRow.ts` | One row + one geocode outcome → status |
| `src/lib/locationImport/classifyAll.ts` | Pipeline orchestration + concurrency pool + batch abort |
| `src/lib/locationImport/index.ts` | Barrel export |
| `scripts/verify-location-import.mjs` | Offline assertions over the modules above |
| `src/lib/googleMapsKey.ts` | The one place the public Maps key is written down |
| `src/pages/Locations/components/ImportRowCard.tsx` | One review row: status, diff, actions |
| `src/pages/Locations/components/ImportReviewTable.tsx` | Grouping, counts, summary |
| `src/pages/Locations/components/ImportLocationsModal.tsx` | Two-step shell, file select, template |
| `src/pages/Locations/components/LocationsHeader.tsx` | *(modify)* adds the Bulk Import button |
| `src/pages/Locations/Locations.tsx` | *(modify)* modal state + commit loop |

---

### Task 1: Types, CSV parsing, and the verification harness

**Files:**
- Create: `src/lib/locationImport/types.ts`
- Create: `src/lib/locationImport/parseLocationsCsv.ts`
- Create: `scripts/verify-location-import.mjs`
- Modify: `package.json` (add `verify:location-import`, chain into `verify`)
- Modify: `.gitignore` (ignore `scripts/.licheck/`)

**Interfaces:**
- Consumes: nothing
- Produces: `ImportField`, `ParsedRow`, `ParseResult`, `AddressFields`, `ExistingLocation`, `GeocodeMatch`, `GeocodeOutcome`, `FieldDiff`, `RowStatus`, `ClassifiedRow`, `FetchLike` (all from `types.ts`); `parseLocationsCsv(text: string): ParseResult`

- [ ] **Step 1: Create the types module**

`src/lib/locationImport/types.ts`:

```ts
/** The five columns an import CSV carries. */
export type ImportField = 'name' | 'address' | 'city' | 'state' | 'zipCode'

export interface AddressFields {
  address: string
  city: string
  state: string
  zipCode: string
}

/** One data row as read from the file, before any network call. */
export interface ParsedRow extends AddressFields {
  /** 1-based index among data rows, excluding the header. Shown to the operator. */
  rowNumber: number
  name: string
  /** Non-null when a required field was blank; such a row is never geocoded. */
  parseError: string | null
}

export interface ParseResult {
  rows: ParsedRow[]
  /** Non-null means the whole file was rejected and `rows` is empty. */
  fileError: string | null
}

/** An existing location, used only for duplicate detection. */
export interface ExistingLocation extends AddressFields {
  name: string
}

/** Google's answer, flattened to the fields we care about. */
export interface GeocodeMatch extends AddressFields {
  /** administrative_area_level_1 long_name, e.g. "Pennsylvania" — this is what we store. */
  state: string
  /** administrative_area_level_1 short_name, e.g. "PA" — accepted on input, never stored. */
  stateShort: string
  longitude: number
  latitude: number
  partialMatch: boolean
  /** ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE */
  locationType: string
}

export type GeocodeOutcome =
  | { kind: 'match'; match: GeocodeMatch }
  /** ZERO_RESULTS or INVALID_REQUEST — this row failed, the batch continues. */
  | { kind: 'none' }
  /**
   * UNKNOWN_ERROR — Google's "try again" status. Resolved inside
   * createGoogleGeocoder by retrying; it never escapes to classifyRow.
   */
  | { kind: 'retry' }
  /** OVER_QUERY_LIMIT or REQUEST_DENIED — the whole batch stops. */
  | { kind: 'abort'; reason: string }

export interface FieldDiff {
  field: keyof AddressFields
  typed: string
  google: string
}

export type RowStatus = 'ready' | 'review' | 'failed' | 'duplicate'

export interface ClassifiedRow extends ParsedRow {
  status: RowStatus
  /** Operator-facing explanation; null when status is 'ready'. */
  reason: string | null
  match: GeocodeMatch | null
  diff: FieldDiff[]
  /**
   * For duplicates: the colliding record's address, or null when the collision
   * is with an earlier row in the same file.
   */
  existing: AddressFields | null
}

/**
 * Minimal fetch shape. Declared locally rather than using the DOM/node `fetch`
 * type so the standalone `tsc` used by the verify script needs no extra libs.
 */
export type FetchLike = (url: string) => Promise<{ json: () => Promise<unknown> }>
```

- [ ] **Step 2: Write the failing assertions**

`scripts/verify-location-import.mjs`:

```js
// Verification for the bulk location importer (src/lib/locationImport/).
//
// Run with:  npm run verify:location-import
//
// Backs SAM-8. The assertions pin the decisions a careless refactor would silently
// break: that a dropped N/S directional is flagged while a spelled-out one is not,
// that duplicates are caught both against the table AND within a single file, and
// that a quota error stops the batch instead of marking every row failed.
//
// Compiled to CommonJS because the modules import each other; tsc emits extensionless
// relative imports that ESM cannot resolve but require() can.
//
// Exits non-zero on any failed assertion.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { parseLocationsCsv } = require('./.licheck/parseLocationsCsv.js')

let failures = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${label}: expected ${e}, got ${a}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

const HEADER = 'Name,Address,City,State,Zip'

// --- parseLocationsCsv -------------------------------------------------------

eq('parses a clean row',
  parseLocationsCsv(`${HEADER}\nVitamin Shoppe #60,1650 S Broad St,Philadelphia,PA,19145`).rows,
  [{ rowNumber: 1, name: 'Vitamin Shoppe #60', address: '1650 S Broad St',
     city: 'Philadelphia', state: 'PA', zipCode: '19145', parseError: null }])

eq('accepts header aliases and any casing',
  parseLocationsCsv('location name,Street Address,CITY,State,Zip Code\nA,1 Main St,Phila,PA,19145')
    .rows[0].address,
  '1 Main St')

eq('rejects the file when a required column is missing',
  parseLocationsCsv('Name,City,State,Zip\nA,Phila,PA,19145').fileError,
  'Missing required column(s): Address')

eq('rejects a file with no data rows',
  parseLocationsCsv(HEADER).fileError,
  'CSV must have a header row and at least one data row')

eq('rejects a file over the 1000 row cap',
  parseLocationsCsv(`${HEADER}\n` + Array.from({ length: 1001 },
    (_, i) => `N${i},1 Main St,Phila,PA,19145`).join('\n')).fileError,
  'CSV has 1001 rows; the limit is 1000 per import')

eq('marks a row with a blank required field, keeping it in the list',
  parseLocationsCsv(`${HEADER}\nA,,Philadelphia,PA,19145`).rows[0].parseError,
  'Missing required field: Address')

eq('a quoted field may contain a comma',
  parseLocationsCsv(`${HEADER}\n"Total Wine & More #941, Vero Beach",1 Main St,Vero Beach,FL,32966`)
    .rows[0].name,
  'Total Wine & More #941, Vero Beach')

eq('a doubled quote inside a quoted field is one literal quote',
  parseLocationsCsv(`${HEADER}\n"The ""Big"" Store",1 Main St,Phila,PA,19145`).rows[0].name,
  'The "Big" Store')

eq('CRLF line endings are tolerated',
  parseLocationsCsv(`${HEADER}\r\nA,1 Main St,Phila,PA,19145\r\n`).rows.length,
  1)

eq('blank lines are skipped and do not consume a row number',
  parseLocationsCsv(`${HEADER}\n\nA,1 Main St,Phila,PA,19145\n\nB,2 Main St,Phila,PA,19146\n`)
    .rows.map((r) => [r.rowNumber, r.name]),
  [[1, 'A'], [2, 'B']])

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll location import assertions passed')
```

- [ ] **Step 3: Wire the npm script and gitignore**

Add to `.gitignore` (after the existing `scripts/.pvcheck/` entry):

```
# transient tsc output for scripts/verify-location-import.mjs
scripts/.licheck/
```

Add to `package.json` `scripts`, immediately after `verify:popup-viewers`:

```json
"verify:location-import": "tsc src/lib/locationImport/*.ts --outDir scripts/.licheck --target es2020 --module commonjs --skipLibCheck && node -e \"require('fs').writeFileSync('scripts/.licheck/package.json','{\\\"type\\\": \\\"commonjs\\\"}')\" && node scripts/verify-location-import.mjs",
```

And extend the aggregate `verify` script to end with ` && npm run verify:location-import`.

> The `tsc` input is a **glob**, deliberately unlike the existing `verify:*` scripts which name their inputs. Those compile two or three files from a shared `src/lib`; this one owns a whole directory, and every task from 2 to 6 adds a module to it. Naming the files would mean editing `package.json` in six separate tasks and would break Task 1, whose directory holds only two of them. The shell expands the glob before `tsc` sees it, so the command is correct at every stage.

- [ ] **Step 4: Run the assertions to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/parseLocationsCsv.js'`

- [ ] **Step 5: Implement the parser**

`src/lib/locationImport/parseLocationsCsv.ts`:

```ts
import type { ImportField, ParsedRow, ParseResult } from './types'

const MAX_ROWS = 1000

const REQUIRED_FIELDS: ImportField[] = ['name', 'address', 'city', 'state', 'zipCode']

const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Name',
  address: 'Address',
  city: 'City',
  state: 'State',
  zipCode: 'Zip',
}

const HEADER_ALIASES: Record<string, ImportField> = {
  'name': 'name',
  'location name': 'name',
  'address': 'address',
  'street': 'address',
  'street address': 'address',
  'city': 'city',
  'state': 'state',
  'zip': 'zipCode',
  'zip code': 'zipCode',
  'zipcode': 'zipCode',
  'postal code': 'zipCode',
}

/**
 * Split one CSV line, honouring quoted fields and doubled-quote escapes.
 * The event importer's parser toggles on every quote and so mishandles `""`;
 * this one is written correctly rather than copied.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out.map((value) => value.trim())
}

export function parseLocationsCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) {
    return { rows: [], fileError: 'CSV must have a header row and at least one data row' }
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim())
  const columnField = new Map<number, ImportField>()
  headers.forEach((header, index) => {
    const field = HEADER_ALIASES[header]
    if (field !== undefined && !Array.from(columnField.values()).includes(field)) {
      columnField.set(index, field)
    }
  })

  const present = new Set(columnField.values())
  const missing = REQUIRED_FIELDS.filter((field) => !present.has(field))
  if (missing.length > 0) {
    return {
      rows: [],
      fileError: `Missing required column(s): ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`,
    }
  }

  const dataLines = lines.slice(1)
  if (dataLines.length > MAX_ROWS) {
    return {
      rows: [],
      fileError: `CSV has ${dataLines.length} rows; the limit is ${MAX_ROWS} per import`,
    }
  }

  const rows: ParsedRow[] = dataLines.map((line, index) => {
    const values = splitCsvLine(line)
    const row: ParsedRow = {
      rowNumber: index + 1,
      name: '',
      address: '',
      city: '',
      state: '',
      zipCode: '',
      parseError: null,
    }
    columnField.forEach((field, columnIndex) => {
      row[field] = values[columnIndex] ?? ''
    })
    const blank = REQUIRED_FIELDS.find((field) => row[field].trim() === '')
    if (blank !== undefined) {
      row.parseError = `Missing required field: ${FIELD_LABELS[blank]}`
    }
    return row
  })

  return { rows, fileError: null }
}
```

- [ ] **Step 6: Run the assertions to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS — 10 `ok` lines, then `All location import assertions passed`

- [ ] **Step 7: Commit**

```bash
git add src/lib/locationImport/types.ts src/lib/locationImport/parseLocationsCsv.ts \
        scripts/verify-location-import.mjs package.json .gitignore
git commit -m "feat(locations): parse and structurally validate an import CSV (SAM-8)"
```

---

### Task 2: Address comparison

**Files:**
- Create: `src/lib/locationImport/normalizeAddress.ts`
- Modify: `scripts/verify-location-import.mjs`

**Interfaces:**
- Consumes: `AddressFields`, `FieldDiff`, `GeocodeMatch`, `ParsedRow` from `./types`
- Produces: `normalizeForCompare(value: string): string`, `statesMatch(typed: string, match: GeocodeMatch): boolean`, `zipsMatch(typed: string, google: string): boolean`, `diffAddress(row: ParsedRow, match: GeocodeMatch): FieldDiff[]`

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/verify-location-import.mjs`, immediately before the `if (failures > 0)` block. Also add the require at the top, beside the existing one:

```js
const { normalizeForCompare, statesMatch, zipsMatch, diffAddress } =
  require('./.licheck/normalizeAddress.js')
```

```js
// --- normalizeAddress --------------------------------------------------------

eq('street suffixes fold to their abbreviation',
  normalizeForCompare('1650 S Broad Street'), '1650 S BROAD ST')

eq('directional words fold to their abbreviation',
  normalizeForCompare('1650 North Broad St'), '1650 N BROAD ST')

eq('a spelled-out directional matches an abbreviated one',
  normalizeForCompare('1650 North Broad Street') === normalizeForCompare('1650 S Broad St'),
  false)

eq('North Broad St and N Broad St compare equal',
  normalizeForCompare('1650 North Broad Street') === normalizeForCompare('1650 N Broad St'),
  true)

eq('a MISSING directional does NOT compare equal — the client’s own example',
  normalizeForCompare('1650 Broad St') === normalizeForCompare('1650 S Broad St'),
  false)

eq('punctuation and repeated whitespace are ignored',
  normalizeForCompare('  1650  S. Broad St.  '), '1650 S BROAD ST')

eq('state matches Google’s short name',
  statesMatch('PA', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('state matches Google’s long name',
  statesMatch('Pennsylvania', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('state casing is ignored',
  statesMatch('pennsylvania', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('a genuinely different state does not match',
  statesMatch('NJ', { state: 'Pennsylvania', stateShort: 'PA' }), false)

eq('ZIP+4 matches Google’s 5 digits', zipsMatch('19145-1234', '19145'), true)
eq('a different zip does not match', zipsMatch('19146', '19145'), false)

eq('diffAddress reports only the fields that differ',
  diffAddress(
    { address: '1650 Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' },
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'Pennsylvania',
      stateShort: 'PA', zipCode: '19145' }),
  [{ field: 'address', typed: '1650 Broad St', google: '1650 S Broad St' }])

eq('diffAddress is empty when everything agrees',
  diffAddress(
    { address: '1650 S Broad Street', city: 'Philadelphia', state: 'Pennsylvania', zipCode: '19145-9999' },
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'Pennsylvania',
      stateShort: 'PA', zipCode: '19145' }),
  [])
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/normalizeAddress.js'`

- [ ] **Step 3: Implement**

`src/lib/locationImport/normalizeAddress.ts`:

```ts
import type { AddressFields, FieldDiff, GeocodeMatch, ParsedRow } from './types'

/**
 * Long form → abbreviation. Street suffixes AND directional words are folded,
 * because both are spelling style rather than meaning. A directional is never
 * added or removed, so an omitted "S" still shows up as a difference — which is
 * precisely the error SAM-8 exists to catch.
 */
const TOKEN_ALIASES: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR',
  LANE: 'LN', COURT: 'CT', PARKWAY: 'PKWY', HIGHWAY: 'HWY', SUITE: 'STE',
  PLACE: 'PL', TERRACE: 'TER', CIRCLE: 'CIR', TRAIL: 'TRL', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
}

export function normalizeForCompare(value: string): string {
  return value
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .join(' ')
}

export function statesMatch(
  typed: string,
  match: Pick<GeocodeMatch, 'state' | 'stateShort'>
): boolean {
  const normalized = normalizeForCompare(typed)
  return normalized === normalizeForCompare(match.state)
    || normalized === normalizeForCompare(match.stateShort)
}

/** Compare the 5-digit prefix, so a typed ZIP+4 matches Google's 5-digit answer. */
export function zipsMatch(typed: string, google: string): boolean {
  return typed.replace(/\D/g, '').slice(0, 5) === google.replace(/\D/g, '').slice(0, 5)
}

export function diffAddress(
  row: Pick<ParsedRow, keyof AddressFields>,
  match: Pick<GeocodeMatch, keyof AddressFields | 'stateShort'>
): FieldDiff[] {
  const diff: FieldDiff[] = []
  if (normalizeForCompare(row.address) !== normalizeForCompare(match.address)) {
    diff.push({ field: 'address', typed: row.address, google: match.address })
  }
  if (normalizeForCompare(row.city) !== normalizeForCompare(match.city)) {
    diff.push({ field: 'city', typed: row.city, google: match.city })
  }
  if (!statesMatch(row.state, match)) {
    diff.push({ field: 'state', typed: row.state, google: match.state })
  }
  if (!zipsMatch(row.zipCode, match.zipCode)) {
    diff.push({ field: 'zipCode', typed: row.zipCode, google: match.zipCode })
  }
  return diff
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/locationImport/normalizeAddress.ts scripts/verify-location-import.mjs
git commit -m "feat(locations): compare typed addresses against Google's answer (SAM-8)"
```

---

### Task 3: Duplicate detection

**Files:**
- Create: `src/lib/locationImport/findDuplicates.ts`
- Modify: `scripts/verify-location-import.mjs`

**Interfaces:**
- Consumes: `AddressFields`, `ExistingLocation`, `ParsedRow` from `./types`
- Produces: `findDuplicates(rows: ParsedRow[], existing: ExistingLocation[]): Map<number, AddressFields | null>` — keyed by `rowNumber`; a `null` value means the collision is with an earlier row in the same file.

- [ ] **Step 1: Write the failing assertions**

Add the require at the top:

```js
const { findDuplicates } = require('./.licheck/findDuplicates.js')
```

Append before the `if (failures > 0)` block:

```js
// --- findDuplicates ----------------------------------------------------------

const EXISTING = [{ name: 'Vitamin Shoppe #60', address: '1650 S Broad St',
                    city: 'Philadelphia', state: 'Pennsylvania', zipCode: '19145' }]

const row = (rowNumber, name) => ({
  rowNumber, name, address: '1 Main St', city: 'Phila', state: 'PA',
  zipCode: '19145', parseError: null,
})

eq('a name already in the table is a duplicate, carrying the existing address',
  Array.from(findDuplicates([row(1, 'Vitamin Shoppe #60')], EXISTING).entries()),
  [[1, { address: '1650 S Broad St', city: 'Philadelphia',
         state: 'Pennsylvania', zipCode: '19145' }]])

eq('matching is case- and whitespace-insensitive',
  findDuplicates([row(1, '  vitamin shoppe #60 ')], EXISTING).has(1), true)

eq('a name repeated within the file marks only the SECOND row',
  Array.from(findDuplicates([row(1, 'New Store'), row(2, 'New Store')], EXISTING).entries()),
  [[2, null]])

eq('a genuinely new name is not a duplicate',
  findDuplicates([row(1, 'Total Wine #941')], EXISTING).size, 0)

eq('rows with a parse error are still checked for duplication',
  findDuplicates([{ ...row(1, 'Vitamin Shoppe #60'), parseError: 'Missing required field: Address' }],
    EXISTING).has(1),
  true)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/findDuplicates.js'`

- [ ] **Step 3: Implement**

`src/lib/locationImport/findDuplicates.ts`:

```ts
import type { AddressFields, ExistingLocation, ParsedRow } from './types'

const key = (name: string): string => name.trim().toLowerCase()

/**
 * Name collisions, against the table and within the file itself.
 *
 * The in-file case matters as much as the table case: two rows naming the same
 * store would create two records sharing a name, and the event importer's exact
 * name lookup would then bind events to whichever one it happened to read first.
 *
 * Returns rowNumber → the colliding record's address, or null when the collision
 * is with an earlier row in this same file.
 */
export function findDuplicates(
  rows: ParsedRow[],
  existing: ExistingLocation[]
): Map<number, AddressFields | null> {
  const byName = new Map<string, AddressFields>()
  existing.forEach((location) => {
    byName.set(key(location.name), {
      address: location.address,
      city: location.city,
      state: location.state,
      zipCode: location.zipCode,
    })
  })

  const duplicates = new Map<number, AddressFields | null>()
  const seenInFile = new Set<string>()

  rows.forEach((row) => {
    const name = key(row.name)
    if (name === '') return
    const inTable = byName.get(name)
    if (inTable !== undefined) {
      duplicates.set(row.rowNumber, inTable)
    } else if (seenInFile.has(name)) {
      duplicates.set(row.rowNumber, null)
    }
    seenInFile.add(name)
  })

  return duplicates
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/locationImport/findDuplicates.ts scripts/verify-location-import.mjs
git commit -m "feat(locations): detect duplicate names in the table and within a file (SAM-8)"
```

---

### Task 4: Google query building and response mapping

**Files:**
- Create: `src/lib/locationImport/geocodeAddress.ts`
- Modify: `scripts/verify-location-import.mjs`

**Interfaces:**
- Consumes: `FetchLike`, `GeocodeOutcome`, `ParsedRow` from `./types`
- Produces: `buildGeocodeQuery(row): string`, `mapGeocodeResponse(json: unknown): GeocodeOutcome`, `createGoogleGeocoder(apiKey: string, fetchImpl: FetchLike): (row: ParsedRow) => Promise<GeocodeOutcome>`

- [ ] **Step 1: Write the failing assertions**

Add the require at the top:

```js
const { buildGeocodeQuery, mapGeocodeResponse, createGoogleGeocoder } =
  require('./.licheck/geocodeAddress.js')
```

Append before the `if (failures > 0)` block:

```js
// --- geocodeAddress ----------------------------------------------------------

eq('the query assembles the four address fields',
  buildGeocodeQuery({ address: '1650 S Broad St', city: 'Philadelphia',
                      state: 'PA', zipCode: '19145' }),
  '1650 S Broad St, Philadelphia, PA 19145')

const googleOk = (overrides = {}) => ({
  status: 'OK',
  results: [{
    partial_match: overrides.partial_match,
    address_components: [
      { types: ['street_number'], long_name: '1650', short_name: '1650' },
      { types: ['route'], long_name: 'South Broad Street', short_name: 'S Broad St' },
      { types: ['locality'], long_name: 'Philadelphia', short_name: 'Philadelphia' },
      { types: ['administrative_area_level_1'], long_name: 'Pennsylvania', short_name: 'PA' },
      { types: ['postal_code'], long_name: '19145', short_name: '19145' },
    ],
    geometry: {
      location_type: overrides.location_type ?? 'ROOFTOP',
      location: { lat: 39.92, lng: -75.17 },
    },
  }],
})

eq('a good response maps to a match using the SHORT route name',
  mapGeocodeResponse(googleOk()),
  { kind: 'match', match: {
    address: '1650 S Broad St', city: 'Philadelphia', state: 'Pennsylvania',
    stateShort: 'PA', zipCode: '19145', longitude: -75.17, latitude: 39.92,
    partialMatch: false, locationType: 'ROOFTOP' } })

eq('partial_match is carried through',
  mapGeocodeResponse(googleOk({ partial_match: true })).match.partialMatch, true)

eq('location_type is carried through',
  mapGeocodeResponse(googleOk({ location_type: 'APPROXIMATE' })).match.locationType, 'APPROXIMATE')

eq('ZERO_RESULTS is a per-row failure',
  mapGeocodeResponse({ status: 'ZERO_RESULTS', results: [] }), { kind: 'none' })

eq('INVALID_REQUEST is a per-row failure',
  mapGeocodeResponse({ status: 'INVALID_REQUEST' }), { kind: 'none' })

eq('OVER_QUERY_LIMIT aborts the batch',
  mapGeocodeResponse({ status: 'OVER_QUERY_LIMIT' }),
  { kind: 'abort', reason: 'Google Maps quota exceeded. Try again later.' })

eq('REQUEST_DENIED aborts the batch',
  mapGeocodeResponse({ status: 'REQUEST_DENIED' }),
  { kind: 'abort', reason: 'Google Maps rejected the request. Check the API key.' })

eq('an OK response with no results is a per-row failure, not a crash',
  mapGeocodeResponse({ status: 'OK', results: [] }), { kind: 'none' })

eq('a malformed body is a per-row failure, not a crash',
  mapGeocodeResponse(null), { kind: 'none' })

eq('UNKNOWN_ERROR asks for a retry rather than failing the row',
  mapGeocodeResponse({ status: 'UNKNOWN_ERROR' }), { kind: 'retry' })

// createGoogleGeocoder resolves 'retry' internally, so it never reaches classifyRow.
const stubFetch = (bodies) => {
  let call = 0
  return async () => ({ json: async () => bodies[Math.min(call++, bodies.length - 1)] })
}

eq('a transient UNKNOWN_ERROR is retried and then succeeds',
  (await createGoogleGeocoder('k', stubFetch([{ status: 'UNKNOWN_ERROR' }, googleOk()]))(
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' })).kind,
  'match')

eq('UNKNOWN_ERROR three times over becomes a per-row failure, never a retry',
  (await createGoogleGeocoder('k', stubFetch([{ status: 'UNKNOWN_ERROR' }]))(
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' })).kind,
  'none')

eq('an abort is returned immediately without retrying',
  (await createGoogleGeocoder('k', stubFetch([{ status: 'REQUEST_DENIED' }, googleOk()]))(
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' })).kind,
  'abort')
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/geocodeAddress.js'`

- [ ] **Step 3: Implement**

`src/lib/locationImport/geocodeAddress.ts`:

```ts
import type { AddressFields, FetchLike, GeocodeMatch, GeocodeOutcome, ParsedRow } from './types'

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json'

/** Statuses that mean the key or quota is broken, so continuing would waste the batch. */
const ABORT_REASONS: Record<string, string> = {
  OVER_QUERY_LIMIT: 'Google Maps quota exceeded. Try again later.',
  REQUEST_DENIED: 'Google Maps rejected the request. Check the API key.',
}

/** Backoff before each retry of an UNKNOWN_ERROR, in milliseconds. */
const RETRY_DELAYS_MS = [250, 1000]

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function buildGeocodeQuery(row: AddressFields): string {
  return `${row.address}, ${row.city}, ${row.state} ${row.zipCode}`.trim()
}

interface RawComponent { types?: string[]; long_name?: string; short_name?: string }

function component(components: RawComponent[], type: string): RawComponent | undefined {
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type))
}

export function mapGeocodeResponse(json: unknown): GeocodeOutcome {
  const body = json as { status?: string; results?: unknown[] } | null
  const status = body?.status
  if (typeof status === 'string') {
    const abortReason = ABORT_REASONS[status]
    if (abortReason !== undefined) {
      return { kind: 'abort', reason: abortReason }
    }
    if (status === 'UNKNOWN_ERROR') {
      return { kind: 'retry' }
    }
  }
  const first = Array.isArray(body?.results) ? body.results[0] : undefined
  if (status !== 'OK' || first === undefined) {
    return { kind: 'none' }
  }

  const result = first as {
    partial_match?: boolean
    address_components?: RawComponent[]
    geometry?: { location_type?: string; location?: { lat?: number; lng?: number } }
  }
  const components = Array.isArray(result.address_components) ? result.address_components : []
  const lat = result.geometry?.location?.lat
  const lng = result.geometry?.location?.lng
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { kind: 'none' }
  }

  const streetNumber = component(components, 'street_number')?.long_name ?? ''
  // short_name gives the abbreviated route ("S Broad St"), which is what the
  // comparison normalizer and the stored record both expect.
  const route = component(components, 'route')?.short_name ?? ''
  const state = component(components, 'administrative_area_level_1')

  const match: GeocodeMatch = {
    address: `${streetNumber} ${route}`.trim(),
    city: component(components, 'locality')?.long_name ?? '',
    state: state?.long_name ?? '',
    stateShort: state?.short_name ?? '',
    zipCode: component(components, 'postal_code')?.long_name ?? '',
    longitude: lng,
    latitude: lat,
    partialMatch: result.partial_match === true,
    locationType: result.geometry?.location_type ?? '',
  }
  return { kind: 'match', match }
}

/**
 * The live geocoder. `fetchImpl` is injected so the verification script can
 * exercise everything above without network access.
 *
 * UNKNOWN_ERROR is Google's explicit "this was transient, try again" status, so
 * it is retried here rather than being reported to the operator as a bad
 * address. After the retries are spent it degrades to an ordinary row failure,
 * which the operator can resolve with Edit. A network-level throw is treated the
 * same way: one bad row must never take down a 400-row batch.
 */
export function createGoogleGeocoder(
  apiKey: string,
  fetchImpl: FetchLike
): (row: ParsedRow) => Promise<GeocodeOutcome> {
  return async (row) => {
    const url = `${ENDPOINT}?address=${encodeURIComponent(buildGeocodeQuery(row))}`
      + `&components=country:US&key=${apiKey}`

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let outcome: GeocodeOutcome
      try {
        const response = await fetchImpl(url)
        outcome = mapGeocodeResponse(await response.json())
      } catch {
        outcome = { kind: 'retry' }
      }
      if (outcome.kind !== 'retry') {
        return outcome
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await wait(RETRY_DELAYS_MS[attempt])
      }
    }
    return { kind: 'none' }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/locationImport/geocodeAddress.ts scripts/verify-location-import.mjs
git commit -m "feat(locations): build and map Google Geocoding requests (SAM-8)"
```

---

### Task 5: Row classification

**Files:**
- Create: `src/lib/locationImport/classifyRow.ts`
- Modify: `scripts/verify-location-import.mjs`

**Interfaces:**
- Consumes: `diffAddress` from `./normalizeAddress`; `ClassifiedRow`, `GeocodeOutcome`, `ParsedRow` from `./types`
- Produces: `classifyRow(row: ParsedRow, outcome: GeocodeOutcome): ClassifiedRow`

- [ ] **Step 1: Write the failing assertions**

Add the require at the top:

```js
const { classifyRow } = require('./.licheck/classifyRow.js')
```

Append before the `if (failures > 0)` block:

```js
// --- classifyRow -------------------------------------------------------------

const parsed = (overrides = {}) => ({
  rowNumber: 1, name: 'Vitamin Shoppe #60', address: '1650 S Broad St',
  city: 'Philadelphia', state: 'PA', zipCode: '19145', parseError: null, ...overrides,
})
const matchOutcome = (overrides = {}) => ({
  kind: 'match',
  match: { address: '1650 S Broad St', city: 'Philadelphia', state: 'Pennsylvania',
           stateShort: 'PA', zipCode: '19145', longitude: -75.17, latitude: 39.92,
           partialMatch: false, locationType: 'ROOFTOP', ...overrides },
})

eq('an exact ROOFTOP match is ready',
  classifyRow(parsed(), matchOutcome()).status, 'ready')

eq('a ready row carries no reason', classifyRow(parsed(), matchOutcome()).reason, null)

eq('RANGE_INTERPOLATED is also ready',
  classifyRow(parsed(), matchOutcome({ locationType: 'RANGE_INTERPOLATED' })).status, 'ready')

eq('typed PA against Google Pennsylvania is ready',
  classifyRow(parsed({ state: 'PA' }), matchOutcome()).status, 'ready')

eq('typed Pennsylvania is also ready',
  classifyRow(parsed({ state: 'Pennsylvania' }), matchOutcome()).status, 'ready')

eq('typed North Broad St against Google N Broad St is ready',
  classifyRow(parsed({ address: '1650 North Broad St' }),
    matchOutcome({ address: '1650 N Broad St' })).status,
  'ready')

eq('a missing directional needs review',
  classifyRow(parsed({ address: '1650 Broad St' }), matchOutcome()).status, 'review')

eq('the review reason names the differing field',
  classifyRow(parsed({ address: '1650 Broad St' }), matchOutcome()).reason,
  "Google's address differs from what you entered")

eq('the diff is carried for the UI',
  classifyRow(parsed({ address: '1650 Broad St' }), matchOutcome()).diff,
  [{ field: 'address', typed: '1650 Broad St', google: '1650 S Broad St' }])

eq('a partial match needs review even when the fields agree',
  classifyRow(parsed(), matchOutcome({ partialMatch: true })).status, 'review')

eq('an APPROXIMATE match needs review even when the fields agree',
  classifyRow(parsed(), matchOutcome({ locationType: 'APPROXIMATE' })).status, 'review')

eq('GEOMETRIC_CENTER needs review',
  classifyRow(parsed(), matchOutcome({ locationType: 'GEOMETRIC_CENTER' })).status, 'review')

eq('no Google result is a failure',
  classifyRow(parsed(), { kind: 'none' }).status, 'failed')

eq('the failure reason is operator-facing',
  classifyRow(parsed(), { kind: 'none' }).reason,
  'Google Maps found no match for this address')

eq('a parse error fails without consulting Google',
  classifyRow(parsed({ parseError: 'Missing required field: Address' }), { kind: 'none' }),
  { rowNumber: 1, name: 'Vitamin Shoppe #60', address: '1650 S Broad St',
    city: 'Philadelphia', state: 'PA', zipCode: '19145',
    parseError: 'Missing required field: Address', status: 'failed',
    reason: 'Missing required field: Address', match: null, diff: [], existing: null })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/classifyRow.js'`

- [ ] **Step 3: Implement**

`src/lib/locationImport/classifyRow.ts`:

```ts
import { diffAddress } from './normalizeAddress'
import type { ClassifiedRow, GeocodeOutcome, ParsedRow } from './types'

/** Google precision levels we accept without asking the operator. */
const PRECISE_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED']

export function classifyRow(row: ParsedRow, outcome: GeocodeOutcome): ClassifiedRow {
  const base: ClassifiedRow = {
    ...row,
    status: 'failed',
    reason: null,
    match: null,
    diff: [],
    existing: null,
  }

  if (row.parseError !== null) {
    return { ...base, status: 'failed', reason: row.parseError }
  }

  if (outcome.kind !== 'match') {
    // 'abort' never reaches here — classifyAll stops the batch first.
    return { ...base, status: 'failed', reason: 'Google Maps found no match for this address' }
  }

  const { match } = outcome
  const diff = diffAddress(row, match)

  if (match.partialMatch) {
    return { ...base, status: 'review', reason: 'Google returned only a partial match', match, diff }
  }
  if (!PRECISE_LOCATION_TYPES.includes(match.locationType)) {
    return {
      ...base,
      status: 'review',
      reason: 'Google could only match this address approximately',
      match,
      diff,
    }
  }
  if (diff.length > 0) {
    return {
      ...base,
      status: 'review',
      reason: "Google's address differs from what you entered",
      match,
      diff,
    }
  }
  return { ...base, status: 'ready', reason: null, match, diff: [] }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/locationImport/classifyRow.ts scripts/verify-location-import.mjs
git commit -m "feat(locations): classify a row as ready, review, or failed (SAM-8)"
```

---

### Task 6: Pipeline orchestration and the concurrency pool

**Files:**
- Create: `src/lib/locationImport/classifyAll.ts`
- Create: `src/lib/locationImport/index.ts`
- Modify: `scripts/verify-location-import.mjs`

**Interfaces:**
- Consumes: `classifyRow`, `findDuplicates`, and the types
- Produces: `classifyAll(rows: ParsedRow[], existing: ExistingLocation[], options: { geocode: (row: ParsedRow) => Promise<GeocodeOutcome>; concurrency?: number }): Promise<{ rows: ClassifiedRow[]; aborted: string | null }>`; `index.ts` re-exports every public symbol from the seven modules.

- [ ] **Step 1: Write the failing assertions**

Add the require at the top:

```js
const { classifyAll } = require('./.licheck/classifyAll.js')
```

Append before the `if (failures > 0)` block. Note these are async, so they are awaited at the top level of the ESM script:

```js
// --- classifyAll -------------------------------------------------------------

const pipelineRow = (rowNumber, name, address = '1650 S Broad St') => ({
  rowNumber, name, address, city: 'Philadelphia', state: 'PA',
  zipCode: '19145', parseError: null,
})
const alwaysMatches = async () => matchOutcome()

const dupResult = await classifyAll(
  [pipelineRow(1, 'Vitamin Shoppe #60'), pipelineRow(2, 'Total Wine #941')],
  EXISTING,
  { geocode: alwaysMatches })

eq('a duplicate is marked and NOT geocoded',
  dupResult.rows.map((r) => [r.rowNumber, r.status, r.match === null]),
  [[1, 'duplicate', true], [2, 'ready', false]])

eq('a duplicate carries the existing address for context',
  dupResult.rows[0].existing,
  { address: '1650 S Broad St', city: 'Philadelphia', state: 'Pennsylvania', zipCode: '19145' })

eq('a duplicate reason is operator-facing',
  dupResult.rows[0].reason, 'A location with this name already exists')

const inFileDup = await classifyAll(
  [pipelineRow(1, 'New Store'), pipelineRow(2, 'New Store')], [], { geocode: alwaysMatches })
eq('an in-file duplicate names the earlier row',
  [inFileDup.rows[1].status, inFileDup.rows[1].reason],
  ['duplicate', 'This name appears earlier in the file'])

let calls = 0
const counting = async () => { calls++; return matchOutcome() }
await classifyAll([pipelineRow(1, 'Vitamin Shoppe #60'), pipelineRow(2, 'A'), pipelineRow(3, 'B')],
  EXISTING, { geocode: counting })
eq('duplicates cost no API calls', calls, 2)

calls = 0
await classifyAll([{ ...pipelineRow(1, 'A'), parseError: 'Missing required field: Address' }],
  [], { geocode: counting })
eq('a parse-error row costs no API call', calls, 0)

const aborted = await classifyAll(
  [pipelineRow(1, 'A'), pipelineRow(2, 'B')], [],
  { geocode: async () => ({ kind: 'abort', reason: 'Google Maps quota exceeded. Try again later.' }) })
eq('an abort is reported and no rows are returned',
  [aborted.aborted, aborted.rows.length],
  ['Google Maps quota exceeded. Try again later.', 0])

const ordered = await classifyAll(
  [pipelineRow(1, 'A'), pipelineRow(2, 'B'), pipelineRow(3, 'C')], [],
  { geocode: async (r) => { await new Promise((res) => setTimeout(res, (4 - r.rowNumber) * 5))
                            return matchOutcome() },
    concurrency: 3 })
eq('results keep CSV order regardless of completion order',
  ordered.rows.map((r) => r.rowNumber), [1, 2, 3])

eq('a clean batch reports no abort', ordered.aborted, null)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run verify:location-import`
Expected: FAIL — `Cannot find module './.licheck/classifyAll.js'`

- [ ] **Step 3: Implement**

`src/lib/locationImport/classifyAll.ts`:

```ts
import { classifyRow } from './classifyRow'
import { findDuplicates } from './findDuplicates'
import type {
  ClassifiedRow, ExistingLocation, GeocodeOutcome, ParsedRow,
} from './types'

const DEFAULT_CONCURRENCY = 8

export interface ClassifyAllOptions {
  geocode: (row: ParsedRow) => Promise<GeocodeOutcome>
  concurrency?: number
}

export interface ClassifyAllResult {
  rows: ClassifiedRow[]
  /** Non-null when the batch stopped early; `rows` is then empty. */
  aborted: string | null
}

/**
 * The whole read-side pipeline: mark duplicates and parse errors without
 * touching the network, geocode only what is left, then classify.
 *
 * Duplicates are resolved BEFORE geocoding because re-uploading a corrected
 * sheet is the common case, and every already-imported row would otherwise be
 * paid for again.
 */
export async function classifyAll(
  rows: ParsedRow[],
  existing: ExistingLocation[],
  options: ClassifyAllOptions
): Promise<ClassifyAllResult> {
  const duplicates = findDuplicates(rows, existing)
  const results = new Array<ClassifiedRow>(rows.length)
  const queue: number[] = []

  rows.forEach((row, index) => {
    if (duplicates.has(row.rowNumber)) {
      const existingAddress = duplicates.get(row.rowNumber) ?? null
      results[index] = {
        ...row,
        status: 'duplicate',
        reason: existingAddress === null
          ? 'This name appears earlier in the file'
          : 'A location with this name already exists',
        match: null,
        diff: [],
        existing: existingAddress,
      }
    } else if (row.parseError !== null) {
      results[index] = classifyRow(row, { kind: 'none' })
    } else {
      queue.push(index)
    }
  })

  // Held in an object rather than a bare `let`: TypeScript does not narrow a
  // variable reassigned inside a closure, and reading it back after Promise.all
  // would otherwise be typed as `null`.
  const state: { aborted: string | null } = { aborted: null }
  let next = 0
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, queue.length) },
    async () => {
      while (state.aborted === null) {
        const cursor = next++
        if (cursor >= queue.length) return
        const index = queue[cursor]
        const outcome = await options.geocode(rows[index])
        if (outcome.kind === 'abort') {
          state.aborted = outcome.reason
          return
        }
        results[index] = classifyRow(rows[index], outcome)
      }
    }
  )
  await Promise.all(workers)

  if (state.aborted !== null) {
    return { rows: [], aborted: state.aborted }
  }
  return { rows: results, aborted: null }
}
```

`src/lib/locationImport/index.ts`:

```ts
export * from './types'
export { parseLocationsCsv } from './parseLocationsCsv'
export { normalizeForCompare, statesMatch, zipsMatch, diffAddress } from './normalizeAddress'
export { findDuplicates } from './findDuplicates'
export { buildGeocodeQuery, mapGeocodeResponse, createGoogleGeocoder } from './geocodeAddress'
export { classifyRow } from './classifyRow'
export { classifyAll } from './classifyAll'
export type { ClassifyAllOptions, ClassifyAllResult } from './classifyAll'
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify:location-import`
Expected: PASS — all assertions from Tasks 1–6

- [ ] **Step 5: Confirm the build is clean**

Run: `npm run build && npm run lint`
Expected: both succeed

- [ ] **Step 6: Commit**

```bash
git add src/lib/locationImport/classifyAll.ts src/lib/locationImport/index.ts \
        scripts/verify-location-import.mjs
git commit -m "feat(locations): orchestrate the import pipeline with a geocoding pool (SAM-8)"
```

---

### Task 7: Review-step UI

**Files:**
- Create: `src/pages/Locations/components/ImportRowCard.tsx`
- Create: `src/pages/Locations/components/ImportReviewTable.tsx`

**Interfaces:**
- Consumes: `ClassifiedRow`, `AddressFields` from `../../../lib/locationImport`
- Produces:
  - `ImportRowCard` props: `{ row: ClassifiedRow; onUseGoogle: (rowNumber: number) => void; onKeepMine: (rowNumber: number) => void; onEdit: (rowNumber: number, fields: AddressFields) => void; onSkip: (rowNumber: number) => void; skipped: boolean }`
  - `ImportReviewTable` props: `{ rows: ClassifiedRow[]; skipped: Set<number> }` plus the same four callbacks, forwarded.

> **Verify the blocking prerequisite before starting this task.** If `locations.location` is required (assume so), `failed` rows offer only Edit and Skip — no force-import.

- [ ] **Step 1: Build `ImportRowCard`**

`src/pages/Locations/components/ImportRowCard.tsx`:

```tsx
import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { AddressFields, ClassifiedRow } from '../../../lib/locationImport'

interface ImportRowCardProps {
  row: ClassifiedRow
  skipped: boolean
  onUseGoogle: (rowNumber: number) => void
  onKeepMine: (rowNumber: number) => void
  onEdit: (rowNumber: number, fields: AddressFields) => void
  onSkip: (rowNumber: number) => void
}

const STATUS_STYLES: Record<ClassifiedRow['status'], { pill: string; label: string; icon: string }> = {
  ready: { pill: 'bg-green-100 text-green-800', label: 'Ready', icon: 'mdi:check-circle' },
  review: { pill: 'bg-amber-100 text-amber-800', label: 'Needs review', icon: 'mdi:alert' },
  failed: { pill: 'bg-red-100 text-red-800', label: 'Failed', icon: 'mdi:close-circle' },
  duplicate: { pill: 'bg-gray-100 text-gray-700', label: 'Already exists', icon: 'mdi:information' },
}

const FIELD_LABELS: Record<keyof AddressFields, string> = {
  address: 'Address',
  city: 'City',
  state: 'State',
  zipCode: 'Zip',
}

const ADDRESS_FIELDS = Object.keys(FIELD_LABELS) as (keyof AddressFields)[]

const BTN_PRIMARY = 'px-3 py-1.5 bg-[#1D0A74] text-white rounded-lg text-sm font-medium hover:bg-[#15065c] transition-colors'
const BTN_SECONDARY = 'px-3 py-1.5 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg text-sm font-medium hover:bg-[#1D0A74]/20 transition-colors'
const BTN_MUTED = 'px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 transition-colors'

const ImportRowCard = ({
  row, skipped, onUseGoogle, onKeepMine, onEdit, onSkip,
}: ImportRowCardProps) => {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<AddressFields>({
    address: row.address, city: row.city, state: row.state, zipCode: row.zipCode,
  })

  const style = STATUS_STYLES[row.status]
  const canEdit = row.status === 'review' || row.status === 'failed'

  const resetDraft = () => setDraft({
    address: row.address, city: row.city, state: row.state, zipCode: row.zipCode,
  })

  return (
    <div className={`border rounded-lg p-4 ${skipped ? 'opacity-50 border-gray-200' : 'border-gray-300'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The name is deliberately not editable — the client's naming convention is authoritative. */}
          <p className="font-semibold text-gray-900 truncate">
            <span className="text-gray-400 font-normal mr-2">#{row.rowNumber}</span>
            {row.name}
          </p>
          <p className="text-sm text-gray-600">
            {row.address}, {row.city}, {row.state} {row.zipCode}
          </p>
        </div>
        <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${style.pill}`}>
          <Icon icon={style.icon} className="w-4 h-4" />
          {skipped ? 'Skipped' : style.label}
        </span>
      </div>

      {row.reason !== null && <p className="mt-2 text-sm text-gray-700">{row.reason}</p>}

      {row.diff.length > 0 && (
        <dl className="mt-3 space-y-1 text-sm">
          {row.diff.map((difference) => (
            <div key={difference.field} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt className="text-gray-500">{FIELD_LABELS[difference.field]}</dt>
              <dd>
                <span className="line-through text-gray-500">{difference.typed || '(blank)'}</span>
                <span className="mx-1.5 text-gray-400">&rarr;</span>
                <span className="font-medium text-gray-900">{difference.google}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {row.existing !== null && (
        <p className="mt-2 text-sm text-gray-500">
          Existing record: {row.existing.address}, {row.existing.city}, {row.existing.state}{' '}
          {row.existing.zipCode}
        </p>
      )}

      {isEditing ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {ADDRESS_FIELDS.map((field) => (
            <label key={field} className="text-sm">
              <span className="block text-gray-700 mb-1">{FIELD_LABELS[field]}</span>
              <input
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74]/30"
              />
            </label>
          ))}
          <div className="col-span-2 flex gap-2">
            <button
              onClick={() => { setIsEditing(false); onEdit(row.rowNumber, draft) }}
              className={BTN_PRIMARY}
            >
              Save &amp; re-check
            </button>
            <button
              onClick={() => { setIsEditing(false); resetDraft() }}
              className={BTN_MUTED}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        row.status !== 'duplicate' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {/* 'Keep mine' is offered only on review rows, which always carry a match
                and therefore have coordinates to adopt. */}
            {row.status === 'review' && (
              <>
                <button onClick={() => onUseGoogle(row.rowNumber)} className={BTN_PRIMARY}>
                  Use Google
                </button>
                <button onClick={() => onKeepMine(row.rowNumber)} className={BTN_SECONDARY}>
                  Keep mine
                </button>
              </>
            )}
            {canEdit && (
              <button onClick={() => { resetDraft(); setIsEditing(true) }} className={BTN_SECONDARY}>
                Edit
              </button>
            )}
            <button onClick={() => onSkip(row.rowNumber)} className={BTN_MUTED}>
              {skipped ? 'Include' : 'Skip'}
            </button>
          </div>
        )
      )}
    </div>
  )
}

export default ImportRowCard
```

- [ ] **Step 2: Build `ImportReviewTable`**

`src/pages/Locations/components/ImportReviewTable.tsx`:

```tsx
import ImportRowCard from './ImportRowCard'
import type { AddressFields, ClassifiedRow, RowStatus } from '../../../lib/locationImport'

interface ImportReviewTableProps {
  rows: ClassifiedRow[]
  skipped: Set<number>
  onUseGoogle: (rowNumber: number) => void
  onKeepMine: (rowNumber: number) => void
  onEdit: (rowNumber: number, fields: AddressFields) => void
  onSkip: (rowNumber: number) => void
}

// Problems first. 'ready' is precisely what the operator does not need to look at,
// so it goes last and starts collapsed.
const GROUP_ORDER: RowStatus[] = ['review', 'failed', 'duplicate', 'ready']

const GROUP_TITLES: Record<RowStatus, string> = {
  review: 'Need review',
  failed: 'Failed',
  duplicate: 'Already exist',
  ready: 'Ready to import',
}

const SUMMARY_ICONS: Record<RowStatus, string> = {
  ready: '\u2705',
  review: '\u26a0\ufe0f',
  failed: '\u274c',
  duplicate: '\u2139\ufe0f',
}

const ImportReviewTable = ({ rows, skipped, ...handlers }: ImportReviewTableProps) => {
  const byStatus = (status: RowStatus) => rows.filter((row) => row.status === status)

  return (
    <div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-medium text-gray-800 mb-5">
        {(['ready', 'review', 'failed', 'duplicate'] as RowStatus[]).map((status) => (
          <span key={status}>
            {SUMMARY_ICONS[status]} {byStatus(status).length} {GROUP_TITLES[status].toLowerCase()}
          </span>
        ))}
      </div>

      {GROUP_ORDER.map((status) => {
        const group = byStatus(status)
        if (group.length === 0) return null

        const cards = (
          <div className="space-y-3">
            {group.map((row) => (
              <ImportRowCard
                key={row.rowNumber}
                row={row}
                skipped={skipped.has(row.rowNumber)}
                {...handlers}
              />
            ))}
          </div>
        )

        if (status === 'ready') {
          return (
            <details key={status} className="mb-6">
              <summary className="cursor-pointer text-sm font-semibold text-gray-900 mb-3">
                {GROUP_TITLES[status]} ({group.length})
              </summary>
              {cards}
            </details>
          )
        }

        return (
          <section key={status} className="mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              {GROUP_TITLES[status]} ({group.length})
            </h3>
            {cards}
          </section>
        )
      })}
    </div>
  )
}

export default ImportReviewTable
```

- [ ] **Step 3: Verify the build**

Run: `npm run build && npm run lint`
Expected: both succeed

- [ ] **Step 4: Commit**

```bash
git add src/pages/Locations/components/ImportRowCard.tsx \
        src/pages/Locations/components/ImportReviewTable.tsx
git commit -m "feat(locations): review table for import rows (SAM-8)"
```

---

### Task 8: Modal shell, page wiring, and commit

**Files:**
- Create: `src/lib/googleMapsKey.ts`
- Create: `src/pages/Locations/components/ImportLocationsModal.tsx`
- Modify: `src/components/AddressAutocomplete.tsx:4` (use the shared key)
- Modify: `src/components/LocationPicker.tsx:21` (use the shared key)
- Modify: `src/pages/Locations/components/index.ts`
- Modify: `src/pages/Locations/components/LocationsHeader.tsx`
- Modify: `src/pages/Locations/Locations.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–7; `locationsService.searchAll`, `locationsService.create` from `../../lib/services`; `useNotificationStore` from `../../stores/notificationStore`
- Produces: `ImportLocationsModal` props `{ isOpen: boolean; onClose: () => void; onImported: () => Promise<void> }`; `LocationsHeaderProps` gains `onBulkImport: () => void`

- [ ] **Step 1: Give the API key a single home**

The key is currently a literal in two files. This feature must not make it a third (spec §7).

Create `src/lib/googleMapsKey.ts`:

```ts
/**
 * Shipped in the client bundle and therefore public — this is not a secret and
 * never was. Centralised so there is one place to change when it is rotated and
 * referrer-restricted (see the SAM-8 spec, "Security note").
 */
export const GOOGLE_MAPS_API_KEY = 'AIzaSyAywmgeNZsxezVKVV8k3w3v9K8tssxh4mc'
```

Then in `src/components/AddressAutocomplete.tsx` replace line 4 and in
`src/components/LocationPicker.tsx` replace line 21 with:

```ts
import { GOOGLE_MAPS_API_KEY } from '../lib/googleMapsKey'
```

Behaviour is unchanged; this is a mechanical move so the new modal has something to import.

- [ ] **Step 2: Build the modal**

`src/pages/Locations/components/ImportLocationsModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import ImportReviewTable from './ImportReviewTable'
import { GOOGLE_MAPS_API_KEY } from '../../../lib/googleMapsKey'
import { locationsService } from '../../../lib/services'
import { useNotificationStore } from '../../../stores/notificationStore'
import {
  classifyAll, classifyRow, createGoogleGeocoder, parseLocationsCsv,
  type AddressFields, type ClassifiedRow,
} from '../../../lib/locationImport'

interface ImportLocationsModalProps {
  isOpen: boolean
  onClose: () => void
  onImported: () => Promise<void>
}

const TEMPLATE_HEADERS = 'Name,Address,City,State,Zip'
const TEMPLATE_ROW = '[REPLACE WITH LOCATION NAME],[REPLACE WITH STREET ADDRESS],'
  + '[REPLACE WITH CITY],[REPLACE WITH STATE],[REPLACE WITH ZIP]'

/** Appwrite writes are cheap but not free; 4 at a time keeps the UI responsive. */
const WRITE_CONCURRENCY = 4

const geocode = createGoogleGeocoder(GOOGLE_MAPS_API_KEY, fetch)

const ImportLocationsModal = ({ isOpen, onClose, onImported }: ImportLocationsModalProps) => {
  const { addNotification } = useNotificationStore()
  const [rows, setRows] = useState<ClassifiedRow[]>([])
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [fileError, setFileError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Clear everything on close so reopening never shows a previous file's review.
  useEffect(() => {
    if (!isOpen) {
      setRows([])
      setSkipped(new Set())
      setFileError(null)
      setIsProcessing(false)
      setIsImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  const importable = rows.filter((row) => row.status === 'ready' && !skipped.has(row.rowNumber))

  const handleFile = async (file: File) => {
    setFileError(null)
    setIsProcessing(true)
    try {
      const parsed = parseLocationsCsv(await file.text())
      if (parsed.fileError !== null) {
        setFileError(parsed.fileError)
        return
      }
      const { documents } = await locationsService.searchAll('')
      const result = await classifyAll(parsed.rows, documents, { geocode })
      if (result.aborted !== null) {
        setFileError(result.aborted)
        return
      }
      setRows(result.rows)
      setSkipped(new Set())
    } catch (error) {
      setFileError(error instanceof Error ? error.message : 'Could not read that file')
    } finally {
      setIsProcessing(false)
    }
  }

  const replaceRow = (rowNumber: number, next: (row: ClassifiedRow) => ClassifiedRow) => {
    setRows((current) => current.map((row) => (row.rowNumber === rowNumber ? next(row) : row)))
  }

  /** Adopt Google's fields. `match.state` is the long name, which is what we store. */
  const handleUseGoogle = (rowNumber: number) => {
    replaceRow(rowNumber, (row) => (row.match === null ? row : {
      ...row,
      address: row.match.address,
      city: row.match.city,
      state: row.match.state,
      zipCode: row.match.zipCode,
      status: 'ready',
      reason: null,
      diff: [],
    }))
  }

  /** Keep the typed address but retain `match` — its coordinates are still used. */
  const handleKeepMine = (rowNumber: number) => {
    replaceRow(rowNumber, (row) => ({ ...row, status: 'ready', reason: null, diff: [] }))
  }

  const handleEdit = async (rowNumber: number, fields: AddressFields) => {
    const target = rows.find((row) => row.rowNumber === rowNumber)
    if (target === undefined) return
    const edited = { ...target, ...fields, parseError: null }
    const outcome = await geocode(edited)
    // An abort here affects only this one re-check; surface it without discarding the batch.
    if (outcome.kind === 'abort') {
      setFileError(outcome.reason)
      return
    }
    replaceRow(rowNumber, () => classifyRow(edited, outcome))
  }

  const handleSkip = (rowNumber: number) => {
    setSkipped((current) => {
      const next = new Set(current)
      if (next.has(rowNumber)) next.delete(rowNumber)
      else next.add(rowNumber)
      return next
    })
  }

  const handleImport = async () => {
    setIsImporting(true)
    const queue = [...importable]
    let created = 0
    let failed = 0
    let cursor = 0

    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++]
        try {
          await locationsService.create({
            name: row.name,
            address: row.address,
            city: row.city,
            state: row.state,
            zipCode: row.zipCode,
            // [longitude, latitude] — the order locationsService documents.
            location: row.match === null
              ? undefined
              : [row.match.longitude, row.match.latitude],
          })
          created++
        } catch (error) {
          failed++
          const reason = error instanceof Error ? error.message : 'Could not save this location'
          replaceRow(row.rowNumber, (current) => ({ ...current, status: 'failed', reason }))
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(WRITE_CONCURRENCY, queue.length) }, worker)
    )
    setIsImporting(false)

    addNotification({
      type: failed > 0 ? 'warning' : 'success',
      title: failed > 0 ? 'Import finished with errors' : 'Locations Imported',
      message: `Imported ${created} · skipped ${rows.length - created - failed} · failed ${failed}`,
    })
    await onImported()
    if (failed === 0) onClose()
  }

  const handleDownloadTemplate = () => {
    const uri = encodeURI(`data:text/csv;charset=utf-8,${TEMPLATE_HEADERS}\n${TEMPLATE_ROW}`)
    const link = document.createElement('a')
    link.setAttribute('href', uri)
    link.setAttribute('download', 'locations_template.csv')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const showReview = rows.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto m-4">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Bulk Import Locations</h2>
            <p className="text-sm text-gray-600 mt-1">
              {showReview
                ? 'Step 2 of 2 — review and correct, then import.'
                : 'Step 1 of 2 — upload a CSV. Addresses are checked against Google Maps.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={isProcessing || isImporting}
          >
            <Icon icon="mdi:close" className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6">
          {fileError !== null && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
              {fileError}
            </div>
          )}

          {!showReview && (
            <>
              <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                <Icon icon="mdi:cloud-upload" className="w-12 h-12 text-gray-400 mb-3" />
                <p className="mb-2 text-sm text-gray-500">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-gray-500">Your locations CSV</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onClick={(event) => { event.currentTarget.value = '' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleFile(file)
                  }}
                />
              </label>

              <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
                <p className="text-sm text-blue-800 font-semibold">Required columns</p>
                <div className="flex flex-wrap gap-2">
                  {['Name', 'Address', 'City', 'State', 'Zip'].map((column) => (
                    <span key={column} className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm text-gray-700 font-medium">
                      {column}
                    </span>
                  ))}
                </div>
                <ul className="text-sm text-blue-800 list-disc list-inside space-y-1 pt-1">
                  <li>Location names are imported exactly as typed and are never corrected</li>
                  <li>Addresses are checked against Google Maps; you review anything that differs</li>
                  <li>Names that already exist are skipped, never overwritten</li>
                  <li>Maximum 1000 rows per file</li>
                </ul>
              </div>
            </>
          )}

          {isProcessing && (
            <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />
              Checking addresses against Google Maps…
            </div>
          )}

          {showReview && (
            <ImportReviewTable
              rows={rows}
              skipped={skipped}
              onUseGoogle={handleUseGoogle}
              onKeepMine={handleKeepMine}
              onEdit={handleEdit}
              onSkip={handleSkip}
            />
          )}
        </div>

        <div className="flex gap-4 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={isImporting}
            className="flex-1 px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-semibold disabled:opacity-50"
          >
            Cancel
          </button>
          {!showReview && (
            <button
              onClick={handleDownloadTemplate}
              className="px-6 py-3 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg hover:bg-[#1D0A74]/20 transition-colors font-semibold"
            >
              Download Template
            </button>
          )}
          {showReview && (
            <button
              onClick={() => void handleImport()}
              disabled={importable.length === 0 || isImporting}
              className="flex-1 px-6 py-3 bg-[#1D0A74] text-white rounded-lg hover:bg-[#15065c] transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isImporting
                ? (<><Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />Importing…</>)
                : `Import ${importable.length} location${importable.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ImportLocationsModal
```

- [ ] **Step 3: Export it**

Add to `src/pages/Locations/components/index.ts`:

```ts
export { default as ImportLocationsModal } from './ImportLocationsModal'
```

- [ ] **Step 4: Wire the page**

`LocationsHeader.tsx` gains an `onBulkImport` prop and a secondary button left of "Add Location":

```tsx
<button
  onClick={onBulkImport}
  className="px-4 py-2 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg hover:bg-[#1D0A74]/20 transition-colors flex items-center gap-2"
>
  <Icon icon="mdi:file-upload-outline" className="w-5 h-5" />
  Bulk Import
</button>
```

`Locations.tsx` adds `isImportModalOpen` state, passes `onBulkImport={() => setIsImportModalOpen(true)}`, and renders `<ImportLocationsModal ... onImported={async () => { setCurrentPage(1); await fetchLocations(1) }} />` beside the existing `AddLocationModal`. Export the new modal from `components/index.ts`.

- [ ] **Step 5: Verify the build**

Run: `npm run build && npm run lint && npm run verify:location-import`
Expected: all three succeed

- [ ] **Step 6: Manual QA against staging**

Run `npm run dev:staging` and work through:

| # | Case | Expected |
|---|---|---|
| 1 | Template downloads, filled in with 5 real addresses | all 5 `ready`, import creates 5 |
| 2 | Re-upload the same file | all 5 `duplicate`, Import disabled at 0 ready |
| 3 | Row with `1650 Broad St` (missing `S`) | `review`; Use Google fixes it; imported record shows `1650 S Broad St` |
| 4 | Same row, Keep mine | imported record keeps `1650 Broad St` but has a correct map pin |
| 5 | Row with a nonsense address | `failed`; Edit to a real one re-geocodes to `ready` |
| 6 | Row with a blank City | `failed` before any API call |
| 7 | File missing the Address column | rejected on step 1 with the column named |
| 8 | Two rows with the same new name | second is `duplicate` |
| 9 | State typed as `Pennsylvania` | `ready`; stored value is `Pennsylvania` |
| 10 | Imported location picked in the event CSV by name | event import resolves it |

Case 10 is the point of the feature — confirm the two importers actually meet.

- [ ] **Step 7: Commit**

```bash
git add src/lib/googleMapsKey.ts src/components/AddressAutocomplete.tsx \
        src/components/LocationPicker.tsx src/pages/Locations/
git commit -m "feat(locations): bulk CSV import with Google address validation (SAM-8)"
```

- [ ] **Step 8: Run the pre-merge gate**

Run `/pr-check` (the admin repo's gate: build, lint, then parallel review). Address anything it raises before opening the PR.
