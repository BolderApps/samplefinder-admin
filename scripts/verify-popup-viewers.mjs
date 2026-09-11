// Verification for the pop-up viewer list logic (src/lib/popupViewers.ts).
//
// Run with:  npm run verify:popup-viewers
//
// This backs the "Who saw this pop-up" table on the pop-up detail page. The Statistics
// function now returns ONE ROW PER USER (see SAM-12) — a repeat sighting bumps `impressions`
// instead of adding a row — so everything here narrows and orders per-user aggregates, not
// individual sightings. A wrong predicate means the admin is told the wrong people saw a
// campaign, which is exactly the question the client asked us to answer.
//
// The assertions pin the decisions that are easy to regress: missing timestamps sorting last
// in BOTH directions, a date range matched against the days a user was ACTUALLY shown the
// pop-up (not the span between their first and last sighting), and search spanning
// name + username.
//
// Exits non-zero on any failed assertion.

// Compiled to CommonJS (unlike the single-file verify scripts) because popupViewers imports
// userSearch: tsc emits that as an extensionless relative import, which ESM cannot resolve but
// require() can.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  filterViewers,
  sortViewers,
  filterAndSortViewers,
  hasActiveViewerFilters,
  initialViewerFilters,
  rollUpLegacyViewers,
} = require('./.pvcheck/popupViewers.js')

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

// One row = one user. `dayKeys` are the Eastern calendar days the Mobile API stamped on that
// user's interaction rows; they are what the date filter matches, so they are spelled out on
// every fixture rather than derived from the timestamps.
const viewer = (over) => ({
  userId: 'u0',
  name: 'Nobody',
  username: 'nobody',
  impressions: 1,
  firstShownAt: '2026-09-11T12:00:00.000+00:00',
  lastShownAt: '2026-09-11T12:00:00.000+00:00',
  clickedAt: null,
  dayKeys: ['2026-09-11'],
  is21Plus: true,
  ...over,
})

// Deliberately NOT in timestamp order, so a passing sort assertion cannot be an accident.
const kelsey = viewer({
  userId: 'u1', name: 'Kelsey Cooper', username: 'kelseyallyn',
  firstShownAt: '2026-09-11T14:00:00.000+00:00',
  lastShownAt: '2026-09-11T14:00:00.000+00:00',
  clickedAt: '2026-09-11T14:05:00.000+00:00',
  dayKeys: ['2026-09-11'],
})
const al = viewer({
  userId: 'u2', name: 'Al Schuster', username: 'RagnaRock4379',
  firstShownAt: '2026-09-09T09:00:00.000+00:00',
  lastShownAt: '2026-09-09T09:00:00.000+00:00',
  clickedAt: null,
  dayKeys: ['2026-09-09'],
})
const kassy = viewer({
  userId: 'u3', name: 'Kassy Pierre', username: 'karaapierre',
  firstShownAt: '2026-09-10T23:30:00.000+00:00',
  lastShownAt: '2026-09-10T23:30:00.000+00:00',
  clickedAt: '2026-09-10T23:31:00.000+00:00',
  dayKeys: ['2026-09-10'],
})
const minor = viewer({
  userId: 'u4', name: 'Teen Tester', username: 'teen',
  firstShownAt: '2026-09-10T08:00:00.000+00:00',
  lastShownAt: '2026-09-10T08:00:00.000+00:00',
  clickedAt: null, is21Plus: false,
  dayKeys: ['2026-09-10'],
})
// A deleted profile: the function falls back to the raw id for the name. No placeable sighting.
const orphan = viewer({
  userId: 'u5', name: 'u5', username: '',
  firstShownAt: null, lastShownAt: null, clickedAt: null, dayKeys: [],
})

const ALL = [kelsey, al, kassy, minor, orphan]
const ids = (rows) => rows.map((r) => r.userId)
const filtered = (rows, f) => filterViewers(rows, f)
const f = (over) => ({ ...initialViewerFilters, ...over })

console.log('\n--- no filters ---')
eq('everything passes an empty filter set', ids(filtered(ALL, f())), ['u1', 'u2', 'u3', 'u4', 'u5'])
eq('empty filter set is not "active"', hasActiveViewerFilters(f()), false)

console.log('\n--- search spans name and username (the fix carried over from userSearch) ---')
eq('full name across both name words', ids(filtered(ALL, f({ search: 'Kelsey Cooper' }))), ['u1'])
eq('reversed token order still matches', ids(filtered(ALL, f({ search: 'Cooper Kelsey' }))), ['u1'])
eq('username matches', ids(filtered(ALL, f({ search: 'ragna' }))), ['u2'])
eq('name + username together match one row', ids(filtered(ALL, f({ search: 'Al RagnaRock' }))), ['u2'])
eq('case-insensitive', ids(filtered(ALL, f({ search: 'KASSY' }))), ['u3'])
eq('partial token', ids(filtered(ALL, f({ search: 'pier' }))), ['u3'])
eq('no match yields nothing', ids(filtered(ALL, f({ search: 'zzz' }))), [])
eq('whitespace-only search is not a filter', ids(filtered(ALL, f({ search: '   ' }))), ['u1', 'u2', 'u3', 'u4', 'u5'])
eq('a row with an empty username still matches on its name', ids(filtered(ALL, f({ search: 'u5' }))), ['u5'])
eq('search counts as an active filter', hasActiveViewerFilters(f({ search: 'a' })), true)
eq('whitespace-only search does NOT count as active', hasActiveViewerFilters(f({ search: '  ' })), false)

console.log('\n--- engagement (a click on ANY sighting makes the user a clicker) ---')
eq('clicked only', ids(filtered(ALL, f({ engagement: 'clicked' }))), ['u1', 'u3'])
eq('did not click', ids(filtered(ALL, f({ engagement: 'notClicked' }))), ['u2', 'u4', 'u5'])
eq('clicked + notClicked partition the whole list',
  filtered(ALL, f({ engagement: 'clicked' })).length +
  filtered(ALL, f({ engagement: 'notClicked' })).length, ALL.length)
eq('a repeat viewer who clicked once counts as a clicker',
  ids(filtered([viewer({ userId: 'rep', impressions: 4, clickedAt: '2026-09-11T15:00:00.000+00:00' })],
    f({ engagement: 'clicked' }))), ['rep'])
eq('a repeat viewer who never clicked counts as a non-clicker',
  ids(filtered([viewer({ userId: 'rep', impressions: 4 })], f({ engagement: 'notClicked' }))), ['rep'])

console.log('\n--- age gate recorded at display time ---')
eq('21+ only', ids(filtered(ALL, f({ age: '21plus' }))), ['u1', 'u2', 'u3', 'u5'])
eq('under 21 only', ids(filtered(ALL, f({ age: 'under21' }))), ['u4'])

console.log('\n--- date range matches the days a user was ACTUALLY shown the pop-up ---')
// The picker hands back local midnight; only the calendar day it names is used, and that is
// compared against the Eastern dayKeys the Mobile API stamped on each interaction row.
const day = (iso) => new Date(iso)
const sep10 = { start: day('2026-09-10T00:00:00'), end: null }
const shownOnSep10 = ids(filtered(ALL, f({ dateRange: sep10 })))
eq('single-day pick keeps every row shown that Eastern day', shownOnSep10, ['u3', 'u4'])
eq('single-day pick excludes the day before', shownOnSep10.includes('u2'), false)
eq('single-day pick excludes the day after', shownOnSep10.includes('u1'), false)
eq('a row with no sighting drops out of a date-narrowed view', shownOnSep10.includes('u5'), false)
eq('but it survives when no range is set', ids(filtered(ALL, f())).includes('u5'), true)
eq('multi-day range', ids(filtered(ALL, f({
  dateRange: { start: day('2026-09-09T00:00:00'), end: day('2026-09-10T00:00:00') },
}))).sort(), ['u2', 'u3', 'u4'])
eq('the END day of a range is INCLUSIVE', ids(filtered(ALL, f({
  dateRange: { start: day('2026-09-09T00:00:00'), end: day('2026-09-11T00:00:00') },
}))).sort(), ['u1', 'u2', 'u3', 'u4'])
eq('the day after the range end is excluded', ids(filtered(ALL, f({
  dateRange: { start: day('2026-09-09T00:00:00'), end: day('2026-09-10T00:00:00') },
}))).includes('u1'), false)
eq('a date range counts as an active filter',
  hasActiveViewerFilters(f({ dateRange: sep10 })), true)

