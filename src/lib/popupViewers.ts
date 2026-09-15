// Pure search / filter / sort for the pop-up viewer list ("Who saw this pop-up").
//
// Kept dependency-free and outside the component so it can be executed directly by
// scripts/verify-popup-viewers.mjs, the same arrangement as lib/userSearch.ts and
// lib/userListView.ts. Everything here runs client-side over the rows the Statistics
// function returns (capped at 1000 USERS, most recently seen first); a server-side filter
// would hide matching rows inside that cap.
//
// One row is one user, not one sighting (SAM-12). A repeat viewer arrives as a single row
// with `impressions` > 1, so nothing here needs to group — it narrows and orders aggregates
// the function already rolled up.

import { matchesAllTokens } from './userSearch'
import type { SortOrder } from './userListView'

/**
 * The fields this module needs. `PopupViewerRow` from services.ts satisfies it —
 * declared structurally so the verification script can build fixtures without
 * pulling in the Appwrite client.
 */
export interface ViewerLike {
  userId: string
  name: string
  username: string
  /** How many times this user was shown the pop-up; 1 for everyone who saw it once. */
  impressions: number
  firstShownAt: string | null
  lastShownAt: string | null
  /** The most recent click, or null for a user who never clicked on any sighting. */
  clickedAt: string | null
  /**
   * The distinct Eastern calendar days ("YYYY-MM-DD") this user was shown the pop-up, taken
   * from the `dayKey` the Mobile API stamps on every interaction row. The date filter matches
   * these rather than the first..last span: a user shown on the 9th and again on the 14th
   * never saw it on the 11th, and a span test would report that they had.
   */
  dayKeys: readonly string[]
  is21Plus: boolean
}

export type ViewerEngagementFilter = 'all' | 'clicked' | 'notClicked'
export type ViewerAgeFilter = 'all' | '21plus' | 'under21'
export type ViewerSortBy = 'lastShownAt' | 'impressions' | 'clickedAt' | 'name'

export interface ViewerDateRange {
  start: Date | null
  end: Date | null
}

export interface ViewerFilters {
  search: string
  engagement: ViewerEngagementFilter
  age: ViewerAgeFilter
  dateRange: ViewerDateRange
  sortBy: ViewerSortBy
  sortOrder: SortOrder
}

/** Most recently seen first — the order the function already returns rows in. */
export const initialViewerFilters: ViewerFilters = {
  search: '',
  engagement: 'all',
  age: 'all',
  dateRange: { start: null, end: null },
  sortBy: 'lastShownAt',
  sortOrder: 'desc',
}

export const ENGAGEMENT_LABELS: Record<ViewerEngagementFilter, string> = {
  all: 'All Viewers',
  clicked: 'Clicked',
  notClicked: 'Did Not Click',
}

// "All" must not read as "everyone is 21+": these describe the viewer at the moment
// the pop-up was shown, which is what the interaction row recorded.
export const VIEWER_AGE_LABELS: Record<ViewerAgeFilter, string> = {
  all: 'All Age Groups',
  '21plus': '21+ when shown',
  under21: 'Under 21 when shown',
}

export const VIEWER_SORT_LABELS: Record<ViewerSortBy, string> = {
  lastShownAt: 'Last Seen',
  impressions: 'Impressions',
  clickedAt: 'Clicked',
  name: 'Name',
}

/**
 * True when anything narrows the list. Sort is deliberately excluded: reordering
 * hides nothing, so offering to "clear" it would be misleading.
 */
export const hasActiveViewerFilters = (filters: ViewerFilters): boolean =>
  filters.search.trim() !== '' ||
  filters.engagement !== 'all' ||
  filters.age !== 'all' ||
  filters.dateRange.start !== null

const pad = (n: number): string => String(n).padStart(2, '0')

/** The calendar date the admin picked. The picker builds Dates at LOCAL midnight. */
const pickedDayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * The picked span as inclusive "YYYY-MM-DD" bounds, comparable to `dayKeys` as plain strings
 * because that format sorts lexicographically.
 *
 * Both ends are inclusive: the admin picking the 9th through the 10th means both days, and an
 * exclusive end would silently drop everyone shown on the last day they asked for. The bounds
 * are ordered defensively so an end-before-start selection narrows to that span rather than
 * rendering an empty table with no explanation.
 */
const dayKeyBounds = (dateRange: ViewerDateRange): { first: string; last: string } | null => {
  if (!dateRange.start) return null
  const a = pickedDayKey(dateRange.start)
  const b = pickedDayKey(dateRange.end ?? dateRange.start)
  return a <= b ? { first: a, last: b } : { first: b, last: a }
}

export function filterViewers<T extends ViewerLike>(
  rows: readonly T[],
  filters: ViewerFilters
): T[] {
  const bounds = dayKeyBounds(filters.dateRange)

  return rows.filter((row) => {
    if (!matchesAllTokens([row.name, row.username], filters.search)) return false

    if (filters.engagement === 'clicked' && !row.clickedAt) return false
    if (filters.engagement === 'notClicked' && row.clickedAt) return false

    if (filters.age === '21plus' && !row.is21Plus) return false
    if (filters.age === 'under21' && row.is21Plus) return false

    if (bounds) {
      // A user with no recorded day cannot be placed on a timeline, so they drop out of a
      // date-narrowed view rather than being silently treated as in range.
      const seenInRange = row.dayKeys.some((key) => key >= bounds.first && key <= bounds.last)
      if (!seenInRange) return false
    }

    return true
  })
}

const displayName = (row: ViewerLike): string =>
  (row.name || row.username || row.userId).toLowerCase()

