import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PopupDocument } from '../../../lib/services'
import { uploadImageToStorage, deleteStorageFile } from '../../../lib/storageUtils'
import { useTimezoneStore } from '../../../stores/timezoneStore'
import {
  PopupFormFields,
  buildPopupPayload,
  initialPopupFormState,
  popupToFormState,
  validatePopupForm,
} from './CreatePopupModal'
import type { PopupFormPayload, PopupFormState } from './CreatePopupModal'
import PreviewPopupModal from './PreviewPopupModal'

interface EditPopupModalProps {
  isOpen: boolean
  popup: PopupDocument | null
  onClose: () => void
  onSave: (id: string, data: PopupFormPayload) => Promise<void>
  /** Hand this pop-up to the create flow as a copy. Hidden when not provided. */
  onDuplicate?: () => void
}

const EditPopupModal = ({ isOpen, popup, onClose, onSave, onDuplicate }: EditPopupModalProps) => {
  const { appTimezone } = useTimezoneStore()
  const [form, setForm] = useState<PopupFormState>(initialPopupFormState)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  /** Set by PopupFormFields when the chosen event is one the app will refuse to open. */
  const [destinationIssue, setDestinationIssue] = useState<string | null>(null)
  const isSubmittingRef = useRef(false)

  useEffect(() => {
    if (isOpen && popup) {
      setForm(popupToFormState(popup, appTimezone))
      setImageFile(null)
      setImagePreviewUrl(popup.imageUrl)
      setError(null)
      setDestinationIssue(null)
    }
  }, [isOpen, popup, appTimezone])

  if (!isOpen || !popup) return null

  const handleImageSelected = (file: File) => {
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    // An event archived after this pop-up was saved blocks the save: the destination has to
    // be re-pointed rather than carried forward into an update.
    const validationError = validatePopupForm(form, true) ?? destinationIssue // an image always exists in edit
    if (validationError) {
      setError(validationError)
      return
    }
    isSubmittingRef.current = true
    setIsSubmitting(true)
    setError(null)
    try {
      const image = imageFile
        ? await uploadImageToStorage(imageFile)
        : { fileId: popup.imageFileId, fileUrl: popup.imageUrl }
      await onSave(popup.$id, buildPopupPayload(form, image, appTimezone))
      if (imageFile && popup.imageFileId && popup.imageFileId !== image.fileId) {
        await deleteStorageFile(popup.imageFileId)
      }
      onClose()
    } catch (err) {
      console.error('Error updating popup:', err)
      setError('Failed to update pop-up. Please try again.')
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">Edit Pop-up</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-full p-1 hover:bg-gray-100 disabled:opacity-50"
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
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            {/* Left group: actions that do not save this pop-up. */}
            <div className="mr-auto flex gap-3">
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                className="rounded-lg border border-[#1D0A74] px-4 py-2 text-[#1D0A74] hover:bg-[#1D0A74]/5"
              >
                Preview
              </button>
              {onDuplicate && (
                <button
                  type="button"
                  onClick={onDuplicate}
                  disabled={isSubmitting}
                  title="Create a new pop-up from the saved version of this one"
                  className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Icon icon="mdi:content-copy" className="h-5 w-5" />
                  Duplicate
                </button>
              )}
            </div>
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
              disabled={isSubmitting}
              className="rounded-lg bg-[#1D0A74] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Changes'}
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

export default EditPopupModal