console.log('\n--- SAM-12: a gap day must NOT match on span alone ---')
// Seen on the 9th and again on the 14th, never on the 11th. Testing first..last as a span
// would wrongly report this person as having seen the campaign on the 11th.
const gapUser = viewer({
  userId: 'gap', name: 'Gap User', username: 'gap',
  impressions: 2,
  firstShownAt: '2026-09-09T13:00:00.000+00:00',
  lastShownAt: '2026-09-14T13:00:00.000+00:00',
  dayKeys: ['2026-09-09', '2026-09-14'],
})
eq('a day inside the span but with no sighting does NOT match',
  ids(filtered([gapUser], f({ dateRange: { start: day('2026-09-11T00:00:00'), end: null } }))), [])
eq('the first sighting day matches',
  ids(filtered([gapUser], f({ dateRange: { start: day('2026-09-09T00:00:00'), end: null } }))), ['gap'])
eq('the last sighting day matches',
  ids(filtered([gapUser], f({ dateRange: { start: day('2026-09-14T00:00:00'), end: null } }))), ['gap'])
eq('a range spanning both sighting days matches once, not twice',
  ids(filtered([gapUser], f({
    dateRange: { start: day('2026-09-09T00:00:00'), end: day('2026-09-14T00:00:00') },
  }))), ['gap'])
eq('a range covering only the gap matches nothing',
  ids(filtered([gapUser], f({
    dateRange: { start: day('2026-09-10T00:00:00'), end: day('2026-09-13T00:00:00') },
  }))), [])

console.log('\n--- combining filters ---')
eq('search + engagement', ids(filtered(ALL, f({ search: 'a', engagement: 'clicked' }))), ['u1', 'u3'])
eq('engagement + age excludes the under-21 non-clicker',
  ids(filtered(ALL, f({ engagement: 'notClicked', age: '21plus' }))), ['u2', 'u5'])

console.log('\n--- sorting: missing timestamps last in BOTH directions ---')
eq('last seen desc', ids(sortViewers(ALL, 'lastShownAt', 'desc')), ['u1', 'u3', 'u4', 'u2', 'u5'])
eq('last seen asc', ids(sortViewers(ALL, 'lastShownAt', 'asc')), ['u2', 'u4', 'u3', 'u1', 'u5'])
eq('no-sighting row is last when descending', ids(sortViewers(ALL, 'lastShownAt', 'desc')).at(-1), 'u5')
eq('no-sighting row is STILL last when ascending', ids(sortViewers(ALL, 'lastShownAt', 'asc')).at(-1), 'u5')
eq('clicked desc puts clickers first', ids(sortViewers(ALL, 'clickedAt', 'desc')).slice(0, 2), ['u1', 'u3'])
eq('clicked asc does NOT flood the top with non-clickers',
  ids(sortViewers(ALL, 'clickedAt', 'asc')).slice(0, 2), ['u3', 'u1'])
eq('non-clickers stay grouped at the bottom, ascending',
  ids(sortViewers(ALL, 'clickedAt', 'asc')).slice(2).sort(), ['u2', 'u4', 'u5'])
eq('name asc', ids(sortViewers(ALL, 'name', 'asc')), ['u2', 'u3', 'u1', 'u4', 'u5'])
eq('name desc', ids(sortViewers(ALL, 'name', 'desc')), ['u5', 'u4', 'u1', 'u3', 'u2'])