/**
 * Sort a copy of `rows`.
 *
 * Missing timestamps always sort last, in BOTH directions. A null `clickedAt` means
 * "never clicked", not "clicked at the beginning of time": treating it as a value
 * would flood the top of an ascending sort with people who never engaged, which is
 * the opposite of what an admin sorting by Clicked is looking for.
 *
 * `userId` breaks ties so paging through equal values cannot reshuffle rows
 * between renders.
 */
export function sortViewers<T extends ViewerLike>(
  rows: readonly T[],
  sortBy: ViewerSortBy,
  sortOrder: SortOrder
): T[] {
  const direction = sortOrder === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    let result = 0

    if (sortBy === 'name') {
      result = displayName(a).localeCompare(displayName(b)) * direction
    } else if (sortBy === 'impressions') {
      // Always a number, so there is no "missing" case to park at the bottom.
      result = (a.impressions - b.impressions) * direction
    } else {
      const aRaw = sortBy === 'lastShownAt' ? a.lastShownAt : a.clickedAt
      const bRaw = sortBy === 'lastShownAt' ? b.lastShownAt : b.clickedAt
      const aTime = aRaw ? Date.parse(aRaw) : NaN
      const bTime = bRaw ? Date.parse(bRaw) : NaN
      const aMissing = Number.isNaN(aTime)
      const bMissing = Number.isNaN(bTime)

      if (aMissing || bMissing) {
        if (aMissing && bMissing) result = 0
        else result = aMissing ? 1 : -1 // missing last, whichever way we're sorting
      } else {
        result = (aTime - bTime) * direction
      }
    }

    return result !== 0 ? result : a.userId.localeCompare(b.userId)
  })
}

export function filterAndSortViewers<T extends ViewerLike>(
  rows: readonly T[],
  filters: ViewerFilters
): T[] {
  return sortViewers(filterViewers(rows, filters), filters.sortBy, filters.sortOrder)
}

/** A viewer built here rather than received, with `dayKeys` owned outright so it stays writable. */
export type RolledUpViewer = Omit<ViewerLike, 'dayKeys'> & { dayKeys: string[] }

/** The pre-SAM-12 wire shape: one row per sighting, no counts and no day keys. */
export interface LegacyViewerRow {
  userId: string
  name: string
  username: string
  shownAt: string | null
  clickedAt: string | null
  is21Plus: boolean
}

/**
 * The zone the pop-up day boundary is drawn in. This is a fixed business rule, not a display
 * preference: the Mobile API stamps every `dayKey` with POPUP_APP_TIMEZONE, hardcoded to this
 * same value. Deriving it from the admin's own timezone instead — `appTimezone` in the store
 * is simply `Intl.DateTimeFormat().resolvedOptions().timeZone` — would put sightings near
 * midnight on the wrong day for any admin outside Eastern, reintroducing in this fallback the
 * very wrong-day reporting SAM-12 set out to fix.
 */
const POPUP_DAY_TIMEZONE = 'America/New_York'

/** Day key (YYYY-MM-DD) — mirrors getPopupDayKey in the Mobile API. */
const dayKeyForSighting = (iso: string): string | null => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: POPUP_DAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * Roll a pre-SAM-12 payload (one row per sighting) up into the per-user shape.
 *
 * Only reachable in the window where a new admin build is talking to a Statistics function
 * that has not been redeployed yet, so the page degrades instead of rendering blank counts.
 * Grouping here still gets every listed user an accurate count, but the old cap applied to
 * raw sightings rather than users, so a campaign past 1000 sightings can understate — which
 * is precisely why the real rollup lives on the server.
 */
export function rollUpLegacyViewers(rows: readonly LegacyViewerRow[]): RolledUpViewer[] {
  const byUser = new Map<string, RolledUpViewer>()
  // Parsed epochs for the row currently winning each comparison, keyed by user. Held beside
  // the map rather than on the rows themselves so the returned shape stays exactly
  // PopupViewerRow. Timestamps are never compared as strings — see ViewerAggregate in the
  // Statistics function for why.
  const marks = new Map<string, { first: number; last: number; clicked: number }>()

  for (const row of rows) {
    let agg = byUser.get(row.userId)
    let mark = marks.get(row.userId)
    if (!agg || !mark) {
      // Rows arrive newest first, so the row that creates the entry carries the age gate
      // that applied most recently.
      agg = {
        userId: row.userId,
        name: row.name,
        username: row.username,
        impressions: 0,
        firstShownAt: null,
        lastShownAt: null,
        clickedAt: null,
        dayKeys: [],
        is21Plus: row.is21Plus,
      }
      byUser.set(row.userId, agg)
      mark = { first: NaN, last: NaN, clicked: NaN }
      marks.set(row.userId, mark)
    }

    agg.impressions++

    const shownAtMs = row.shownAt ? Date.parse(row.shownAt) : NaN
    if (row.shownAt && Number.isFinite(shownAtMs)) {
      if (!Number.isFinite(mark.first) || shownAtMs < mark.first) {
        agg.firstShownAt = row.shownAt
        mark.first = shownAtMs
      }
      if (!Number.isFinite(mark.last) || shownAtMs > mark.last) {
        agg.lastShownAt = row.shownAt
        mark.last = shownAtMs
        agg.is21Plus = row.is21Plus
      }
      const key = dayKeyForSighting(row.shownAt)
      if (key && !agg.dayKeys.includes(key)) agg.dayKeys.push(key)
    }

    const clickedAtMs = row.clickedAt ? Date.parse(row.clickedAt) : NaN
    if (
      row.clickedAt &&
      Number.isFinite(clickedAtMs) &&
      (!Number.isFinite(mark.clicked) || clickedAtMs > mark.clicked)
    ) {
      agg.clickedAt = row.clickedAt
      mark.clicked = clickedAtMs
    }
  }

  for (const agg of byUser.values()) agg.dayKeys.sort()
  return Array.from(byUser.values())
}
