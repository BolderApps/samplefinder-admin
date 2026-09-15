import { Icon } from '@iconify/react'

export type ConfirmationType = 'delete' | 'archive' | 'unarchive' | 'hide' | 'unhide' | 'block' | 'unblock' | 'reshow'

interface ConfirmationModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  type: ConfirmationType
  title?: string
  message?: string
  itemName?: string // e.g., "client", "event" - for dynamic titles
  isLoading?: boolean // Loading state for async actions
}

const ConfirmationModal = ({
  isOpen,
  onClose,
  onConfirm,
  type,
  title,
  message,
  itemName = 'item',
  isLoading = false,
}: ConfirmationModalProps) => {
  if (!isOpen) return null

  // Configuration for each type
  const configs = {
    delete: {
      icon: 'mdi:trash-can',
      iconColor: 'text-red-500',
      iconBg: 'bg-red-50',
      buttonBg: 'bg-red-500 hover:bg-red-600',
      buttonBgDisabled: 'bg-red-400',
      defaultTitle: `Are you sure you want to delete ${itemName}?`,
      defaultMessage: `All information about ${itemName} will be lost.`,
      confirmText: 'Yes, delete',
      loadingText: 'Deleting...',
    },
    archive: {
      icon: 'mdi:cloud-upload',
      iconColor: 'text-orange-500',
      iconBg: 'bg-orange-50',
      buttonBg: 'bg-orange-500 hover:bg-orange-600',
      buttonBgDisabled: 'bg-orange-400',
      defaultTitle: 'Are you sure you want to archive?',
      defaultMessage: 'All data about your event will be archived.',
      confirmText: 'Yes, archive',
      loadingText: 'Archiving...',
    },
    unarchive: {
      icon: 'mdi:archive-arrow-up',
      iconColor: 'text-green-500',
      iconBg: 'bg-green-50',
      buttonBg: 'bg-green-500 hover:bg-green-600',
      buttonBgDisabled: 'bg-green-400',
      defaultTitle: 'Are you sure you want to unarchive?',
      defaultMessage: 'This event will be restored from the archive.',
      confirmText: 'Yes, unarchive',
      loadingText: 'Unarchiving...',
    },
    hide: {
      icon: 'mdi:eye-off',
      iconColor: 'text-green-500',
      iconBg: 'bg-green-50',
      buttonBg: 'bg-[#1D0A74] hover:bg-[#15065c]',
      buttonBgDisabled: 'bg-[#2D1A84]',
      defaultTitle: 'Are you sure you want to hide?',
      defaultMessage: 'All data about your event will be hidden.',
      confirmText: 'Yes, hide',
      loadingText: 'Hiding...',
    },
    unhide: {
      icon: 'mdi:eye',
      iconColor: 'text-green-500',
      iconBg: 'bg-green-50',
      buttonBg: 'bg-green-500 hover:bg-green-600',
      buttonBgDisabled: 'bg-green-400',
      defaultTitle: 'Are you sure you want to unhide?',
      defaultMessage: 'This event will be visible to users again.',
      confirmText: 'Yes, unhide',
      loadingText: 'Unhiding...',
    },
    block: {
      icon: 'mdi:lock',
      iconColor: 'text-gray-900',
      iconBg: 'bg-gray-50',
      buttonBg: 'bg-black hover:bg-gray-800',
      buttonBgDisabled: 'bg-gray-600',
      defaultTitle: `Block ${itemName}?`,
      defaultMessage: `This ${itemName} will be added to blacklist, logged out immediately, and prevented from logging in until unblocked.`,
      confirmText: 'Yes, block',
      loadingText: 'Blocking...',
    },
    reshow: {
      icon: 'mdi:refresh',
      iconColor: 'text-[#1D0A74]',
      iconBg: 'bg-[#1D0A74]/5',
      buttonBg: 'bg-[#1D0A74] hover:bg-[#15065c]',
      buttonBgDisabled: 'bg-[#2D1A84]',
      defaultTitle: `Show this ${itemName} again?`,
      defaultMessage: `Anyone who has already seen this ${itemName} today will see it once more.`,
      confirmText: 'Yes, show again',
      loadingText: 'Re-opening...',
    },
    unblock: {
      icon: 'mdi:lock-open',
      iconColor: 'text-green-500',
      iconBg: 'bg-green-50',
      buttonBg: 'bg-green-500 hover:bg-green-600',
      buttonBgDisabled: 'bg-green-400',
      defaultTitle: `Unblock ${itemName}?`,
      defaultMessage: `This ${itemName} will be removed from blacklist and will be able to login again.`,
      confirmText: 'Yes, unblock',
      loadingText: 'Unblocking...',
    },
  }

  // Fallback to 'delete' config if type is invalid
  const config = configs[type] || configs.delete

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onConfirm()
    // Don't close here - let parent handle closing after async operation
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Modal */}
      <div 
        className="relative bg-white rounded-lg shadow-xl w-full max-w-md m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          {/* Icon */}
          <div className="flex justify-center mb-6">
            {isLoading ? (
              <Icon icon="mdi:loading" className={`w-20 h-20 ${config.iconColor} animate-spin`} />
            ) : (
              <Icon icon={config.icon} className={`w-20 h-20 ${config.iconColor}`} />
            )}
          </div>

          {/* Title */}
          <h2 className="text-xl font-bold text-gray-900 text-center mb-2">
            {title || config.defaultTitle}
          </h2>

          {/* Message */}
          <p className="text-sm text-gray-600 text-center mb-6">
            {message || config.defaultMessage}
          </p>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="flex-1 px-6 py-3 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isLoading}
              className={`flex-1 px-6 py-3 ${isLoading ? config.buttonBgDisabled : config.buttonBg} text-white rounded-lg transition-colors font-semibold cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2`}
            >
              {isLoading && <Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />}
              {isLoading ? config.loadingText : config.confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ConfirmationModal

