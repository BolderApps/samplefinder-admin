import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { Pagination, TableEmptyState, TableLoadingState } from '../../../components'
import DateFilterModal from '../../Dashboard/components/DateFilterModal'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import { formatDateTimeInAppTimezone, formatDateInAppTimezone } from '../../../lib/dateUtils'
import { exportService, type ReportColumn } from '../../../lib/exportService'
import type { PopupViewerRow } from '../../../lib/services'
import ViewerDetailsModal from './ViewerDetailsModal'
import type { SortOrder } from '../../../lib/userListView'
import {
  ENGAGEMENT_LABELS,
  VIEWER_AGE_LABELS,
  VIEWER_SORT_LABELS,
  filterAndSortViewers,
  hasActiveViewerFilters,
  initialViewerFilters,
  type ViewerAgeFilter,
  type ViewerEngagementFilter,
  type ViewerSortBy,
} from '../../../lib/popupViewers'

interface PopupViewersProps {
  /** The campaign these rows belong to; needed to re-show it to a single viewer. */
  popupId: string
  /** Why re-showing is unavailable (campaign not running), or null when it is allowed. */
  reshowBlockedReason?: string | null
  /** Rows from the Statistics function; null while the request is in flight. */
  viewers: PopupViewerRow[] | null
  isLoading: boolean
  /** True when the campaign has more unique viewers than the 1000-row response cap. */
  truncated: boolean
  /**
   * Set when the statistics request failed. Without it a failed request would render the
   * "no one has seen this pop-up" empty state, telling the admin the campaign had no
   * audience when in fact we simply do not know.
   */
  error?: string | null
  /** Used to name the export file. */
  popupTitle: string
}

const PAGE_SIZE = 25
const COL_SPAN = 5

const CSV_COLUMNS: ReportColumn[] = [
  { header: 'Name', key: 'name' },
  { header: 'Username', key: 'username' },
  { header: 'Age Gate', key: 'ageGate' },
  { header: 'Impressions', key: 'impressions' },
  { header: 'Days Shown', key: 'daysShown' },
  { header: 'First Shown', key: 'firstShown' },
  { header: 'Last Shown', key: 'lastShown' },
  { header: 'Clicked', key: 'clicked' },
  { header: 'User ID', key: 'userId' },
]

/** Filenames must survive a download dialog on every OS. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'popup'

/**
 * "Who saw this pop-up" — the per-user interaction list on the pop-up detail page.
 *
 * One row is one USER (SAM-12): someone shown the pop-up three times appears once, with an
 * Impressions count, rather than as three separate people. The Statistics function does that
 * rollup, which is what lets its 1000-row cap bound viewers instead of raw sightings.
 *
 * Search, filtering, sorting and paging all run client-side over the rows it returns (most
 * recently seen first). That is deliberate: the cap is applied server-side, so narrowing
 * there would hide matching rows inside it. The toolbar mirrors the pop-up list's Search &
 * Filter card, and the table, pagination and empty states use the dashboard's shared
 * components.
 */
