import { useEffect, useState, useRef } from 'react'
import { ConfirmationModal, DashboardLayout } from '../../components'
import { Query } from '../../lib/appwrite'
import { eventsService, locationsService, type LocationDocument, type LocationFormData } from '../../lib/services'
import { useNotificationStore } from '../../stores/notificationStore'
import {
  AddLocationModal,
  LocationsHeader,
  LocationsTable,
  EditLocationModal,
  ImportLocationsModal,
  SearchAndFilter,
} from './components'

// UI Location interface (for display and table)
interface UILocation {
  id?: string
  name: string
  address: string
  city: string
  state: string
  zipCode: string
  location?: [number, number] // [longitude, latitude]
}

// Helper function to extract error message from Appwrite error
const extractErrorMessage = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>
    
    // Check for Appwrite error response format
    if ('response' in errorObj && errorObj.response && typeof errorObj.response === 'object') {
      const response = errorObj.response as Record<string, unknown>
      if ('message' in response && typeof response.message === 'string') {
        return response.message
      }
    }
    
    // Check for direct message property
    if ('message' in errorObj && typeof errorObj.message === 'string') {
      return errorObj.message
    }
  }
  
  // Fallback for Error instances
  if (error instanceof Error) {
    return error.message
  }
  
  return 'An unexpected error occurred'
}

