import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { DashboardLayout, ConfirmationModal } from '../../components'
import { CreatePopupModal, EditPopupModal, SearchAndFilter } from './components'
import type { PopupFormPayload } from './components'
import {
  popupsService,
  statisticsService,
  type PopupDocument,
  type PopupsStats,
} from '../../lib/services'
import { deleteStorageFile } from '../../lib/storageUtils'
import { fetchAllPages } from '../../lib/paginateAll'
import { useNotificationStore } from '../../stores/notificationStore'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { formatDateInAppTimezone } from '../../lib/dateUtils'
import {
  audienceLabel,
  comparePopups,
  getPopupStatus,
  popupStatusStyles,
  type PopupAgeFilter,
  type PopupAudienceFilter,
  type PopupSortBy,
  type PopupStatusFilter,
} from '../../lib/popupUtils'
import type { SortOrder } from '../../lib/userListView'
import { Query } from '../../lib/appwrite'

const Popups = () => {
  const navigate = useNavigate()
  const { addNotification } = useNotificationStore()
  const { appTimezone } = useTimezoneStore()
  const [popups, setPopups] = useState<PopupDocument[]>([])
  const [stats, setStats] = useState<PopupsStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<PopupStatusFilter>('all')
  const [audienceFilter, setAudienceFilter] = useState<PopupAudienceFilter>('all')
  const [ageFilter, setAgeFilter] = useState<PopupAgeFilter>('all')
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  })
  const [sortBy, setSortBy] = useState<PopupSortBy>('schedule')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [popupToEdit, setPopupToEdit] = useState<PopupDocument | null>(null)
  const [popupToDuplicate, setPopupToDuplicate] = useState<PopupDocument | null>(null)
  const [popupToDelete, setPopupToDelete] = useState<PopupDocument | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const fetchPopups = useCallback(async () => {
    try {
      // Every filter and sort below runs client-side, so a capped fetch would hide matching
      // rows outside the window (see paginateAll.ts). Page through the whole collection.
      const allPopups = await fetchAllPages<PopupDocument>((cursor, limit) =>
        popupsService.list([
          Query.orderDesc('startDate'),
          Query.limit(limit),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ])
      )
      setPopups(allPopups)
    } catch (err) {
      console.error('Error fetching popups:', err)
      addNotification({
        type: 'error',
        title: 'Failed to load pop-ups',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsLoading(false)
    }
  }, [addNotification])

  const fetchStats = useCallback(async () => {
    try {
      setStats(await statisticsService.getStatistics<PopupsStats>('popups'))
    } catch (err) {
      console.error('Error fetching popup stats:', err)
    }
  }, [])

  useEffect(() => {
    void fetchPopups()
    void fetchStats()
  }, [fetchPopups, fetchStats])

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    statusFilter !== 'all' ||
    audienceFilter !== 'all' ||
    ageFilter !== 'all' ||
    dateRange.start !== null

  // Filtering and sorting are client-side because Status is derived from the schedule and cannot
  // be expressed as an Appwrite query. fetchPopups pages through the whole collection so nothing
  // is filtered out of a truncated window.
  const filteredPopups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()

    // One clock reading for the whole pass, so a status transition can't change the answer
    // partway through filtering or sorting.
    const now = new Date()

    // The picker returns local-midnight dates; widen a single-day pick to cover that whole day.
    let rangeStart: number | null = null
    let rangeEnd: number | null = null
    if (dateRange.start) {
      const start = new Date(dateRange.start)
      start.setHours(0, 0, 0, 0)
      const end = new Date(dateRange.end ?? dateRange.start)
      end.setHours(23, 59, 59, 999)
      rangeStart = start.getTime()
      rangeEnd = end.getTime()
    }

    const rows = popups.filter((popup) => {
      if (q && !(popup.title ?? '').toLowerCase().includes(q)) return false
      if (statusFilter !== 'all' && getPopupStatus(popup, now) !== statusFilter) return false
      if (audienceFilter !== 'all' && popup.targetAudience !== audienceFilter) return false
      // only21Plus defaults to true when unset, matching the 21+ column.
      if (ageFilter === '21plus' && popup.only21Plus === false) return false
      if (ageFilter === 'allAges' && popup.only21Plus !== false) return false
      // Keep pop-ups whose schedule overlaps the selected range at any point.
      if (rangeStart !== null && rangeEnd !== null) {
        if (Date.parse(popup.startDate) > rangeEnd || Date.parse(popup.endDate) < rangeStart) {
          return false
        }
      }
      return true
    })

    return rows.sort((a, b) => comparePopups(a, b, sortBy, sortOrder, now))
  }, [popups, searchQuery, statusFilter, audienceFilter, ageFilter, dateRange, sortBy, sortOrder])

  const handleCreate = async (data: PopupFormPayload) => {
    await popupsService.create(data as unknown as Record<string, unknown>)
    addNotification({ type: 'success', title: 'Pop-up created', message: data.title || 'Untitled' })
    await Promise.all([fetchPopups(), fetchStats()])
  }

  const handleUpdate = async (id: string, data: PopupFormPayload) => {
    await popupsService.update(id, data as unknown as Record<string, unknown>)
    addNotification({ type: 'success', title: 'Pop-up updated', message: data.title || 'Untitled' })
    await Promise.all([fetchPopups(), fetchStats()])
  }

  const handleDelete = async () => {
    if (!popupToDelete || isDeleting) return
    setIsDeleting(true)
    try {
      await popupsService.delete(popupToDelete.$id)
      await deleteStorageFile(popupToDelete.imageFileId)
      addNotification({ type: 'success', title: 'Pop-up deleted', message: popupToDelete.title || 'Untitled' })
      setPopupToDelete(null)
      await Promise.all([fetchPopups(), fetchStats()])
    } catch (err) {
      console.error('Error deleting popup:', err)
      addNotification({
        type: 'error',
        title: 'Failed to delete pop-up',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const statCards = [
    { label: 'Total Pop-ups', value: stats?.totalPopups },
    { label: 'Scheduled', value: stats?.scheduled },
    { label: 'Active', value: stats?.active },
    { label: 'Completed', value: stats?.completed },
  ]

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pop-ups</h1>
            <p className="text-sm text-gray-500">
              Banner images shown in the mobile app on scheduled days
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90"
          >
            <Icon icon="mdi:plus" className="h-5 w-5" />
            New Pop-up
          </button>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {statCards.map((card) => (
            <div key={card.label} className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-sm text-gray-500">{card.label}</p>
              <p className="text-2xl font-semibold text-gray-900">{card.value ?? '—'}</p>
            </div>
          ))}
        </div>

        <SearchAndFilter
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          audienceFilter={audienceFilter}
          onAudienceFilterChange={setAudienceFilter}
          ageFilter={ageFilter}
          onAgeFilterChange={setAgeFilter}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          sortBy={sortBy}
          onSortByChange={setSortBy}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
        />

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Image</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">21+</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Views</th>
                <th className="px-4 py-3 text-right">Clicks</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : filteredPopups.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    {hasActiveFilters
                      ? 'No pop-ups match your filters.'
                      : 'No pop-ups yet. Create the first one.'}
                  </td>
                </tr>
              ) : (
                filteredPopups.map((popup) => {
                  const status = getPopupStatus(popup)
                  return (
                    <tr
                      key={popup.$id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={(e) => {
                        const target = e.target as HTMLElement
                        if (target.closest('button')) {
                          return
                        }
                        setPopupToEdit(popup)
                      }}
                    >
                      <td className="px-4 py-3">
                        <img
                          src={popup.imageUrl}
                          alt={popup.title}
                          loading="lazy"
                          decoding="async"
                          className="h-12 w-12 rounded-lg border border-gray-200 object-cover"
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {popup.title?.trim() ? popup.title : <span className="italic text-gray-400">Untitled</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatDateInAppTimezone(popup.startDate, appTimezone)} –{' '}
                        {formatDateInAppTimezone(popup.endDate, appTimezone)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {audienceLabel(popup.targetAudience)}
                      </td>
                      <td className="px-4 py-3">
                        {popup.only21Plus !== false ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            21+
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${popupStatusStyles[status]}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{popup.views ?? 0}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{popup.clicks ?? 0}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            title="Details"
                            onClick={() => navigate(`/popups/${popup.$id}`)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <Icon icon="mdi:chart-bar" className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            title="Edit"
                            onClick={() => setPopupToEdit(popup)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <Icon icon="mdi:pencil-outline" className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            title="Duplicate"
                            onClick={() => setPopupToDuplicate(popup)}
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <Icon icon="mdi:content-copy" className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            title="Delete"
                            onClick={() => setPopupToDelete(popup)}
                            className="rounded p-1 text-red-500 hover:bg-red-50"
                          >
                            <Icon icon="mdi:trash-can-outline" className="h-5 w-5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreatePopupModal
        isOpen={isCreateModalOpen || popupToDuplicate !== null}
        onClose={() => {
          setIsCreateModalOpen(false)
          setPopupToDuplicate(null)
        }}
        onSave={handleCreate}
        duplicateOf={popupToDuplicate}
      />
      <EditPopupModal
        isOpen={popupToEdit !== null}
        popup={popupToEdit}
        onClose={() => setPopupToEdit(null)}
        onSave={handleUpdate}
        onDuplicate={() => {
          // Hand the open row to the create flow; edit closes without saving anything.
          setPopupToDuplicate(popupToEdit)
          setPopupToEdit(null)
        }}
      />
      <ConfirmationModal
        isOpen={popupToDelete !== null}
        onClose={() => setPopupToDelete(null)}
        onConfirm={handleDelete}
        type="delete"
        title="Delete Pop-up"
        message={`Are you sure you want to delete "${popupToDelete?.title || 'Untitled'}"? Its stats will be deleted too.`}
        isLoading={isDeleting}
      />
    </DashboardLayout>
  )
}

export default Popups
