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
const { normalizeForCompare, statesMatch, zipsMatch, diffAddress, resolveStateForWrite } =
  require('./.licheck/normalizeAddress.js')
const { findDuplicates } = require('./.licheck/findDuplicates.js')
const { buildGeocodeQuery, mapGeocodeResponse, createGoogleGeocoder } =
  require('./.licheck/geocodeAddress.js')
const { classifyRow, applyAddressEdit } = require('./.licheck/classifyRow.js')
const { classifyAll } = require('./.licheck/classifyAll.js')

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

// --- normalizeAddress --------------------------------------------------------

eq('street suffixes fold to their abbreviation',
  normalizeForCompare('1650 S Broad Street'), '1650 S BROAD ST')

eq('directional words fold to their abbreviation',
  normalizeForCompare('1650 North Broad St'), '1650 N BROAD ST')

eq('North Broad St and N Broad St compare equal',
  normalizeForCompare('1650 North Broad Street') === normalizeForCompare('1650 N Broad St'),
  true)

eq('a MISSING directional does NOT compare equal — the client\'s own example',
  normalizeForCompare('1650 Broad St') === normalizeForCompare('1650 S Broad St'),
  false)

eq('punctuation and repeated whitespace are ignored',
  normalizeForCompare('  1650  S. Broad St.  '), '1650 S BROAD ST')

eq('state matches Google\'s short name',
  statesMatch('PA', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('state matches Google\'s long name',
  statesMatch('Pennsylvania', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('state casing is ignored',
  statesMatch('pennsylvania', { state: 'Pennsylvania', stateShort: 'PA' }), true)

eq('a genuinely different state does not match',
  statesMatch('NJ', { state: 'Pennsylvania', stateShort: 'PA' }), false)

eq('ZIP+4 matches Google\'s 5 digits', zipsMatch('19145-1234', '19145'), true)
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

eq('a fetch that throws degrades to a row failure rather than propagating',
  (await createGoogleGeocoder('k', async () => { throw new Error('network down') })(
    { address: '1650 S Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' })).kind,
  'none')

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

eq('when partial match AND field diffs both exist, partial match reason wins',
  classifyRow(parsed({ address: '1650 Broad St' }), matchOutcome({ partialMatch: true })).reason,
  'Google returned only a partial match')

eq('when imprecise location AND field diffs both exist, imprecise location reason wins',
  classifyRow(parsed({ address: '1650 Broad St' }), matchOutcome({ locationType: 'APPROXIMATE' })).reason,
  'Google could only match this address approximately')

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

// --- resolveStateForWrite ----------------------------------------------------
// Which spelling of the state actually reaches Appwrite. Google's long name is
// canonical (AddressAutocomplete and LocationPicker both store long_name), but a
// state the operator deliberately kept via "Keep mine" is their call, not ours.
const paMatch = { state: 'Pennsylvania', stateShort: 'PA' }

eq('a typed abbreviation widens to the canonical long name',
  resolveStateForWrite('PA', paMatch), 'Pennsylvania')

eq('a typed long name is stored unchanged',
  resolveStateForWrite('Pennsylvania', paMatch), 'Pennsylvania')

eq('a lowercase abbreviation still widens',
  resolveStateForWrite('pa', paMatch), 'Pennsylvania')

eq('a state the operator kept on purpose is never overwritten',
  resolveStateForWrite('New Jersey', paMatch), 'New Jersey')

eq('with no match the typed value is stored as-is',
  resolveStateForWrite('PA', null), 'PA')

// --- applyAddressEdit --------------------------------------------------------
// The edit form covers address/city/state/zip only. A rejection it cannot repair
// must survive the edit, or the row classifies 'ready' and writes a record the
// event importer's exact-name lookup could never resolve.
const editFields = { address: '1650 S Broad St', city: 'Philadelphia', state: 'PA', zipCode: '19145' }

const namelessRow = { rowNumber: 1, name: '', address: '', city: '', state: '', zipCode: '',
                      parseError: 'Missing required field: Name' }

eq('editing the address cannot clear a blank-name rejection',
  applyAddressEdit(namelessRow, editFields).parseError, 'Missing required field: Name')

eq('a nameless row stays failed even after a clean geocode',
  classifyRow(applyAddressEdit(namelessRow, editFields), matchOutcome()).status, 'failed')

const blankAddressRow = { rowNumber: 2, name: 'Corner Store', address: '', city: 'Philadelphia',
                          state: 'PA', zipCode: '19145',
                          parseError: 'Missing required field: Address' }

eq('editing the address does clear an address rejection',
  applyAddressEdit(blankAddressRow, editFields).parseError, null)

eq('the edited fields are applied to the row',
  [applyAddressEdit(blankAddressRow, editFields).address,
   applyAddressEdit(blankAddressRow, editFields).city],
  ['1650 S Broad St', 'Philadelphia'])

eq('a repairable row reaches ready after an edit',
  classifyRow(applyAddressEdit(blankAddressRow, editFields), matchOutcome()).status, 'ready')

eq('a whitespace-only name counts as blank',
  applyAddressEdit({ ...namelessRow, name: '   ' }, editFields).parseError,
  'Missing required field: Name')

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll location import assertions passed')