const Locations = () => {
  const { addNotification } = useNotificationStore()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [selectedLocation, setSelectedLocation] = useState<UILocation | null>(null)
  const [locationToDelete, setLocationToDelete] = useState<UILocation | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Transform LocationDocument to UILocation for display
  const transformToUILocation = (doc: LocationDocument): UILocation => {
    return {
      id: doc.$id,
      name: doc.name,
      address: doc.address,
      city: doc.city,
      state: doc.state,
      zipCode: doc.zipCode,
      location: doc.location || undefined,
    }
  }

  const [locations, setLocations] = useState<UILocation[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalLocations, setTotalLocations] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState<string>('$createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  // Only the latest fetch may commit — search now pages the full set (multiple round-trips), so a
  // slower earlier fetch could otherwise resolve after a newer one and overwrite it.
  const fetchIdRef = useRef(0)

  // Fetch locations from Appwrite with pagination, search, and sorting
  const fetchLocations = async (page: number = currentPage) => {
    const thisFetchId = ++fetchIdRef.current
    try {
      setIsLoading(true)
      setError(null)
      
      // Apply sorting (all sort fields are server-orderable)
      const orderMethod = sortOrder === 'asc' ? Query.orderAsc : Query.orderDesc
      let orderQuery: string
      if (sortBy === 'name') {
        orderQuery = orderMethod('name')
      } else if (sortBy === 'address') {
        orderQuery = orderMethod('address')
      } else if (sortBy === 'city') {
        orderQuery = orderMethod('city')
      } else if (sortBy === 'state') {
        orderQuery = orderMethod('state')
      } else if (sortBy === 'zipCode') {
        orderQuery = orderMethod('zipCode')
      } else {
        orderQuery = orderMethod('$createdAt')
      }

      // Determine if we're searching
      const isSearching = searchTerm.trim().length > 0

      // Searching filters client-side, so it must scan the FULL collection (searchAll pages through
      // everything) — a capped 500-row fetch hid matches beyond it, so an unrelated sort change could
      // "reveal" more results. Browsing keeps efficient server-side pagination.
      const result = isSearching
        ? await locationsService.searchAll(searchTerm.trim(), [orderQuery])
        : await locationsService.list([orderQuery, Query.limit(pageSize), Query.offset((page - 1) * pageSize)])

      // Discard this result if a newer fetch has started (avoids stale overwrite).
      if (thisFetchId !== fetchIdRef.current) return

      // Extract pagination metadata
      const total = result.total
      const totalPagesCount = Math.ceil(total / pageSize)
      setTotalLocations(total)
      setTotalPages(totalPagesCount)
      
      // Handle edge case: if current page exceeds total pages, reset to last valid page or page 1
      if (totalPagesCount > 0 && page > totalPagesCount) {
        const lastValidPage = totalPagesCount
        setCurrentPage(lastValidPage)
        if (page !== lastValidPage) {
          return fetchLocations(lastValidPage)
        }
      } else if (totalPagesCount === 0) {
        setCurrentPage(1)
      }
      
      // For search results, apply client-side pagination
      const documentsToProcess = isSearching
        ? result.documents.slice((page - 1) * pageSize, page * pageSize)
        : result.documents
      
      // Transform locations
      const transformedLocations = documentsToProcess.map(doc => transformToUILocation(doc))
      
      setLocations(transformedLocations)
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching locations:', err)
      setError('Failed to load locations. Please try again.')
    } finally {
      if (thisFetchId === fetchIdRef.current) {
        setIsLoading(false)
      }
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      fetchLocations(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Ignore no-op search updates so debounced callbacks do not reset pagination when term unchanged
  const handleSearchChange = (value: string) => {
    if (value === searchTerm) return
    setSearchTerm(value)
    setCurrentPage(1)
  }

  // Handle sort by change
  const handleSortByChange = (value: string) => {
    setSortBy(value)
    setCurrentPage(1) // Reset to page 1 when sort changes
  }

  // Handle sort order change
  const handleSortOrderChange = (order: 'asc' | 'desc') => {
    setSortOrder(order)
    setCurrentPage(1) // Reset to page 1 when sort order changes
  }

  useEffect(() => {
    fetchLocations(1)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch locations when search, sort, or sort order changes
  useEffect(() => {
    fetchLocations(1)
  }, [searchTerm, sortBy, sortOrder]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleEditClick = (location: UILocation) => {
    setSelectedLocation(location)
    setIsEditModalOpen(true)
  }

  const handleDeleteClick = (location: UILocation) => {
    setLocationToDelete(location)
    setIsDeleteModalOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (locationToDelete?.id) {
      const locationId = locationToDelete.id
      
      // Close modal and clear state first
      setIsDeleteModalOpen(false)
      setLocationToDelete(null)
      
      try {
        await locationsService.delete(locationId)
        // Check if we need to go back a page if current page becomes empty
        if (locations.length === 1 && currentPage > 1) {
          setCurrentPage(currentPage - 1)
          await fetchLocations(currentPage - 1)
        } else {
          await fetchLocations(currentPage) // Refresh list
        }
        
        // Show success notification
        addNotification({
          type: 'success',
          title: 'Location Deleted',
          message: 'The location has been successfully deleted.',
        })
      } catch (err) {
        console.error('Error deleting location:', err)
        addNotification({
          type: 'error',
          title: 'Failed to Delete Location',
          message: extractErrorMessage(err),
        })
      }
    }
  }

  const handleCreateLocation = async (locationData: {
    name: string
    address: string
    city: string
    state: string
    zipCode: string
    latitude: string
    longitude: string
  }) => {
    try {
      const formData: LocationFormData = {
        name: locationData.name,
        address: locationData.address,
        city: locationData.city,
        state: locationData.state,
        zipCode: locationData.zipCode,
        location: locationData.latitude && locationData.longitude
          ? [parseFloat(locationData.longitude), parseFloat(locationData.latitude)] as [number, number]
          : undefined,
      }
      
      await locationsService.create(formData)
      setCurrentPage(1)
      await fetchLocations(1) // Refresh list - reset to page 1 after creating
      
      // Show success notification
      addNotification({
        type: 'success',
        title: 'Location Created',
        message: 'The location has been successfully created.',
      })
      
      setIsModalOpen(false)
    } catch (err) {
      console.error('Error creating location:', err)
      
      // Extract error message from Appwrite error
      const errorMessage = extractErrorMessage(err)
      
      // Show error notification with actual error message
      addNotification({
        type: 'error',
        title: 'Failed to Create Location',
        message: errorMessage,
      })
      
      // Re-throw error so modal can handle it (keep modal open)
      throw err
    }
  }

  const handleUpdateLocation = async (locationData: {
    name: string
    address: string
    city: string
    state: string
    zipCode: string
    latitude: string
    longitude: string
  }) => {
    if (!selectedLocation?.id) return

    try {
      const formData: Partial<LocationFormData> = {
        name: locationData.name,
        address: locationData.address,
        city: locationData.city,
        state: locationData.state,
        zipCode: locationData.zipCode,
        location: locationData.latitude && locationData.longitude
          ? [parseFloat(locationData.longitude), parseFloat(locationData.latitude)] as [number, number]
          : undefined,
      }
      
      await locationsService.update(selectedLocation.id, formData)

      const locPoint =
        locationData.latitude && locationData.longitude
          ? ([parseFloat(locationData.longitude), parseFloat(locationData.latitude)] as [number, number])
          : null

      await eventsService.updateDenormalizedFieldsForLinkedLocation(selectedLocation.id, {
        locationName: locationData.name,
        address: locationData.address,
        city: locationData.city,
        state: locationData.state,
        zipCode: locationData.zipCode,
        location: locPoint,
      })

      await fetchLocations(currentPage) // Refresh list - keep current page
      
      // Show success notification
      addNotification({
        type: 'success',
        title: 'Location Updated',
        message: 'The location has been successfully updated.',
      })
      
      setIsEditModalOpen(false)
      setSelectedLocation(null)
    } catch (err) {
      console.error('Error updating location:', err)
      addNotification({
        type: 'error',
        title: 'Failed to Update Location',
        message: extractErrorMessage(err),
      })
    }
  }

  return (
    <DashboardLayout>
      <div className="p-8">
        <LocationsHeader
          onAddLocation={() => setIsModalOpen(true)}
          onBulkImport={() => setIsImportModalOpen(true)}
        />
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 text-red-500 hover:text-red-700"
            >
              ×
            </button>
          </div>
        )}
        <SearchAndFilter
          searchTerm={searchTerm}
          onSearchChange={handleSearchChange}
          sortBy={sortBy}
          onSortByChange={handleSortByChange}
          sortOrder={sortOrder}
          onSortOrderChange={handleSortOrderChange}
        />
        <LocationsTable
          locations={locations}
          isLoading={isLoading}
          searchTerm={searchTerm}
          currentPage={currentPage}
          totalPages={totalPages}
          totalLocations={totalLocations}
          pageSize={pageSize}
          onPageChange={handlePageChange}
          onEditClick={handleEditClick}
          onDeleteClick={handleDeleteClick}
        />
      </div>

      {/* Add Location Modal */}
      <AddLocationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleCreateLocation}
      />

      {/* Edit Location Modal */}
      <EditLocationModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setSelectedLocation(null)
        }}
        onSave={handleUpdateLocation}
        initialData={
          selectedLocation
            ? {
                name: selectedLocation.name,
                address: selectedLocation.address,
                city: selectedLocation.city,
                state: selectedLocation.state,
                zipCode: selectedLocation.zipCode,
                latitude: selectedLocation.location ? selectedLocation.location[1].toString() : '',
                longitude: selectedLocation.location ? selectedLocation.location[0].toString() : '',
              }
            : undefined
        }
      />

      {/* Bulk Import Locations Modal */}
      <ImportLocationsModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImported={async () => {
          setCurrentPage(1)
          await fetchLocations(1)
        }}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false)
          setLocationToDelete(null)
        }}
        onConfirm={handleConfirmDelete}
        type="delete"
        itemName={locationToDelete?.name ? `"${locationToDelete.name}"` : 'location'}
      />
    </DashboardLayout>
  )
}

export default Locations
