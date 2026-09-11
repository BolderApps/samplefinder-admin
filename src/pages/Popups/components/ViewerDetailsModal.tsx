import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { Shimmer } from '../../../components'
import {
  appUsersService,
  popupsService,
  type AppUser,
  type PopupViewerRow,
} from '../../../lib/services'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import { useNotificationStore } from '../../../stores/notificationStore'
import { formatDateInAppTimezone, formatDateTimeInAppTimezone } from '../../../lib/dateUtils'

interface ViewerDetailsModalProps {
  /** The campaign this row belongs to, so it can be re-shown to this one user. */
  popupId: string
  /** Why re-showing is unavailable (campaign not running), or null/absent when allowed. */
  reshowBlockedReason?: string | null
  /** The clicked row. Null keeps the modal closed. */
  viewer: PopupViewerRow | null
  onClose: () => void
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error'

const formatPhone = (phoneNumber: string | undefined): string => {
  if (!phoneNumber) return '-'
  const cleaned = phoneNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`
  }
  return phoneNumber
}

/** Whole years elapsed, so it matches how the 21+ gate itself computes age. */
const ageFromDob = (dob: string | undefined): number | null => {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - born.getFullYear()
  const monthDelta = now.getMonth() - born.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) age -= 1
  return age
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</dt>
    <dd className="mt-1 text-sm text-gray-900">{value}</dd>
  </div>
)

const Badge = ({ icon, label, tone }: { icon: string; label: string; tone: string }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
    <Icon icon={icon} className="h-3.5 w-3.5" />
    {label}
  </span>
)

/**
 * Read-only profile for one row of "Who saw this pop-up".
 *
 * Opens in place rather than navigating, so an admin scanning a viewer list keeps their
 * filters, sort and page. Everything the clicked row already carries renders immediately;
 * only the profile block waits on a fetch. Editing is deliberately not offered here —
 * "Open full profile" hands off to the App Users screen, which owns that.
 */
const ViewerDetailsModal = ({
  popupId,
  reshowBlockedReason,
  viewer,
  onClose,
}: ViewerDetailsModalProps) => {
  const navigate = useNavigate()
  const { appTimezone } = useTimezoneStore()
  const { addNotification } = useNotificationStore()
  const [profile, setProfile] = useState<AppUser | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [isReshowing, setIsReshowing] = useState(false)

  const userId = viewer?.userId ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setProfile(null)
    setState('loading')
    appUsersService
      .getById(userId)
      .then((user) => {
        if (cancelled) return
        // The viewer list falls back to the raw id for profiles that no longer exist, so a
        // null here is an expected outcome, not a failure.
        setProfile(user)
        setState(user ? 'ready' : 'missing')
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Error loading viewer profile:', err)
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(() => {
    if (!viewer) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewer, onClose])

  if (!viewer) return null

  const age = ageFromDob(profile?.dob)
  const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ')
  const displayName = fullName || viewer.name
  const points = profile?.totalPoints ?? profile?.userPoints
  const checkIns = profile?.totalEvents ?? profile?.checkIns
  const reviews = profile?.totalReviews ?? profile?.reviews
  const isAmbassador = profile?.isAmbassador || profile?.baBadge
  const isInfluencer = profile?.isInfluencer || profile?.influencerBadge

  /**
   * Re-open this pop-up to this one user; everyone else is untouched.
   *
   * No confirmation step, unlike the campaign-wide button on the detail page: the effect is
   * one person seeing a banner once more, which is not worth a second click. `affected` keeps
   * the outcome honest, but it only counts the sightings this call cleared: zero means the
   * pop-up was already eligible for this user — either they have not seen it today, or an
   * earlier "Show again" retired their rows — so the message reports that outcome instead of
   * guessing which of the two it was.
   */
  const handleReshowForUser = async () => {
    if (!viewer || isReshowing) return
    setIsReshowing(true)
    try {
      const result = await popupsService.resetInteractions(popupId, viewer.userId)
      addNotification(
        result.affected > 0
          ? {
              type: 'success',
              title: 'Pop-up re-opened for this user',
              message: `${displayName} will see it again the next time they open the app.`,
            }
          : {
              type: 'info',
              title: 'Nothing to re-open',
              message: `This pop-up can already be shown to ${displayName} again — they had no sighting left to clear.`,
            }
      )
    } catch (err) {
      console.error('Error re-showing popup for user:', err)
      addNotification({
        type: 'error',
        title: 'Failed to re-show pop-up',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsReshowing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="User details"
        className="relative m-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">User details</h2>
            <p className="mt-1 text-sm text-gray-600">
              Profile and how this person engaged with the pop-up.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close user details"
            className="text-gray-400 transition-colors hover:text-gray-600"
          >
            <Icon icon="mdi:close" className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6">
          {state === 'missing' && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <Icon icon="mdi:account-off-outline" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <h3 className="text-sm font-semibold text-amber-900">This profile no longer exists</h3>
                <p className="mt-1 text-xs text-amber-700">
                  The account was deleted after it saw this pop-up. Its interaction is still counted
                  in the campaign totals.
                </p>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
              <Icon icon="mdi:alert-circle-outline" className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div>
                <h3 className="text-sm font-semibold text-red-900">Could not load this profile</h3>
                <p className="mt-1 text-xs text-red-700">
                  The interaction details below are still accurate. Close and reopen to try again.
                </p>
              </div>
            </div>
          )}

          {profile?.isBlocked && (
            <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
              <Icon icon="mdi:alert-circle" className="h-6 w-6 shrink-0 text-red-600" />
              <div>
                <h3 className="text-sm font-semibold text-red-900">User is currently blocked</h3>
                <p className="mt-1 text-xs text-red-700">
                  This account is blacklisted and cannot log in.
                </p>
              </div>
            </div>
          )}

          {/* Identity — name and username come from the clicked row, so they render at once. */}
          <div className="mb-6 flex items-start gap-4">
            {profile?.avatarURL ? (
              <img
                src={profile.avatarURL}
                alt={displayName}
                className="h-20 w-20 rounded-full border-2 border-gray-200 object-cover"
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-gray-300 bg-gray-200">
                <Icon icon="mdi:account" className="h-10 w-10 text-gray-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold text-gray-900">{displayName}</h3>
              {viewer.username && <p className="truncate text-sm text-gray-500">@{viewer.username}</p>}
              {state === 'loading' ? (
                <Shimmer width="220px" height="14px" className="mt-2" />
              ) : (
                profile?.email && <p className="mt-1 truncate text-sm text-gray-700">{profile.email}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {isAmbassador && (
                  <Badge icon="mdi:star" label="Brand Ambassador" tone="bg-purple-50 text-purple-700" />
                )}
                {isInfluencer && (
                  <Badge icon="mdi:bullhorn" label="Influencer" tone="bg-blue-50 text-blue-700" />
                )}
                {profile?.role === 'admin' && (
                  <Badge icon="mdi:shield-account" label="Admin" tone="bg-gray-100 text-gray-700" />
                )}
              </div>
            </div>
          </div>

          {/* This pop-up — the reason the admin opened the row. */}
          <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h4 className="mb-3 text-sm font-semibold text-gray-900">This pop-up</h4>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field
                label="Impressions"
                value={
                  viewer.impressions > 1
                    ? `${viewer.impressions.toLocaleString()} times over ${viewer.dayKeys.length} ${
                        viewer.dayKeys.length === 1 ? 'day' : 'days'
                      }`
                    : 'Once'
                }
              />
              <Field
                label="Last seen"
                value={
                  viewer.lastShownAt
                    ? formatDateTimeInAppTimezone(viewer.lastShownAt, appTimezone)
                    : '-'
                }
              />
              {/* Only earns its place once there is more than one sighting to bracket. */}
              {viewer.impressions > 1 && (
                <Field
                  label="First seen"
                  value={
                    viewer.firstShownAt
                      ? formatDateTimeInAppTimezone(viewer.firstShownAt, appTimezone)
                      : '-'
                  }
                />
              )}
              <Field
                label={viewer.impressions > 1 ? 'Last clicked' : 'Clicked'}
                value={
                  viewer.clickedAt
                    ? formatDateTimeInAppTimezone(viewer.clickedAt, appTimezone)
                    : 'Did not click'
                }
              />
              <Field label="Age gate when shown" value={viewer.is21Plus ? '21+' : 'Under 21'} />
            </dl>
          </div>

          {/* Profile */}
          <h4 className="mb-3 text-sm font-semibold text-gray-900">Profile</h4>
          {state === 'loading' ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i}>
                  <Shimmer width="70px" height="12px" />
                  <Shimmer width="110px" height="14px" className="mt-2" />
                </div>
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Tier" value={profile?.tierLevel || '-'} />
              <Field label="Points" value={points != null ? points.toLocaleString() : '-'} />
              <Field label="Check-ins" value={checkIns != null ? String(checkIns) : '-'} />
              <Field label="Reviews" value={reviews != null ? String(reviews) : '-'} />
              <Field label="Phone" value={formatPhone(profile?.phoneNumber)} />
              <Field label="Zip Code" value={profile?.zipCode || '-'} />
              <Field
                label="Date of Birth"
                value={
                  profile?.dob
                    ? `${formatDateInAppTimezone(profile.dob, appTimezone, 'medium')}${
                        age != null ? ` (${age})` : ''
                      }`
                    : '-'
                }
              />
              <Field label="Referral Code" value={profile?.referralCode || '-'} />
              <Field
                label="Signed Up"
                value={
                  profile?.$createdAt
                    ? formatDateInAppTimezone(profile.$createdAt, appTimezone, 'medium')
                    : '-'
                }
              />
            </dl>
          )}
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white px-6 py-4">
          <span className="font-mono text-xs text-gray-400">{viewer.userId}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Close
            </button>
            {/* Re-opens this one user's sighting; the campaign-wide button is on the page itself. */}
            <button
              type="button"
              onClick={handleReshowForUser}
              disabled={isReshowing || !!reshowBlockedReason}
              title={reshowBlockedReason || 'Let this user see this pop-up again today'}
              className="flex items-center gap-2 rounded-lg border border-[#1D0A74] px-4 py-2 text-sm font-medium text-[#1D0A74] transition-colors hover:bg-[#1D0A74]/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon
                icon={isReshowing ? 'mdi:loading' : 'mdi:refresh'}
                className={`h-5 w-5 ${isReshowing ? 'animate-spin' : ''}`}
              />
              {isReshowing ? 'Re-opening...' : 'Show again'}
            </button>
            {/* Editing lives on the App Users screen; ?userId= opens that profile directly. */}
            <button
              type="button"
              onClick={() => navigate(`/app-users?userId=${encodeURIComponent(viewer.userId)}`)}
              disabled={state !== 'ready'}
              className="flex items-center gap-2 rounded-lg bg-[#1D0A74] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1D0A74]/90 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                state === 'ready'
                  ? 'Open this user on the App Users screen'
                  : 'Available once the profile loads'
              }
            >
              <Icon icon="mdi:account-edit" className="h-5 w-5" />
              Open full profile
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ViewerDetailsModal
