import { useState, useEffect } from 'react'
import { Icon } from '@iconify/react'
import DateFilterModal from '../../Dashboard/components/DateFilterModal'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../../lib/dateUtils'
import type { SortOrder } from '../../../lib/userListView'
import {
  AUDIENCE_LABELS,
  POPUP_STATUSES,
  type PopupAgeFilter,
  type PopupAudienceFilter,
  type PopupSortBy,
  type PopupStatusFilter,
} from '../../../lib/popupUtils'

interface SearchAndFilterProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  statusFilter: PopupStatusFilter
  onStatusFilterChange: (value: PopupStatusFilter) => void
  audienceFilter: PopupAudienceFilter
  onAudienceFilterChange: (value: PopupAudienceFilter) => void
  ageFilter: PopupAgeFilter
  onAgeFilterChange: (value: PopupAgeFilter) => void
  dateRange: { start: Date | null; end: Date | null }
  onDateRangeChange: (range: { start: Date | null; end: Date | null }) => void
  sortBy: PopupSortBy
  onSortByChange: (value: PopupSortBy) => void
  sortOrder: SortOrder
  onSortOrderChange: (order: SortOrder) => void
}

const SORT_LABELS: Record<PopupSortBy, string> = {
  schedule: 'Schedule',
  title: 'Title',
  audience: 'Audience',
  status: 'Status',
  views: 'Views',
  clicks: 'Clicks',
  createdAt: 'Created Date',
}

// 'all' must not read as "everyone" — most pop-ups are 21+, so an admin picking the wrong
// option would blank most of the table.
const AGE_LABELS: Record<PopupAgeFilter, string> = {
  all: 'All Age Gates',
  '21plus': '21+ only',
  allAges: 'Not gated (all ages)',
}

const SearchAndFilter = ({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  audienceFilter,
  onAudienceFilterChange,
  ageFilter,
  onAgeFilterChange,
  dateRange,
  onDateRangeChange,
  sortBy,
  onSortByChange,
  sortOrder,
  onSortOrderChange,
}: SearchAndFilterProps) => {
  const { appTimezone } = useTimezoneStore()
  const [isDateFilterOpen, setIsDateFilterOpen] = useState(false)
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery)

  // Debounce search input so typing doesn't re-filter the table on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(localSearchQuery), 300) // 300ms debounce
    return () => clearTimeout(timer)
  }, [localSearchQuery, onSearchChange])

  // Keep the input in sync when the query is changed/cleared from outside.
  useEffect(() => {
    setLocalSearchQuery(searchQuery)
  }, [searchQuery])

  const hasDateRange = dateRange.start !== null

  const formatDateRange = () => {
    if (!dateRange.start) return 'Select Date'
    const start = formatDateInAppTimezone(dateRange.start.toISOString(), appTimezone, 'medium')
    if (!dateRange.end || dateRange.end.getTime() === dateRange.start.getTime()) return start
    const end = formatDateInAppTimezone(dateRange.end.toISOString(), appTimezone, 'medium')
    return `${start} - ${end}`
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Icon icon="mdi:filter" className="w-5 h-5 text-gray-600" />
        <h2 className="text-lg font-semibold text-gray-900">Search & Filter</h2>
      </div>
      <div className="flex flex-col md:flex-row md:flex-wrap gap-4">
        <div className="flex-1 min-w-[240px] relative">
          <Icon
            icon="mdi:magnify"
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
          />
          <input
            type="text"
            placeholder="Search by title"
            value={localSearchQuery}
            onChange={(e) => setLocalSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as PopupStatusFilter)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
        >
          <option value="all">All Status</option>
          {POPUP_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          value={audienceFilter}
          onChange={(e) => onAudienceFilterChange(e.target.value as PopupAudienceFilter)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
        >
          <option value="all">All Audiences</option>
          {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={ageFilter}
          onChange={(e) => onAgeFilterChange(e.target.value as PopupAgeFilter)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
        >
          {(Object.keys(AGE_LABELS) as PopupAgeFilter[]).map((value) => (
            <option key={value} value={value}>
              {AGE_LABELS[value]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsDateFilterOpen(true)}
            className={`px-4 py-2 border rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap ${
              hasDateRange
                ? 'border-[#1D0A74] bg-[#1D0A74]/5 text-[#1D0A74] font-medium'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
            title="Filter by schedule"
          >
            <Icon icon="mdi:calendar" className="w-5 h-5" />
            {formatDateRange()}
          </button>
          {hasDateRange && (
            <button
              type="button"
              onClick={() => onDateRangeChange({ start: null, end: null })}
              className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center"
              title="Clear date range"
            >
              <Icon icon="mdi:close" className="w-5 h-5 text-gray-600" />
            </button>
          )}
        </div>
        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value as PopupSortBy)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
        >
          {(Object.keys(SORT_LABELS) as PopupSortBy[]).map((value) => (
            <option key={value} value={value}>
              Sort by: {SORT_LABELS[value]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700 whitespace-nowrap"
          title={`Sort ${sortOrder === 'asc' ? 'Ascending' : 'Descending'}`}
        >
          <Icon
            icon={sortOrder === 'asc' ? 'mdi:arrow-up' : 'mdi:arrow-down'}
            className="w-5 h-5"
          />
          {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
        </button>
      </div>

      {/* DateFilterModal only syncs its internal selection from truthy props, so clearing the
          range from the toolbar would leave the old selection staged inside it. Remounting on
          every range change keeps the picker honest. */}
      <DateFilterModal
        key={dateRange.start?.getTime() ?? 'none'}
        isOpen={isDateFilterOpen}
        onClose={() => setIsDateFilterOpen(false)}
        onSelect={(startDate, endDate) => onDateRangeChange({ start: startDate, end: endDate })}
        initialStartDate={dateRange.start}
        initialEndDate={dateRange.end}
      />
    </div>
  )
}

export default SearchAndFilter
