import { Icon } from '@iconify/react'

interface LocationsHeaderProps {
  onAddLocation: () => void
  onBulkImport: () => void
}

const LocationsHeader = ({ onAddLocation, onBulkImport }: LocationsHeaderProps) => {
  return (
    <div className="mb-8 flex items-start justify-between">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Locations</h1>
        <p className="text-gray-600">Manage event locations and addresses.</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onBulkImport}
          className="px-4 py-2 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg hover:bg-[#1D0A74]/20 transition-colors flex items-center gap-2"
        >
          <Icon icon="mdi:file-upload-outline" className="w-5 h-5" />
          Bulk Import
        </button>
        <button
          onClick={onAddLocation}
          className="px-4 py-2 bg-[#1D0A74] text-white rounded-lg hover:bg-[#15065c] transition-colors flex items-center gap-2"
        >
          <Icon icon="mdi:plus" className="w-5 h-5" />
          Add Location
        </button>
      </div>
    </div>
  )
}

export default LocationsHeader
