/**
 * Shared helpers and option maps for pop-up management.
 *
 * Pop-up status is derived from the schedule rather than stored, so it cannot be
 * filtered or ordered with an Appwrite query — the Pop-ups page filters and sorts
 * client-side over a single fetched page of documents.
 */

import type { NotificationAudience, PopupDocument } from './services'
import { compareWithBlanksLast, type SortOrder } from './userListView'

export type PopupStatus = 'Scheduled' | 'Active' | 'Completed'

export const POPUP_STATUSES: PopupStatus[] = ['Scheduled', 'Active', 'Completed']

export function getPopupStatus(popup: PopupDocument, now: Date = new Date()): PopupStatus {
  if (now < new Date(popup.startDate)) return 'Scheduled'
  if (now > new Date(popup.endDate)) return 'Completed'
  return 'Active'
}

export const popupStatusStyles: Record<PopupStatus, string> = {
  Scheduled: 'bg-blue-100 text-blue-800',
  Active: 'bg-green-100 text-green-800',
  Completed: 'bg-gray-100 text-gray-700',
}

/** Sort rank for the Status column: upcoming first, finished last. */
const popupStatusRank: Record<PopupStatus, number> = {
  Scheduled: 0,
  Active: 1,
  Completed: 2,
}

export const AUDIENCE_LABELS: Record<NotificationAudience, string> = {
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

export const audienceLabel = (audience: NotificationAudience): string =>
  AUDIENCE_LABELS[audience] ?? audience

export type PopupStatusFilter = 'all' | PopupStatus
export type PopupAudienceFilter = 'all' | NotificationAudience
/** '21plus' = gated to 21+ verified users, 'allAges' = served to everyone. */
export type PopupAgeFilter = 'all' | '21plus' | 'allAges'
export type PopupSortBy =
  | 'schedule'
  | 'title'
  | 'audience'
  | 'status'
  | 'views'
  | 'clicks'
  | 'createdAt'

/**
 * Compares two pop-ups on the given field. Direction is applied per branch rather than by the
 * caller so blank titles can sort last in BOTH directions, matching compareWithBlanksLast.
 * Ties keep the incoming order (Array#sort is stable) — the startDate-descending fetch order.
 *
 * `now` is passed in so a whole sort shares one clock reading: deriving status from a fresh
 * `new Date()` per comparison could flip a pair's order mid-sort if the clock crosses a
 * startDate/endDate boundary, which makes the comparator inconsistent.
 */
export function comparePopups(
  a: PopupDocument,
  b: PopupDocument,
  sortBy: PopupSortBy,
  sortOrder: SortOrder,
  now: Date = new Date(),
): number {
  const dir = sortOrder === 'asc' ? 1 : -1

  switch (sortBy) {
    case 'title': {
      const av = (a.title ?? '').trim()
      const bv = (b.title ?? '').trim()
      // Untitled pop-ups sort last either way rather than filling the first screen.
      const blanks = compareWithBlanksLast(av === '', bv === '')
      if (blanks !== null) return blanks
      return av.localeCompare(bv, undefined, { sensitivity: 'base' }) * dir
    }
    case 'audience':
      return audienceLabel(a.targetAudience).localeCompare(audienceLabel(b.targetAudience)) * dir
    case 'status':
      return (popupStatusRank[getPopupStatus(a, now)] - popupStatusRank[getPopupStatus(b, now)]) * dir
    // views/clicks render as 0 when unset, so 0 is treated as a real value, not a blank.
    case 'views':
      return ((a.views ?? 0) - (b.views ?? 0)) * dir
    case 'clicks':
      return ((a.clicks ?? 0) - (b.clicks ?? 0)) * dir
    case 'createdAt':
      return (Date.parse(a.$createdAt) - Date.parse(b.$createdAt)) * dir
    case 'schedule':
    default:
      return (Date.parse(a.startDate) - Date.parse(b.startDate)) * dir
  }
}