const PopupViewers = ({
  popupId,
  reshowBlockedReason,
  viewers,
  isLoading,
  truncated,
  error,
  popupTitle,
}: PopupViewersProps) => {
  const { appTimezone } = useTimezoneStore()
  const [search, setSearch] = useState('')
  const [localSearch, setLocalSearch] = useState('')
  const [engagement, setEngagement] = useState<ViewerEngagementFilter>('all')
  const [age, setAge] = useState<ViewerAgeFilter>('all')
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  })
  const [sortBy, setSortBy] = useState<ViewerSortBy>(initialViewerFilters.sortBy)
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialViewerFilters.sortOrder)
  const [isDateFilterOpen, setIsDateFilterOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedViewer, setSelectedViewer] = useState<PopupViewerRow | null>(null)

  // Debounced so typing doesn't re-filter on every keystroke, matching the pop-up list.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(localSearch), 300)
    return () => clearTimeout(timer)
  }, [localSearch])

  const filters = useMemo(
    () => ({ search, engagement, age, dateRange, sortBy, sortOrder }),
    [search, engagement, age, dateRange, sortBy, sortOrder]
  )
  const isFiltered = hasActiveViewerFilters(filters)

  const rows = useMemo(() => filterAndSortViewers(viewers ?? [], filters), [viewers, filters])

  // Any change to what's being listed sends the reader back to the first page; otherwise a
  // narrower result set leaves them stranded on a page that no longer exists.
  useEffect(() => {
    setCurrentPage(1)
  }, [search, engagement, age, dateRange, sortBy, sortOrder])

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const totalCount = viewers?.length ?? 0

  const clearFilters = () => {
    setLocalSearch('')
    setSearch('')
    setEngagement('all')
    setAge('all')
    setDateRange({ start: null, end: null })
  }

  const formatStamp = (iso: string | null): string =>
    iso ? formatDateTimeInAppTimezone(iso, appTimezone) : ''

  const handleExport = () => {
    const csvRows = rows.map((viewer) => ({
      name: viewer.name,
      username: viewer.username ? `@${viewer.username}` : '',
      ageGate: viewer.is21Plus ? '21+' : 'Under 21',
      impressions: viewer.impressions,
      daysShown: viewer.dayKeys.length,
      firstShown: formatStamp(viewer.firstShownAt),
      lastShown: formatStamp(viewer.lastShownAt),
      clicked: formatStamp(viewer.clickedAt),
      userId: viewer.userId,
    }))
    const csv = exportService.exportToCSV(CSV_COLUMNS, csvRows)
    exportService.downloadCSV(`${slugify(popupTitle)}-viewers.csv`, csv)
  }

  const hasDateRange = dateRange.start !== null
  const formatDateRange = () => {
    if (!dateRange.start) return 'Shown Date'
    const start = formatDateInAppTimezone(dateRange.start.toISOString(), appTimezone, 'medium')
    if (!dateRange.end || dateRange.end.getTime() === dateRange.start.getTime()) return start
    const end = formatDateInAppTimezone(dateRange.end.toISOString(), appTimezone, 'medium')
    return `${start} - ${end}`
  }

  return (
    <div className="mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Who saw this pop-up</h2>
          <p className="text-sm text-gray-500">
            {isLoading
              ? 'Loading interactions…'
              : error
                ? 'Interactions unavailable'
                : isFiltered
                  ? `${rows.length.toLocaleString()} of ${totalCount.toLocaleString()} viewers match`
                  : `${totalCount.toLocaleString()} ${totalCount === 1 ? 'viewer' : 'viewers'}`}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={rows.length === 0}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          title={isFiltered ? 'Export the filtered list' : 'Export all viewers'}
        >
          <Icon icon="mdi:download" className="h-5 w-5" />
          Export CSV
        </button>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center gap-2">
          <Icon icon="mdi:filter" className="h-5 w-5 text-gray-600" />
          <h3 className="text-base font-semibold text-gray-900">Search &amp; Filter</h3>
          {isFiltered && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto flex items-center gap-1 text-sm font-medium text-[#1D0A74] hover:underline"
            >
              <Icon icon="mdi:filter-remove-outline" className="h-4 w-4" />
              Clear filters
            </button>
          )}
        </div>
        <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
          <div className="relative min-w-[240px] flex-1">
            <Icon
              icon="mdi:magnify"
              className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 transform text-gray-400"
            />
            <input
              type="text"
              placeholder="Search by name or username"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
            />
          </div>
          <select
            value={engagement}
            onChange={(e) => setEngagement(e.target.value as ViewerEngagementFilter)}
            className="rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
          >
            {(Object.keys(ENGAGEMENT_LABELS) as ViewerEngagementFilter[]).map((value) => (
              <option key={value} value={value}>
                {ENGAGEMENT_LABELS[value]}
              </option>
            ))}
          </select>
          <select
            value={age}
            onChange={(e) => setAge(e.target.value as ViewerAgeFilter)}
            className="rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
          >
            {(Object.keys(VIEWER_AGE_LABELS) as ViewerAgeFilter[]).map((value) => (
              <option key={value} value={value}>
                {VIEWER_AGE_LABELS[value]}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsDateFilterOpen(true)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2 transition-colors ${
                hasDateRange
                  ? 'border-[#1D0A74] bg-[#1D0A74]/5 font-medium text-[#1D0A74]'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title="Filter by the date the pop-up was shown"
            >
              <Icon icon="mdi:calendar" className="h-5 w-5" />
              {formatDateRange()}
            </button>
            {hasDateRange && (
              <button
                type="button"
                onClick={() => setDateRange({ start: null, end: null })}
                className="flex items-center rounded-lg border border-gray-300 px-3 py-2 transition-colors hover:bg-gray-50"
                title="Clear date range"
              >
                <Icon icon="mdi:close" className="h-5 w-5 text-gray-600" />
              </button>
            )}
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as ViewerSortBy)}
            className="rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
          >
            {(Object.keys(VIEWER_SORT_LABELS) as ViewerSortBy[]).map((value) => (
              <option key={value} value={value}>
                Sort by: {VIEWER_SORT_LABELS[value]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
            title={`Sort ${sortOrder === 'asc' ? 'Ascending' : 'Descending'}`}
          >
            <Icon
              icon={sortOrder === 'asc' ? 'mdi:arrow-up' : 'mdi:arrow-down'}
              className="h-5 w-5"
            />
            {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Age Gate
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                  title="How many times this person was shown the pop-up, same-day repeats included"
                >
                  Impressions
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Last Seen
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Clicked
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {isLoading ? (
                <TableLoadingState colSpan={COL_SPAN} label="Loading interactions..." />
              ) : error ? (
                <TableEmptyState
                  colSpan={COL_SPAN}
                  icon="mdi:alert-circle-outline"
                  title="Could not load interactions"
                  description={error}
                />
              ) : pageRows.length === 0 ? (
                isFiltered ? (
                  <TableEmptyState
                    colSpan={COL_SPAN}
                    icon="mdi:magnify"
                    title="No results found"
                    description="Try adjusting your search or filters."
                  />
                ) : (
                  <TableEmptyState
                    colSpan={COL_SPAN}
                    icon="mdi:eye-off-outline"
                    title="No one has seen this pop-up yet"
                    description="Viewers appear here once the banner has actually been displayed in the app."
                  />
                )
              ) : (
                pageRows.map((viewer) => (
                  <tr
                    key={viewer.userId}
                    onClick={() => setSelectedViewer(viewer)}
                    // Rows are reachable and activatable from the keyboard as well as the
                    // mouse, since the click target is the row itself rather than a control.
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${viewer.name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedViewer(viewer)
                      }
                    }}
                    className="cursor-pointer transition-colors hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#1D0A74]"
                  >
                    <td className="px-6 py-4 text-sm">
                      <div className="font-medium text-gray-900">{viewer.name}</div>
                      {viewer.username && (
                        <div className="text-gray-500">@{viewer.username}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          viewer.is21Plus
                            ? 'bg-gray-100 text-gray-700'
                            : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {viewer.is21Plus ? '21+' : 'Under 21'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <span
                        className={`inline-flex min-w-[2.25rem] justify-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          viewer.impressions > 1
                            ? 'bg-[#1D0A74]/10 text-[#1D0A74]'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                        title={
                          viewer.impressions > 1
                            ? `Shown ${viewer.impressions.toLocaleString()} times across ${
                                viewer.dayKeys.length
                              } ${viewer.dayKeys.length === 1 ? 'day' : 'days'}`
                            : 'Shown once'
                        }
                      >
                        {viewer.impressions.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {viewer.lastShownAt ? (
                        <>
                          <div className="whitespace-nowrap">{formatStamp(viewer.lastShownAt)}</div>
                          {/* Only meaningful for a repeat viewer; for everyone else it would
                              just restate the line above. */}
                          {viewer.impressions > 1 && viewer.firstShownAt && (
                            <div className="whitespace-nowrap text-xs text-gray-500">
                              first seen {formatStamp(viewer.firstShownAt)}
                            </div>
                          )}
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      {viewer.clickedAt ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                            <Icon icon="mdi:cursor-default-click" className="h-3.5 w-3.5" />
                            Clicked
                          </span>
                          <span className="text-gray-600">{formatStamp(viewer.clickedAt)}</span>
                        </div>
                      ) : (
                        <span className="text-gray-400">Not clicked</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!isLoading && !error && (
          <Pagination
            currentPage={safePage}
            totalPages={totalPages}
            totalItems={rows.length}
            pageSize={PAGE_SIZE}
            itemLabel="viewers"
            onPageChange={setCurrentPage}
          />
        )}
      </div>

      {truncated && (
        <p className="mt-3 text-xs text-gray-500">
          This campaign has more viewers than can be listed here — showing the 1000 most recently
          seen. Search and filters apply to those rows only.
        </p>
      )}

      <ViewerDetailsModal
        popupId={popupId}
        reshowBlockedReason={reshowBlockedReason}
        viewer={selectedViewer}
        onClose={() => setSelectedViewer(null)}
      />

      {/* DateFilterModal only syncs its selection from truthy props, so clearing the range from
          the toolbar would leave the old selection staged inside it. Remounting keeps it honest. */}
      <DateFilterModal
        key={dateRange.start?.getTime() ?? 'none'}
        isOpen={isDateFilterOpen}
        onClose={() => setIsDateFilterOpen(false)}
        onSelect={(startDate, endDate) => setDateRange({ start: startDate, end: endDate })}
        initialStartDate={dateRange.start}
        initialEndDate={dateRange.end}
      />
    </div>
  )
}

export default PopupViewers