console.log('\n--- sorting by last seen uses the LAST sighting, not the first ---')
// An early adopter who came back late outranks someone whose whole run sits in between.
const early = viewer({
  userId: 'early', name: 'Early Bird', username: 'early', impressions: 2,
  firstShownAt: '2026-09-01T12:00:00.000+00:00',
  lastShownAt: '2026-09-20T12:00:00.000+00:00',
  dayKeys: ['2026-09-01', '2026-09-20'],
})
const middle = viewer({
  userId: 'middle', name: 'Middle', username: 'middle', impressions: 2,
  firstShownAt: '2026-09-10T12:00:00.000+00:00',
  lastShownAt: '2026-09-12T12:00:00.000+00:00',
  dayKeys: ['2026-09-10', '2026-09-12'],
})
eq('most recently seen first', ids(sortViewers([middle, early], 'lastShownAt', 'desc')), ['early', 'middle'])
eq('and the span start does not decide it', ids(sortViewers([middle, early], 'lastShownAt', 'asc')), ['middle', 'early'])

console.log('\n--- sorting by impressions (the new column) ---')
const once = viewer({ userId: 'once', name: 'Once', username: 'once', impressions: 1 })
const twice = viewer({ userId: 'twice', name: 'Twice', username: 'twice', impressions: 2 })
const fiveTimes = viewer({ userId: 'five', name: 'Five', username: 'five', impressions: 5 })
const REPEATS = [once, fiveTimes, twice]
eq('most impressions first', ids(sortViewers(REPEATS, 'impressions', 'desc')), ['five', 'twice', 'once'])
eq('fewest impressions first', ids(sortViewers(REPEATS, 'impressions', 'asc')), ['once', 'twice', 'five'])
eq('equal impression counts break ties by userId',
  ids(sortViewers([viewer({ userId: 'b', impressions: 3 }), viewer({ userId: 'a', impressions: 3 })],
    'impressions', 'desc')), ['a', 'b'])

console.log('\n--- sorting is stable and non-mutating ---')
const tieA = viewer({ userId: 'b', name: 'Same Time', lastShownAt: '2026-09-11T10:00:00.000+00:00' })
const tieB = viewer({ userId: 'a', name: 'Same Time', lastShownAt: '2026-09-11T10:00:00.000+00:00' })
eq('equal timestamps break ties by userId', ids(sortViewers([tieA, tieB], 'lastShownAt', 'desc')), ['a', 'b'])
eq('same tie order in the other direction (so paging cannot reshuffle)',
  ids(sortViewers([tieA, tieB], 'lastShownAt', 'asc')), ['a', 'b'])
const before = ids(ALL)
sortViewers(ALL, 'name', 'asc')
eq('the input array is not mutated', ids(ALL), before)

console.log('\n--- filterAndSortViewers composes both ---')
eq('clicked, most recent first',
  ids(filterAndSortViewers(ALL, f({ engagement: 'clicked', sortBy: 'lastShownAt', sortOrder: 'desc' }))),
  ['u1', 'u3'])
eq('empty result when nothing matches',
  ids(filterAndSortViewers(ALL, f({ search: 'zzz' }))), [])
eq('an empty input list is handled', ids(filterAndSortViewers([], f())), [])

