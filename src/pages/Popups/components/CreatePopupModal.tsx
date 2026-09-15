import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { appUsersService, locationsService, eventsService } from '../../../lib/services'
import type {
  AppUser,
  EventDocument,
  NotificationAudience,
  PopupDocument,
} from '../../../lib/services'
import {
  uploadImageToStorage,
  deleteStorageFile,
  downloadStorageImageAsFile,
} from '../../../lib/storageUtils'
import {
  appTimeToUTC,
  formatDateInAppTimezone,
  getDateStringInTimezone,
} from '../../../lib/dateUtils'
import { getEventStatus, getEventStatusColor } from '../../../lib/eventUtils'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import PreviewPopupModal from './PreviewPopupModal'

export interface PopupFormPayload {
  title: string
  description: string | null
  imageUrl: string
  imageFileId: string
  link: string | null
  destinationType: 'external' | 'event'
  destinationEventId: string | null
  startDate: string // ISO 8601 UTC (00:00 app TZ)
  endDate: string // ISO 8601 UTC (23:59 app TZ)
  only21Plus: boolean
  targetAudience: NotificationAudience
  selectedUserIds: string[]
  selectedZipCodes: string[]
  newUsersTimeRange: number | null
}

interface CreatePopupModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: PopupFormPayload) => Promise<void>
  /** Pop-up to copy. Prefills every field and the banner; saving still creates a new row. */
  duplicateOf?: PopupDocument | null
}

export interface PopupFormState {
  title: string
  description: string
  link: string
  destinationType: 'external' | 'event'
  destinationEventId: string
  startDate: string // YYYY-MM-DD in app TZ (date input value)
  endDate: string // YYYY-MM-DD in app TZ
  only21Plus: boolean
  targetAudience: NotificationAudience
  selectedUserIds: string[]
  selectedZipCodes: string[]
  newUsersTimeRange: number | undefined
}

// eslint-disable-next-line react-refresh/only-export-components -- shared form-state constant, reused by EditPopupModal
export const initialPopupFormState: PopupFormState = {
  title: '',
  description: '',
  link: '',
  destinationType: 'external',
  destinationEventId: '',
  startDate: '',
  endDate: '',
  only21Plus: true,
  targetAudience: 'All',
  selectedUserIds: [],
  selectedZipCodes: [],
  newUsersTimeRange: undefined,
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper, reused by EditPopupModal
export const getPopupUserDisplayName = (user: AppUser): string => {
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ')
  return name || user.username || user.email || user.$id
}

/**
 * Accept what people actually type. "polarisbrandpromotions.com" becomes
 * "https://polarisbrandpromotions.com"; anything already carrying a scheme is
 * left alone, so http:// and deep links are never rewritten.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper, reused by EditPopupModal
export const normalizePopupLink = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * A stored pop-up as form state. Shared by Edit (opening a row) and Create (duplicating
 * one) so the two can never drift on how a document maps onto the form.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shared mapper, reused by EditPopupModal
export const popupToFormState = (popup: PopupDocument, appTimezone: string): PopupFormState => ({
  title: popup.title ?? '',
  description: (popup.description as string | null | undefined) ?? '',
  link: popup.link ?? '',
  destinationType: popup.destinationType === 'event' ? 'event' : 'external',
  destinationEventId: popup.destinationEventId ?? '',
  startDate: getDateStringInTimezone(new Date(popup.startDate), appTimezone),
  endDate: getDateStringInTimezone(new Date(popup.endDate), appTimezone),
  only21Plus: popup.only21Plus !== false,
  targetAudience: popup.targetAudience,
  selectedUserIds: popup.selectedUserIds ?? [],
  selectedZipCodes: popup.selectedZipCodes ?? [],
  newUsersTimeRange: popup.newUsersTimeRange ?? undefined,
})

/** Validate form fields shared by create/edit. Returns an error message or null. */
// eslint-disable-next-line react-refresh/only-export-components -- shared validator, reused by EditPopupModal
export const validatePopupForm = (
  form: PopupFormState,
  hasImage: boolean
): string | null => {
  if (!hasImage) return 'Please select a banner image.'
  if (form.destinationType === 'event') {
    if (!form.destinationEventId) return 'Please select an event to link to.'
  } else if (form.link.trim()) {
    try {
      const url = new URL(normalizePopupLink(form.link))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'Link must start with http:// or https://'
      }
    } catch {
      return 'Link must be a valid URL (e.g. https://example.com)'
    }
  }
  if (!form.startDate) return 'Please select a start date.'
  if (!form.endDate) return 'Please select an end date.'
  if (form.endDate < form.startDate) return 'End date must be on or after the start date.'
  if (form.targetAudience === 'Targeted' && form.selectedUserIds.length === 0) {
    return 'Please select at least one user.'
  }
  if (form.targetAudience === 'ZipCode' && form.selectedZipCodes.length === 0) {
    return 'Please select at least one zip code.'
  }
  return null
}

