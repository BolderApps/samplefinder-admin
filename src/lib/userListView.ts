// Pure filter/sort/paginate for the Users list screen.
//
// Why this exists — the performance problem it solves:
// the Users page used to resolve search, tier filtering and the email/tier sorts by REFETCHING.
// Every debounced keystroke re-read every profile in the collection and then re-resolved an Auth
// email for each one through the get-user-emails Function. Measured against production, one search
// cost ~20s (27 Function executions) and refining a search cost up to ~77s (163 executions).
//
// None of that work depends on the server: the whole matching set is already in the browser after
// the first load. So the page now loads the full set once and calls buildUserListView() for every
// subsequent interaction — search, tier filter, sort, page change — at zero network cost.
//
// Kept free of the Appwrite SDK so scripts/verify-user-list-view.mjs can compile and exercise it
// standalone, the same way userSearch.ts is verified.

import { matchesAllTokens } from './userSearch'

/** The subset of a user row this module reads. AppUser satisfies it structurally. */
export interface UserListRow {
  $id: string
  $createdAt?: string
  firstname?: string
  lastname?: string
  username?: string
  email?: string
  phoneNumber?: string
  dob?: string
  tierLevel?: string
  totalPoints?: number
  totalEvents?: number
  totalReviews?: number
}

export type UserSortBy =
  | 'createdAt'
  | 'name'
  | 'points'
  | 'events'
  | 'reviews'
  | 'email'
  | 'tierLevel'
  | 'dob'

export type SortOrder = 'asc' | 'desc'

export const ALL_TIERS = 'All Tiers'

export interface UserListViewOptions<T extends UserListRow> {
  searchQuery: string
  /** Tier name, or ALL_TIERS for no tier filtering. Compared against the EFFECTIVE tier. */
  tierFilter: string
  sortBy: UserSortBy
  sortOrder: SortOrder
  page: number
  pageSize: number
  /** Tier name -> rank, for the tierLevel sort. Unknown tiers sort last. */
  tierOrderMap?: Record<string, number>
  /**
   * Substitutes the stored tierLevel with the effective one (max of stored vs points-derived) so the
   * table shows the same tier the mobile app does. Injected rather than imported to keep this module
   * SDK-free; omit it to use the stored value as-is.
   */
  resolveTier?: (user: T) => string
}

export interface UserListView<T extends UserListRow> {
  /** The rows for the requested page, after filtering and sorting. */
  rows: T[]
  /** Rows matching the filters, across all pages. Drives the pagination footer. */
  total: number
  totalPages: number
  /** Clamped page actually returned — `page` past the end falls back to the last page. */
  page: number
}

/** Digits only, for phone matching. */
const digits = (value: string): string => value.replace(/\D/g, '')

/**
 * Classifies the query the same way the page did server-side before:
 * an '@' means match emails only, an all-digits query of 3+ digits means match phone numbers only,
 * anything else is a token search across name/username/email.
 */
function matchesSearch<T extends UserListRow>(user: T, trimmedSearch: string): boolean {
  if (trimmedSearch === '') return true

  if (trimmedSearch.includes('@')) {
    return !!user.email?.toLowerCase().includes(trimmedSearch.toLowerCase())
  }

  const queryDigits = digits(trimmedSearch)
  if (queryDigits === trimmedSearch && queryDigits.length >= 3) {
    return digits(user.phoneNumber || '').includes(queryDigits)
  }

  // Token search: every word must appear in at least one field, so a full name matches across
  // firstname + lastname. See userSearch.ts for the defect that rule fixes.
  return matchesAllTokens(
    [user.firstname, user.lastname, user.username, user.email],
    trimmedSearch
  )
}

/** Missing values sort last in BOTH directions, so blanks never displace real data. */
export function compareWithBlanksLast(
  aBlank: boolean,
  bBlank: boolean
): number | null {
  if (aBlank && bBlank) return 0
  if (aBlank) return 1
  if (bBlank) return -1
  return null
}

function compareUsers<T extends UserListRow>(
  a: T,
  b: T,
  sortBy: UserSortBy,
  sortOrder: SortOrder,
  tierOrderMap: Record<string, number>,
  tierOf: (user: T) => string
): number {
  const dir = sortOrder === 'asc' ? 1 : -1

  switch (sortBy) {
    case 'points':
    case 'events':
    case 'reviews': {
      const field =
        sortBy === 'points' ? 'totalPoints' : sortBy === 'events' ? 'totalEvents' : 'totalReviews'
      const av = a[field]
      const bv = b[field]
      const blanks = compareWithBlanksLast(av == null, bv == null)
      if (blanks !== null) return blanks
      return ((av as number) - (bv as number)) * dir
    }

    case 'name': {
      const av = (a.firstname ?? '').trim()
      const bv = (b.firstname ?? '').trim()
      const blanks = compareWithBlanksLast(av === '', bv === '')
      if (blanks !== null) return blanks
      return av.localeCompare(bv, undefined, { sensitivity: 'base' }) * dir
    }

    case 'email': {
      const av = (a.email ?? '').trim().toLowerCase()
      const bv = (b.email ?? '').trim().toLowerCase()
      const blanks = compareWithBlanksLast(av === '', bv === '')
      if (blanks !== null) return blanks
      return av.localeCompare(bv) * dir
    }

    case 'tierLevel': {
      // Rank order, not lexicographic — "Silver" must not sort above "Gold" alphabetically.
      const rank = (user: T): number | null => {
        const tier = tierOf(user).trim()
        if (!tier) return null
        return tierOrderMap[tier] ?? null
      }
      const ar = rank(a)
      const br = rank(b)
      const blanks = compareWithBlanksLast(ar == null, br == null)
      if (blanks !== null) return blanks
      return ((ar as number) - (br as number)) * dir
    }

    case 'dob': {
      const av = (a.dob ?? '').trim()
      const bv = (b.dob ?? '').trim()
      const blanks = compareWithBlanksLast(av === '', bv === '')
      if (blanks !== null) return blanks
      return av < bv ? -dir : av > bv ? dir : 0
    }

    case 'createdAt':
    default: {
      // ISO 8601 timestamps compare correctly as strings.
      const av = a.$createdAt ?? ''
      const bv = b.$createdAt ?? ''
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir
    }
  }
}

/**
 * Filters, sorts and paginates an already-loaded user set.
 *
 * Pure: no network, no mutation of `users`. Safe to call on every keystroke.
 */
export function buildUserListView<T extends UserListRow>(
  users: readonly T[],
  options: UserListViewOptions<T>
): UserListView<T> {
  const {
    searchQuery,
    tierFilter,
    sortBy,
    sortOrder,
    page,
    pageSize,
    tierOrderMap = {},
    resolveTier,
  } = options

  const tierOf = (user: T): string => resolveTier?.(user) ?? String(user.tierLevel ?? '')
  const trimmedSearch = searchQuery.trim()

  const filtered = users.filter((user) => {
    if (tierFilter !== ALL_TIERS && tierOf(user).trim() !== tierFilter) return false
    return matchesSearch(user, trimmedSearch)
  })

  const sorted = [...filtered].sort((a, b) =>
    compareUsers(a, b, sortBy, sortOrder, tierOrderMap, tierOf)
  )

  const total = sorted.length
  const totalPages = Math.ceil(total / pageSize)
  // A page past the end (e.g. sitting on page 9 then searching) shows the last page, never a blank.
  const safePage = totalPages === 0 ? 1 : Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize

  return {
    rows: sorted.slice(start, start + pageSize),
    total,
    totalPages,
    page: safePage,
  }
}