console.log('\n--- legacy payload fallback (new admin build, old Statistics function) ---')
// Pre-SAM-12 the function sent one row per sighting. Newest first, as it did.
const LEGACY = [
  { userId: 'a', name: 'Repeat Rita', username: 'rita', shownAt: '2026-09-11T18:39:00.000+00:00', clickedAt: null, is21Plus: true },
  { userId: 'a', name: 'Repeat Rita', username: 'rita', shownAt: '2026-09-11T16:19:00.000+00:00', clickedAt: '2026-09-11T16:20:00.000+00:00', is21Plus: true },
  { userId: 'a', name: 'Repeat Rita', username: 'rita', shownAt: '2026-09-09T15:00:00.000+00:00', clickedAt: null, is21Plus: true },
  { userId: 'b', name: 'Solo Sam', username: 'sam', shownAt: '2026-09-10T15:00:00.000+00:00', clickedAt: null, is21Plus: false },
]
const rolled = rollUpLegacyViewers(LEGACY)
eq('three sightings collapse to one user', rolled.length, 2)
eq('impressions counts every sighting', rolled[0].impressions, 3)
eq('a single sighting stays at 1', rolled[1].impressions, 1)
eq('first shown is the EARLIEST sighting', rolled[0].firstShownAt, '2026-09-09T15:00:00.000+00:00')
eq('last shown is the LATEST sighting', rolled[0].lastShownAt, '2026-09-11T18:39:00.000+00:00')
eq('a click on any sighting survives the rollup', rolled[0].clickedAt, '2026-09-11T16:20:00.000+00:00')
// 18:39Z and 16:19Z are both Sep 11 Eastern; 15:00Z is Sep 9. Two distinct days, not three.
eq('day keys are the distinct Eastern days, sorted', rolled[0].dayKeys, ['2026-09-09', '2026-09-11'])
eq('the rolled-up rows filter by day like server rows do',
  ids(filtered(rolled, f({ dateRange: { start: day('2026-09-11T00:00:00'), end: null } }))), ['a'])
eq('and a gap day still excludes them',
  ids(filtered(rolled, f({ dateRange: { start: day('2026-09-10T00:00:00'), end: null } }))), ['b'])
eq('an empty legacy payload is handled', rollUpLegacyViewers([]), [])

// The day boundary is a business rule pinned to Eastern inside the rollup, NOT the timezone of
// the admin's browser or of the machine running this script — so these hold everywhere.
const nearMidnight = rollUpLegacyViewers([
  { userId: 'm', name: 'M', username: 'm', shownAt: '2026-09-12T03:30:00.000Z', clickedAt: null, is21Plus: true },
  { userId: 'm', name: 'M', username: 'm', shownAt: '2026-09-12T04:30:00.000Z', clickedAt: null, is21Plus: true },
])
// 03:30Z is 11:30 PM Eastern on the 11th; 04:30Z is 12:30 AM Eastern on the 12th.
eq('a sighting just before Eastern midnight belongs to the previous day',
  nearMidnight[0].dayKeys, ['2026-09-11', '2026-09-12'])

console.log('\n--- timestamps are parsed, never compared as strings ---')
// Appwrite can hand back different offset spellings for the same column. Compared as text,
// "T20:00...+00:00" looks later than "T18:00...-05:00" — but the second instant is three hours
// AFTER the first, so a string comparison reports the wrong last sighting and drags the age
// gate along with it.
const mixedOffsets = rollUpLegacyViewers([
  { userId: 'x', name: 'X', username: 'x', shownAt: '2026-09-11T20:00:00.000+00:00', clickedAt: '2026-09-11T20:05:00.000+00:00', is21Plus: true },
  { userId: 'x', name: 'X', username: 'x', shownAt: '2026-09-11T18:00:00.000-05:00', clickedAt: '2026-09-11T18:05:00.000-05:00', is21Plus: false },
])
eq('the genuinely latest instant wins, not the lexicographically largest',
  mixedOffsets[0].lastShownAt, '2026-09-11T18:00:00.000-05:00')
eq('and the genuinely earliest one is reported as first',
  mixedOffsets[0].firstShownAt, '2026-09-11T20:00:00.000+00:00')
eq('the age gate follows the real latest sighting', mixedOffsets[0].is21Plus, false)
eq('the latest click is chosen the same way',
  mixedOffsets[0].clickedAt, '2026-09-11T18:05:00.000-05:00')
eq('an unparseable timestamp never wins the earliest-sighting comparison',
  rollUpLegacyViewers([
    { userId: 'bad', name: 'B', username: 'b', shownAt: 'not-a-date', clickedAt: null, is21Plus: true },
    { userId: 'bad', name: 'B', username: 'b', shownAt: '2026-09-11T12:00:00.000+00:00', clickedAt: null, is21Plus: true },
  ])[0].firstShownAt, '2026-09-11T12:00:00.000+00:00')

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll pop-up viewer list assertions passed')
