import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import ImportReviewTable from './ImportReviewTable'
import { GOOGLE_MAPS_API_KEY } from '../../../lib/googleMapsKey'
import { locationsService } from '../../../lib/services'
import { useNotificationStore } from '../../../stores/notificationStore'
import {
  applyAddressEdit, applyGoogleMatch, classifyAll, classifyRow, createGoogleGeocoder,
  parseLocationsCsv, resolveStateForWrite,
  type AddressFields, type ClassifiedRow,
} from '../../../lib/locationImport'

interface ImportLocationsModalProps {
  isOpen: boolean
  onClose: () => void
  onImported: () => Promise<void>
}

const TEMPLATE_HEADERS = 'Name,Address,City,State,Zip'
const TEMPLATE_ROW = '[REPLACE WITH LOCATION NAME],[REPLACE WITH STREET ADDRESS],'
  + '[REPLACE WITH CITY],[REPLACE WITH STATE],[REPLACE WITH ZIP]'

/** Appwrite writes are cheap but not free; 4 at a time keeps the UI responsive. */
const WRITE_CONCURRENCY = 4

const geocode = createGoogleGeocoder(GOOGLE_MAPS_API_KEY, fetch)

const ImportLocationsModal = ({ isOpen, onClose, onImported }: ImportLocationsModalProps) => {
  const { addNotification } = useNotificationStore()
  const [rows, setRows] = useState<ClassifiedRow[]>([])
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [fileError, setFileError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // In-flight guard: a row can be re-opened for editing and re-saved before its
  // previous geocode (up to ~1.25s of retries) resolves. A ref (not state) so the
  // check-and-set is synchronous even across rapid clicks in the same tick.
  const pendingEditsRef = useRef<Set<number>>(new Set())
  // Bumped whenever a new file is chosen or the modal closes, so a `handleFile`
  // run started for an earlier token can detect it has been superseded and stop
  // publishing results — covers both "cancel mid-geocode, reopen" and "pick a
  // second file while the first is still processing".
  const runTokenRef = useRef(0)

  // Clear everything on close so reopening never shows a previous file's review.
  useEffect(() => {
    if (!isOpen) {
      runTokenRef.current += 1
      setRows([])
      setSkipped(new Set())
      setFileError(null)
      setIsProcessing(false)
      setIsImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  const importable = rows.filter((row) => row.status === 'ready' && !skipped.has(row.rowNumber))

  const handleFile = async (file: File) => {
    // Captured immediately: this run is only allowed to publish state while
    // runTokenRef still holds this same value. Closing the modal or choosing
    // another file bumps the ref, and every check below then short-circuits.
    const token = runTokenRef.current
    setFileError(null)
    setIsProcessing(true)
    try {
      const parsed = parseLocationsCsv(await file.text())
      if (runTokenRef.current !== token) return
      if (parsed.fileError !== null) {
        setFileError(parsed.fileError)
        return
      }
      const { documents } = await locationsService.searchAll('')
      if (runTokenRef.current !== token) return
      const result = await classifyAll(parsed.rows, documents, { geocode })
      if (runTokenRef.current !== token) return
      if (result.aborted !== null) {
        setFileError(result.aborted)
        return
      }
      setRows(result.rows)
      setSkipped(new Set())
    } catch (error) {
      if (runTokenRef.current !== token) return
      setFileError(error instanceof Error ? error.message : 'Could not read that file')
    } finally {
      if (runTokenRef.current === token) setIsProcessing(false)
    }
  }

  const replaceRow = (rowNumber: number, next: (row: ClassifiedRow) => ClassifiedRow) => {
    setRows((current) => current.map((row) => (row.rowNumber === rowNumber ? next(row) : row)))
  }

  /**
   * Adopt Google's fields. `match.state` is the long name, which is what we store.
   * See applyGoogleMatch: the transition is guarded, so a row whose street Google
   * never matched is left in review rather than certified by this button.
   */
  const handleUseGoogle = (rowNumber: number) => {
    replaceRow(rowNumber, applyGoogleMatch)
  }

  /** Keep the typed address but retain `match` — its coordinates are still used. */
  const handleKeepMine = (rowNumber: number) => {
    replaceRow(rowNumber, (row) => ({ ...row, status: 'ready', reason: null, diff: [] }))
  }

  const handleEdit = async (rowNumber: number, fields: AddressFields) => {
    // Guard against the same row being saved again while its geocode (up to ~1.25s
    // of retries) is still in flight — nothing in the UI disables the button meanwhile.
    if (pendingEditsRef.current.has(rowNumber)) return
    pendingEditsRef.current.add(rowNumber)
    setFileError(null)
    try {
      const target = rows.find((row) => row.rowNumber === rowNumber)
      if (target === undefined) return
      // Not a plain `parseError: null` — see applyAddressEdit: the form cannot set the
      // name, so a blank-name rejection has to survive the edit.
      const edited = applyAddressEdit(target, fields)
      const outcome = await geocode(edited)
      // An abort here affects only this one re-check; surface it without discarding the batch.
      if (outcome.kind === 'abort') {
        setFileError(outcome.reason)
        return
      }
      replaceRow(rowNumber, () => classifyRow(edited, outcome))
    } finally {
      pendingEditsRef.current.delete(rowNumber)
    }
  }

  const handleSkip = (rowNumber: number) => {
    setSkipped((current) => {
      const next = new Set(current)
      if (next.has(rowNumber)) next.delete(rowNumber)
      else next.add(rowNumber)
      return next
    })
  }

  const handleImport = async () => {
    setIsImporting(true)
    // Snapshot before any mutation: the categorisation below reads row.status, and a
    // successful create rewrites that same row's status to 'duplicate' (see below), so
    // counting from live `rows` afterward would double-count or miscount.
    const snapshot = rows
    const queue = [...importable]
    let created = 0
    let writeFailed = 0
    let cursor = 0

    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++]
        try {
          await locationsService.create({
            name: row.name,
            address: row.address,
            city: row.city,
            // Widens "PA" to "Pennsylvania" to match records created by hand, while
            // leaving a state the operator kept via "Keep mine" alone. See
            // resolveStateForWrite.
            state: resolveStateForWrite(row.state, row.match),
            zipCode: row.zipCode,
            // [longitude, latitude] — the order locationsService documents.
            location: row.match === null
              ? undefined
              : [row.match.longitude, row.match.latitude],
          })
          created++
          // Mark it as no longer importable. The duplicate guard only ran once, at
          // upload time, against the collection as it stood then — without this, a
          // row that just succeeded stays 'ready' and unskipped, so a second Import
          // press (triggered by other rows having failed) would recreate it under
          // the same name, and locationsService.findByName / the event importer
          // would then resolve arbitrarily between the two.
          replaceRow(row.rowNumber, (current) => ({
            ...current,
            status: 'duplicate',
            reason: 'Imported in this run',
            existing: null,
          }))
        } catch (error) {
          writeFailed++
          const reason = error instanceof Error ? error.message : 'Could not save this location'
          replaceRow(row.rowNumber, (current) => ({ ...current, status: 'failed', reason }))
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(WRITE_CONCURRENCY, queue.length) }, worker)
    )
    setIsImporting(false)

    // Every row in the snapshot lands in exactly one bucket: skipped by the operator,
    // already a duplicate (of an existing record or of an earlier row — including one
    // just created above), still needing review, rejected before this run ever tried
    // Google (blank field, no geocode match, etc.), or in the attempted queue — whose
    // outcome is `created`/`writeFailed` above. That keeps the reported numbers summing
    // to the file's row count and keeps "never attempted" distinct from "attempted and
    // failed to save", which the old `rows.length - created - failed` residual conflated.
    let alreadyExisted = 0
    let needsReview = 0
    let rejected = 0
    let skippedByOperator = 0
    for (const row of snapshot) {
      if (skipped.has(row.rowNumber)) {
        skippedByOperator++
      } else if (row.status === 'duplicate') {
        alreadyExisted++
      } else if (row.status === 'review') {
        needsReview++
      } else if (row.status === 'failed') {
        rejected++
      }
      // Remaining rows are exactly `queue` (status 'ready', not skipped) and are
      // already counted via `created` / `writeFailed`.
    }

    const parts = [`Imported ${created}`]
    if (writeFailed > 0) parts.push(`could not be saved ${writeFailed}`)
    if (rejected > 0) parts.push(`rejected ${rejected}`)
    if (needsReview > 0) parts.push(`needs review ${needsReview}`)
    if (alreadyExisted > 0) parts.push(`already existed ${alreadyExisted}`)
    if (skippedByOperator > 0) parts.push(`skipped ${skippedByOperator}`)

    addNotification({
      type: writeFailed > 0 ? 'warning' : 'success',
      title: writeFailed > 0 ? 'Import finished with errors' : 'Locations Imported',
      message: parts.join(' · '),
    })

    // onImported() re-fetches the page; if that rejects, it must not become an
    // unhandled rejection (this whole function is invoked as `void handleImport()`).
    try {
      await onImported()
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : 'Locations were imported, but the list could not be refreshed. Reload the page to see them.'
      )
      return
    }
    if (writeFailed === 0) onClose()
  }

  const handleDownloadTemplate = () => {
    const uri = encodeURI(`data:text/csv;charset=utf-8,${TEMPLATE_HEADERS}\n${TEMPLATE_ROW}`)
    const link = document.createElement('a')
    link.setAttribute('href', uri)
    link.setAttribute('download', 'locations_template.csv')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const showReview = rows.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto m-4">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Bulk Import Locations</h2>
            <p className="text-sm text-gray-600 mt-1">
              {showReview
                ? 'Step 2 of 2 — review and correct, then import.'
                : 'Step 1 of 2 — upload a CSV. Addresses are checked against Google Maps.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={isProcessing || isImporting}
          >
            <Icon icon="mdi:close" className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6">
          {fileError !== null && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
              {fileError}
            </div>
          )}

          {!showReview && (
            <>
              <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                <Icon icon="mdi:cloud-upload" className="w-12 h-12 text-gray-400 mb-3" />
                <p className="mb-2 text-sm text-gray-500">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-gray-500">Your locations CSV</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onClick={(event) => { event.currentTarget.value = '' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) {
                      runTokenRef.current += 1
                      void handleFile(file)
                    }
                  }}
                />
              </label>

              <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
                <p className="text-sm text-blue-800 font-semibold">Required columns</p>
                <div className="flex flex-wrap gap-2">
                  {['Name', 'Address', 'City', 'State', 'Zip'].map((column) => (
                    <span key={column} className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm text-gray-700 font-medium">
                      {column}
                    </span>
                  ))}
                </div>
                <ul className="text-sm text-blue-800 list-disc list-inside space-y-1 pt-1">
                  <li>Location names are imported exactly as typed and are never corrected</li>
                  <li>Addresses are checked against Google Maps; you review anything that differs</li>
                  <li>Names that already exist are skipped, never overwritten</li>
                  <li>Maximum 1000 rows per file</li>
                </ul>
              </div>
            </>
          )}

          {isProcessing && (
            <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />
              Checking addresses against Google Maps…
            </div>
          )}

          {showReview && (
            <ImportReviewTable
              rows={rows}
              skipped={skipped}
              onUseGoogle={handleUseGoogle}
              onKeepMine={handleKeepMine}
              onEdit={handleEdit}
              onSkip={handleSkip}
            />
          )}
        </div>

        <div className="flex gap-4 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={isImporting || isProcessing}
            className="flex-1 px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-semibold disabled:opacity-50"
          >
            Cancel
          </button>
          {!showReview && (
            <button
              onClick={handleDownloadTemplate}
              className="px-6 py-3 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg hover:bg-[#1D0A74]/20 transition-colors font-semibold"
            >
              Download Template
            </button>
          )}
          {showReview && (
            <button
              onClick={() => void handleImport()}
              disabled={importable.length === 0 || isImporting}
              className="flex-1 px-6 py-3 bg-[#1D0A74] text-white rounded-lg hover:bg-[#15065c] transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isImporting
                ? (<><Icon icon="mdi:loading" className="w-5 h-5 animate-spin" />Importing…</>)
                : `Import ${importable.length} location${importable.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ImportLocationsModal