/** Rows the event picker renders at once; the rest stay behind the search box. */
const EVENT_RESULT_LIMIT = 50

/** Shared form body used by both Create and Edit modals. */
export const PopupFormFields = ({
  form,
  setForm,
  imagePreviewUrl,
  onImageSelected,
  onDestinationIssue,
}: {
  form: PopupFormState
  setForm: React.Dispatch<React.SetStateAction<PopupFormState>>
  imagePreviewUrl: string | null
  onImageSelected: (file: File) => void
  /**
   * Reports a destination the app cannot open, so the parent modal can refuse to save.
   * Only this component loads the events, so only it can tell. Null means "nothing wrong".
   */
  onDestinationIssue?: (reason: string | null) => void
}) => {
  const [users, setUsers] = useState<AppUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showUserDropdown, setShowUserDropdown] = useState(false)
  const [availableZipCodes, setAvailableZipCodes] = useState<string[]>([])
  const [isLoadingZipCodes, setIsLoadingZipCodes] = useState(false)
  const [events, setEvents] = useState<EventDocument[]>([])
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [eventSearchQuery, setEventSearchQuery] = useState('')
  const [showEventDropdown, setShowEventDropdown] = useState(false)
  const eventDropdownRef = useRef<HTMLDivElement>(null)
  const { appTimezone } = useTimezoneStore()

  useEffect(() => {
    const fetchUsers = async () => {
      setLoadingUsers(true)
      try {
        setUsers(await appUsersService.listAll())
      } catch (error) {
        console.error('Error fetching users:', error)
      } finally {
        setLoadingUsers(false)
      }
    }
    if (form.targetAudience === 'Targeted' && users.length === 0) {
      void fetchUsers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.targetAudience])

  useEffect(() => {
    const fetchZipCodes = async () => {
      setIsLoadingZipCodes(true)
      try {
        const locations = await locationsService.list()
        const zips = Array.from(
          new Set(
            (locations.documents || [])
              .map((loc) => (loc as { zipCode?: string }).zipCode)
              .filter((z): z is string => !!z)
          )
        ).sort()
        setAvailableZipCodes(zips)
      } catch (error) {
        console.error('Error fetching zip codes:', error)
      } finally {
        setIsLoadingZipCodes(false)
      }
    }
    if (form.targetAudience === 'ZipCode' && availableZipCodes.length === 0) {
      void fetchZipCodes()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.targetAudience])

  useEffect(() => {
    const fetchEvents = async () => {
      setLoadingEvents(true)
      try {
        setEvents(await eventsService.listAll())
      } catch (error) {
        console.error('Error fetching events:', error)
      } finally {
        setLoadingEvents(false)
      }
    }
    if (form.destinationType === 'event' && events.length === 0) {
      void fetchEvents()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.destinationType])

  // The event picker's search lives inside the dropdown, so closing it has to clear the
  // query too — otherwise reopening shows a filtered list with no visible reason why.
  useEffect(() => {
    if (!showEventDropdown) return
    const close = () => {
      setShowEventDropdown(false)
      setEventSearchQuery('')
    }
    const onMouseDown = (e: MouseEvent) => {
      if (eventDropdownRef.current && !eventDropdownRef.current.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [showEventDropdown])

  /**
   * Only events the app will actually open are offerable.
   *
   * `fetchEventById` on the mobile side returns null for anything archived or hidden, and
   * the banner's CTA then lands on a "not found" screen — so an archived event is not a
   * destination, it is a dead end. `getEventStatus` already draws exactly this line:
   * 'Active' means not archived, not hidden, and not past its end time. Anything else is
   * excluded rather than merely flagged, because there is no case where picking one is right.
   */
  const selectableEvents = useMemo(
    () => events.filter((e) => getEventStatus(e) === 'Active'),
    [events]
  )

  const eventMatches = useMemo(() => {
    const q = eventSearchQuery.trim().toLowerCase()
    if (!q) return selectableEvents
    return selectableEvents.filter((e) =>
      [e.name, e.city, e.state].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    )
  }, [selectableEvents, eventSearchQuery])

  const filteredEvents = eventMatches.slice(0, EVENT_RESULT_LIMIT)
  const hiddenEventCount = eventMatches.length - filteredEvents.length

  // Resolved against every event, not just the selectable ones: a pop-up saved before its
  // event was archived still has to render its own destination, otherwise editing anything
  // else about that pop-up would silently look like no event was ever chosen.
  const selectedEvent = useMemo(
    () => events.find((e) => e.$id === form.destinationEventId) ?? null,
    [events, form.destinationEventId]
  )
  const selectedEventStatus = selectedEvent ? getEventStatus(selectedEvent) : null

  /**
   * A saved destination can rot after the fact — the event gets archived, hidden, ends, or is
   * deleted outright. Report it so the modal blocks the save; the admin has to re-point the
   * banner rather than store one the app is guaranteed to reject.
   */
  const destinationIssue = useMemo((): string | null => {
    if (form.destinationType !== 'event' || !form.destinationEventId) return null
    // Say nothing while the list is still loading: absence is not yet evidence.
    if (loadingEvents || events.length === 0) return null
    if (!selectedEvent) {
      return 'The event this pop-up links to no longer exists. Please pick another event.'
    }
    if (selectedEventStatus !== 'Active') {
      const why =
        selectedEventStatus === 'Archived'
          ? 'has been archived'
          : selectedEventStatus === 'Hidden'
            ? 'is hidden from the app'
            : 'has already ended'
      return `"${selectedEvent.name}" ${why}, so tapping the banner would open an error screen. Please pick another event.`
    }
    return null
  }, [
    form.destinationType,
    form.destinationEventId,
    loadingEvents,
    events.length,
    selectedEvent,
    selectedEventStatus,
  ])

  useEffect(() => {
    onDestinationIssue?.(destinationIssue)
  }, [destinationIssue, onDestinationIssue])

  /** Secondary line in the picker: keeps two same-named events apart. */
  const eventSubtitle = (e: EventDocument): string =>
    [[e.city, e.state].filter(Boolean).join(', '), formatDateInAppTimezone(e.date, appTimezone)]
      .filter(Boolean)
      .join(' · ')

  const filteredUsers = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase()
    if (!q) return users.slice(0, 50)
    return users
      .filter((u) =>
        [u.firstname, u.lastname, u.username, u.email]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
      .slice(0, 50)
  }, [users, userSearchQuery])

  const inputClass =
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent'

  return (
    <div className="space-y-4">
      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Title (shown on the pop-up)</label>
        <input
          type="text"
          maxLength={200}
          value={form.title}
          onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          className={inputClass}
          placeholder="e.g. Summer IPA Launch (optional)"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Description (shown on the pop-up)</label>
        <textarea
          maxLength={1000}
          rows={3}
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          className={`${inputClass} resize-y`}
          placeholder="Optional supporting text under the title"
        />
      </div>

      {/* Image */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Banner Image *</label>
        {imagePreviewUrl && (
          <img
            src={imagePreviewUrl}
            alt="Banner preview"
            className="mb-2 max-h-48 rounded-lg border border-gray-200 object-contain"
          />
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImageSelected(file)
          }}
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-[#1D0A74] file:px-4 file:py-2 file:text-white"
        />
      </div>

      {/* Destination */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Destination (where tapping the banner goes)
        </label>
        <div className="flex gap-6 mb-3">
          {(
            [
              ['external', 'External website'],
              ['event', 'Event in the app'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="popup-destination-type"
                value={value}
                checked={form.destinationType === value}
                onChange={() => setForm((prev) => ({ ...prev, destinationType: value }))}
                className="accent-[#1D0A74]"
              />
              {label}
            </label>
          ))}
        </div>

        {form.destinationType === 'external' ? (
          <>
            <input
              type="text"
              value={form.link}
              onChange={(e) => setForm((prev) => ({ ...prev, link: e.target.value }))}
              onBlur={() => setForm((prev) => ({ ...prev, link: normalizePopupLink(prev.link) }))}
              className={inputClass}
              placeholder="example.com/promo"
            />
            <p className="text-xs text-gray-500 mt-1">
              Optional. Opens in the browser. Typing just the domain is fine — https:// is added
              for you.
            </p>
          </>
        ) : (
          <>
            {/*
              A pop-up links to exactly ONE event, so this is a single-select: the closed
              field reads as the chosen event and the search box lives inside the dropdown.
              A bare search input with the pick shown as a removable chip read as a
              multi-select and invited admins to try adding a second event.
            */}
            <div className="relative" ref={eventDropdownRef}>
              <button
                type="button"
                onClick={() => {
                  setEventSearchQuery('')
                  setShowEventDropdown((open) => !open)
                }}
                aria-haspopup="listbox"
                aria-expanded={showEventDropdown}
                className={`${inputClass} flex items-center justify-between gap-2 text-left`}
              >
                {selectedEvent ? (
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm text-gray-900">{selectedEvent.name}</span>
                      {selectedEventStatus && selectedEventStatus !== 'Active' && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${getEventStatusColor(
                            selectedEventStatus
                          )}`}
                        >
                          {selectedEventStatus}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {eventSubtitle(selectedEvent)}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-sm text-gray-500">
                    {!form.destinationEventId
                      ? 'Select an event…'
                      : loadingEvents
                        ? 'Loading selected event…'
                        : 'This event no longer exists — pick another'}
                  </span>
                )}
                <Icon
                  icon={showEventDropdown ? 'mdi:chevron-up' : 'mdi:chevron-down'}
                  className="h-5 w-5 shrink-0 text-gray-400"
                />
              </button>

              {showEventDropdown && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-300 bg-white shadow-lg">
                  <div className="border-b border-gray-200 p-2">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Search events by name, city or state..."
                      value={eventSearchQuery}
                      onChange={(e) => setEventSearchQuery(e.target.value)}
                      className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1D0A74]"
                    />
                  </div>
                  <div role="listbox" className="max-h-60 overflow-y-auto">
                    {loadingEvents ? (
                      <div className="px-4 py-3 text-center text-gray-500">
                        <Icon icon="mdi:loading" className="mx-auto h-5 w-5 animate-spin" />
                      </div>
                    ) : filteredEvents.length === 0 ? (
                      <div className="px-4 py-3 text-center text-sm text-gray-500">
                        {eventSearchQuery.trim()
                          ? 'No live events match that search'
                          : 'No live events to link to'}
                      </div>
                    ) : (
                      filteredEvents.map((event) => {
                        const isSelected = form.destinationEventId === event.$id
                        return (
                          <button
                            key={event.$id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            // Choosing replaces whatever was picked before — never adds to it.
                            onClick={() => {
                              setForm((prev) => ({ ...prev, destinationEventId: event.$id }))
                              setShowEventDropdown(false)
                              setEventSearchQuery('')
                            }}
                            className={`flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 ${
                              isSelected ? 'bg-[#1D0A74]/5' : ''
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-gray-900">
                                {event.name}
                              </span>
                              <span className="block truncate text-xs text-gray-500">
                                {eventSubtitle(event)}
                              </span>
                            </span>
                            {isSelected && (
                              <Icon icon="mdi:check" className="h-4 w-4 shrink-0 text-[#1D0A74]" />
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                  {hiddenEventCount > 0 && (
                    <div className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
                      +{hiddenEventCount} more not shown — keep typing to narrow the list.
                    </div>
                  )}
                </div>
              )}
            </div>
            {destinationIssue && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <Icon
                  icon="mdi:alert-outline"
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                />
                <p className="text-xs text-amber-800">{destinationIssue}</p>
              </div>
            )}
            <p className="text-xs text-gray-500 mt-1">
              Tapping the banner opens this event's page inside the app. One event per pop-up.
              Archived, hidden and finished events are not listed — the app will not open them.
            </p>
          </>
        )}
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Start Date *</label>
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">End Date *</label>
          <input
            type="date"
            value={form.endDate}
            min={form.startDate || undefined}
            onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
            className={inputClass}
          />
        </div>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        The pop-up shows each day of this range (inclusive), once per user per day.
      </p>

      {/* 21+ gate */}
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={form.only21Plus}
          onChange={(e) => setForm((prev) => ({ ...prev, only21Plus: e.target.checked }))}
          className="h-4 w-4 rounded border-gray-300 text-[#1D0A74] focus:ring-[#1D0A74]"
        />
        <span className="text-sm font-medium text-gray-700">
          21+ only (show only to age-verified users — required for alcohol ads)
        </span>
      </label>

      {/* Audience (mirrors CreateNotificationModal) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Target Audience</label>
        <div className="relative">
          <select
            value={form.targetAudience}
            onChange={(e) => {
              const audience = e.target.value as NotificationAudience
              setForm((prev) => ({
                ...prev,
                targetAudience: audience,
                selectedUserIds: [],
                selectedZipCodes: [],
                newUsersTimeRange: undefined,
              }))
            }}
            className={`${inputClass} appearance-none bg-white pr-10`}
          >
            <option value="All">All Users</option>
            <option value="NewUsers">New Users</option>
            <option value="BrandAmbassadors">Certified Brand Ambassadors (BA)</option>
            <option value="Influencers">Certified Influencers</option>
            <option value="Tier1">Tier 1 Users - NewbieSamplers</option>
            <option value="Tier2">Tier 2 Users - SampleFans</option>
            <option value="Tier3">Tier 3 Users - SuperSamplers</option>
            <option value="Tier4">Tier 4 Users - VIS</option>
            <option value="Tier5">Tier 5 Users - SampleMasters</option>
            <option value="ZipCode">All Users within specific zip code area (multi-select)</option>
            <option value="Targeted">Specific Users</option>
          </select>
          <Icon
            icon="mdi:chevron-down"
            className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
          />
        </div>
      </div>

      {form.targetAudience === 'NewUsers' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            New Users Time Range (days)
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={form.newUsersTimeRange ?? ''}
            onChange={(e) => {
              const val = e.target.value
                ? Math.max(1, Math.min(365, Number(e.target.value)))
                : undefined
              setForm((prev) => ({ ...prev, newUsersTimeRange: val }))
            }}
            className={inputClass}
            placeholder="e.g. 30"
          />
          <p className="text-xs text-gray-500 mt-1">
            Show to users who signed up within the last N days (default 30).
          </p>
        </div>
      )}

      {form.targetAudience === 'ZipCode' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Zip Codes</label>
          <select
            multiple
            value={form.selectedZipCodes}
            onChange={(e) => {
              const options = Array.from(e.target.selectedOptions).map((o) => o.value)
              setForm((prev) => ({ ...prev, selectedZipCodes: options }))
            }}
            className={`${inputClass} min-h-[120px]`}
          >
            {isLoadingZipCodes && <option disabled>Loading zip codes...</option>}
            {!isLoadingZipCodes &&
              availableZipCodes.map((zip) => (
                <option key={zip} value={zip}>
                  {zip}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Hold Ctrl (Windows) or Command (Mac) to select multiple zip codes.
          </p>
        </div>
      )}

      {form.targetAudience === 'Targeted' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Select Users</label>
          {form.selectedUserIds.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {form.selectedUserIds.map((userId) => {
                const user = users.find((u) => u.$id === userId)
                if (!user) return null
                return (
                  <div
                    key={userId}
                    className="inline-flex items-center gap-2 px-3 py-1 bg-[#1D0A74] text-white rounded-full text-sm"
                  >
                    <span>{getPopupUserDisplayName(user)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          selectedUserIds: prev.selectedUserIds.filter((id) => id !== userId),
                        }))
                      }
                      className="hover:bg-white/20 rounded-full p-0.5"
                    >
                      <Icon icon="mdi:close" className="w-4 h-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <div className="relative popup-user-dropdown-container">
            <input
              type="text"
              placeholder="Search users by name, email or username..."
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              onFocus={() => setShowUserDropdown(true)}
              onBlur={() => setTimeout(() => setShowUserDropdown(false), 200)}
              className={inputClass}
            />
            {showUserDropdown && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {loadingUsers ? (
                  <div className="px-4 py-3 text-center text-gray-500">
                    <Icon icon="mdi:loading" className="w-5 h-5 animate-spin mx-auto" />
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="px-4 py-3 text-center text-gray-500">No users found</div>
                ) : (
                  filteredUsers.map((user) => {
                    const isSelected = form.selectedUserIds.includes(user.$id)
                    return (
                      <div
                        key={user.$id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            selectedUserIds: isSelected
                              ? prev.selectedUserIds.filter((id) => id !== user.$id)
                              : [...prev.selectedUserIds, user.$id],
                          }))
                        }
                        className={`px-4 py-2 cursor-pointer hover:bg-gray-100 flex items-center justify-between ${
                          isSelected ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div>
                          <div className="font-medium text-gray-900">
                            {getPopupUserDisplayName(user)}
                          </div>
                          {user.email && <div className="text-xs text-gray-500">{user.email}</div>}
                        </div>
                        {isSelected && <Icon icon="mdi:check" className="w-5 h-5 text-[#1D0A74]" />}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Selected {form.selectedUserIds.length} user(s)
          </p>
        </div>
      )}
    </div>
  )
}

/** Convert the date-input form to the persisted payload (full-day UTC window). */
// eslint-disable-next-line react-refresh/only-export-components -- shared payload builder, reused by EditPopupModal
export const buildPopupPayload = (
  form: PopupFormState,
  image: { fileId: string; fileUrl: string },
  appTimezone: string
): PopupFormPayload => ({
  title: form.title.trim(),
  description: form.description.trim() ? form.description.trim() : null,
  imageUrl: image.fileUrl,
  imageFileId: image.fileId,
  link: form.destinationType === 'external' ? normalizePopupLink(form.link) || null : null,
  destinationType: form.destinationType,
  destinationEventId:
    form.destinationType === 'event' ? form.destinationEventId || null : null,
  startDate: appTimeToUTC(form.startDate, '00:00', appTimezone).toISOString(),
  endDate: appTimeToUTC(form.endDate, '23:59', appTimezone).toISOString(),
  only21Plus: form.only21Plus,
  targetAudience: form.targetAudience,
  selectedUserIds: form.selectedUserIds,
  selectedZipCodes: form.selectedZipCodes,
  newUsersTimeRange: form.newUsersTimeRange ?? null,
})

const CreatePopupModal = ({ isOpen, onClose, onSave, duplicateOf }: CreatePopupModalProps) => {
  const { appTimezone } = useTimezoneStore()
  const [form, setForm] = useState<PopupFormState>(initialPopupFormState)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCopyingBanner, setIsCopyingBanner] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  /** Set by PopupFormFields when the chosen event is one the app will refuse to open. */
  const [destinationIssue, setDestinationIssue] = useState<string | null>(null)
  const isSubmittingRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setDestinationIssue(null)

    if (!duplicateOf) {
      setForm(initialPopupFormState)
      setImageFile(null)
      setImagePreviewUrl(null)
      setIsCopyingBanner(false)
      return
    }

    // Duplicating: every field is prefilled, and the banner is re-uploaded on save as an
    // independent file. The source image shows immediately; the local copy swaps in behind it.
    setForm(popupToFormState(duplicateOf, appTimezone))
    setImageFile(null)
    setImagePreviewUrl(duplicateOf.imageUrl)
    setIsCopyingBanner(true)

    // A duplicate uploads its own copy of the banner. Reusing the source `imageFileId`
    // would be cheaper, but deleting either pop-up deletes that one shared storage file
    // (see `handleDelete` in Popups.tsx) and would silently blank the other's banner.
    let cancelled = false
    downloadStorageImageAsFile(duplicateOf.imageFileId)
      .then((file) => {
        if (cancelled) return
        setImageFile(file)
        setImagePreviewUrl(URL.createObjectURL(file))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('Error copying popup banner:', err)
        setImagePreviewUrl(null)
        // Name the cause: this read needs a live session, so a failure here is usually an
        // expired login rather than a missing file, and that is worth telling apart.
        const reason = err instanceof Error && err.message ? ` (${err.message})` : ''
        setError(`Could not copy the banner image${reason}. Please choose one before saving.`)
      })
      .finally(() => {
        if (!cancelled) setIsCopyingBanner(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, duplicateOf, appTimezone])

  const handleImageSelected = (file: File) => {
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
    // Clears a failed banner-copy message once the admin supplies an image themselves.
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    // A rotten destination blocks the save outright: storing it would hand the app a link
    // it is guaranteed to reject, and the admin would only find out from a user.
    const validationError = validatePopupForm(form, imageFile !== null) ?? destinationIssue
    if (validationError) {
      setError(validationError)
      return
    }
    isSubmittingRef.current = true
    setIsSubmitting(true)
    setError(null)
    try {
      const uploaded = await uploadImageToStorage(imageFile as File)
      try {
        await onSave(buildPopupPayload(form, uploaded, appTimezone))
      } catch (saveErr) {
        // Roll back the just-uploaded image so a failed create doesn't orphan a file
        // in the shared bucket (Edit already does the mirror-image cleanup on replace).
        await deleteStorageFile(uploaded.fileId)
        throw saveErr
      }
      onClose()
    } catch (err) {
      console.error('Error saving popup:', err)
      setError('Failed to save pop-up. Please try again.')
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {duplicateOf ? 'Duplicate Pop-up' : 'Create Pop-up'}
            </h2>
            {duplicateOf && (
              <p className="mt-1 text-sm text-gray-500">
                Copy of &ldquo;{duplicateOf.title?.trim() || 'Untitled'}&rdquo;. Saving creates a
                new pop-up with its own banner and its own view and click counts.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="shrink-0 rounded-full p-1 hover:bg-gray-100 disabled:opacity-50"
          >
            <Icon icon="mdi:close" className="h-6 w-6 text-gray-500" />
          </button>
        </div>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <form onSubmit={handleSubmit}>
          <PopupFormFields
            form={form}
            setForm={setForm}
            imagePreviewUrl={imagePreviewUrl}
            onImageSelected={handleImageSelected}
            onDestinationIssue={setDestinationIssue}
          />
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="mr-auto rounded-lg border border-[#1D0A74] px-4 py-2 text-[#1D0A74] hover:bg-[#1D0A74]/5"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isCopyingBanner}
              className="rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : isCopyingBanner ? 'Copying image…' : 'Create Pop-up'}
            </button>
          </div>
        </form>
      </div>
      <PreviewPopupModal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        title={form.title}
        description={form.description}
        link={form.link}
        imageUrl={imagePreviewUrl}
        destinationType={form.destinationType}
        destinationEventId={form.destinationEventId}
      />
    </div>
  )
}

export default CreatePopupModal
