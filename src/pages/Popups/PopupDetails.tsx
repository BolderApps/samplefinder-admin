import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { ConfirmationModal, DashboardLayout } from '../../components'
import {
  popupsService,
  statisticsService,
  eventsService,
  type PopupDocument,
  type PopupDetailStatistics,
} from '../../lib/services'
import { useTimezoneStore } from '../../stores/timezoneStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { formatDateInAppTimezone, formatDateTimeInAppTimezone } from '../../lib/dateUtils'
import { audienceLabel, getPopupStatus } from '../../lib/popupUtils'
import { rollUpLegacyViewers, type LegacyViewerRow } from '../../lib/popupViewers'
import { PopupViewers } from './components'

const PopupDetails = () => {
  const { popupId } = useParams<{ popupId: string }>()
  const navigate = useNavigate()
  const { appTimezone } = useTimezoneStore()
  const [popup, setPopup] = useState<PopupDocument | null>(null)
  const [stats, setStats] = useState<PopupDetailStatistics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [destinationEventName, setDestinationEventName] = useState<string | null>(null)
  // Tracked separately from `stats`: a null `stats` means "loading" and "failed" alike, and the
  // viewer list must not report an empty audience for either.
  const [isLoadingStats, setIsLoadingStats] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  /**
   * Tolerate a Statistics function that has not been redeployed yet. Before SAM-12 it sent one
   * row per sighting and no `impressions`, so rolling those up here keeps the table correct
   * during the deploy window instead of rendering a column of blanks.
   */
  const viewerRows = useMemo(() => {
    const rows = stats?.viewers ?? null
    if (!rows) return null
    return rows.every((row) => typeof row.impressions === 'number')
      ? rows
      : rollUpLegacyViewers(rows as unknown as LegacyViewerRow[])
  }, [stats])

  const [isReshowConfirmOpen, setIsReshowConfirmOpen] = useState(false)
  const [isReshowing, setIsReshowing] = useState(false)
  const { addNotification } = useNotificationStore()

  useEffect(() => {
    if (!popupId) return
    const load = async () => {
      const [docRes, statsRes] = await Promise.allSettled([
        popupsService.getById(popupId),
        statisticsService.getStatistics<PopupDetailStatistics>('popups', { popupId }),
      ])
      if (docRes.status === 'fulfilled') {
        setPopup(docRes.value)
      } else {
        console.error('Error loading popup details:', docRes.reason)
        setError('Failed to load pop-up details.')
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value)
      } else {
        console.error('Error loading popup stats:', statsRes.reason)
        // leave stats null → tiles render "—"
        setStatsError('The statistics service did not respond. Refresh to try again.')
      }
      setIsLoadingStats(false)

      if (docRes.status === 'fulfilled' && docRes.value.destinationEventId) {
        try {
          const event = await eventsService.getById(docRes.value.destinationEventId)
          setDestinationEventName(event.name)
        } catch (err) {
          // The event may have been deleted; fall back to showing the raw id.
          console.error('Error loading pop-up destination event:', err)
        }
      }
    }
    void load()
  }, [popupId])

  /**
   * Re-open the campaign to everyone who has already seen it today. One server write, so
   * the audience size does not matter; the pop-up is re-read afterwards so the banner below
   * reports the marker that was actually stored.
   */
  const handleReshow = async () => {
    if (!popupId || isReshowing) return
    setIsReshowing(true)
    try {
      await popupsService.resetInteractions(popupId)
      setPopup(await popupsService.getById(popupId))
      addNotification({
        type: 'success',
        title: 'Pop-up re-opened',
        message: "Today's viewers will see it again the next time they open the app.",
      })
      setIsReshowConfirmOpen(false)
    } catch (err) {
      console.error('Error re-showing popup:', err)
      addNotification({
        type: 'error',
        title: 'Failed to re-show pop-up',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsReshowing(false)
    }
  }

  // Re-showing only means something while the campaign is running: outside its own schedule
  // window the fetch skips it anyway, so the action would report success and change nothing.
  const status = popup ? getPopupStatus(popup) : null
  const reshowBlockedReason =
    status === 'Scheduled'
      ? 'This pop-up has not started yet, so no one has seen it'
      : status === 'Completed'
        ? 'This pop-up has finished, so it can no longer be shown'
        : null

  const statTiles = [
    { label: 'Impressions', value: stats?.totalImpressions },
    { label: 'Unique Users Shown', value: stats?.uniqueUsersShown },
    { label: 'Unique Clickers', value: stats?.uniqueClickers },
    { label: '21+ Clickers', value: stats?.clickers21Plus },
    {
      label: 'CTR',
      value: stats ? `${(stats.ctr * 100).toFixed(1)}%` : undefined,
    },
  ]

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate('/popups')}
            className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
          >
            <Icon icon="mdi:arrow-left" className="h-4 w-4" />
            Back to Pop-ups
          </button>
          {popup && (
            <button
              type="button"
              onClick={() => setIsReshowConfirmOpen(true)}
              disabled={isReshowing || reshowBlockedReason !== null}
              title={
                reshowBlockedReason ??
                'Let everyone who has already seen this pop-up today see it once more'
              }
              className="flex items-center gap-2 rounded-lg border border-[#1D0A74] px-4 py-2 text-sm font-medium text-[#1D0A74] transition-colors hover:bg-[#1D0A74]/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon icon="mdi:refresh" className="h-5 w-5" />
              Show again
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {popup && (
          <>
            <div className="mb-6 flex flex-col gap-6 md:flex-row">
              <img
                src={popup.imageUrl}
                alt={popup.title?.trim() || 'Untitled'}
                className="max-h-72 w-full max-w-sm rounded-xl border border-gray-200 object-contain"
              />
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{popup.title?.trim() || 'Untitled'}</h1>
                <dl className="mt-3 space-y-2 text-sm text-gray-600">
                  <div>
                    <dt className="inline font-medium text-gray-800">Schedule: </dt>
                    <dd className="inline">
                      {formatDateInAppTimezone(popup.startDate, appTimezone)} –{' '}
                      {formatDateInAppTimezone(popup.endDate, appTimezone)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-gray-800">Audience: </dt>
                    <dd className="inline">{audienceLabel(popup.targetAudience)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-gray-800">21+ only: </dt>
                    <dd className="inline">{popup.only21Plus !== false ? 'Yes' : 'No'}</dd>
                  </div>
                  {popup.interactionsResetAt && (
                    <div>
                      <dt className="inline font-medium text-gray-800">Last shown again: </dt>
                      <dd className="inline">
                        {formatDateTimeInAppTimezone(popup.interactionsResetAt, appTimezone)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline font-medium text-gray-800">Destination: </dt>
                    <dd className="inline">
                      {popup.destinationType === 'event' && popup.destinationEventId ? (
                        <>
                          Event —{' '}
                          <span className="text-gray-900">
                            {destinationEventName ?? popup.destinationEventId}
                          </span>{' '}
                          <span className="text-gray-500">(opens in the app)</span>
                        </>
                      ) : popup.link ? (
                        <a
                          href={popup.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#1D0A74] underline"
                        >
                          {popup.link}
                        </a>
                      ) : (
                        'None (not clickable)'
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              {statTiles.map((tile) => (
                <div key={tile.label} className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-sm text-gray-500">{tile.label}</p>
                  <p className="text-2xl font-semibold text-gray-900">{tile.value ?? '—'}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Unique counts dedupe by user across the whole campaign. CTR = unique clickers ÷
              unique users shown. “Impressions” counts every sighting, so it runs ahead of
              “Unique Users Shown” whenever people saw the pop-up more than once — the table
              below lists each viewer once, with their own count. A pop-up is only counted once
              it has actually appeared on screen.
            </p>

            <PopupViewers
              popupId={popup.$id}
              reshowBlockedReason={reshowBlockedReason}
              viewers={viewerRows}
              isLoading={isLoadingStats}
              truncated={stats?.viewersTruncated ?? false}
              error={statsError}
              popupTitle={popup.title?.trim() || 'popup'}
            />
          </>
        )}
      </div>

      <ConfirmationModal
        isOpen={isReshowConfirmOpen}
        onClose={() => setIsReshowConfirmOpen(false)}
        onConfirm={handleReshow}
        type="reshow"
        itemName="pop-up"
        message="Everyone who has already seen it today will see it once more the next time they open the app. Today's impressions stay in the report."
        isLoading={isReshowing}
      />
    </DashboardLayout>
  )
}

export default PopupDetails
