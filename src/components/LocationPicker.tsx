import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet'
import { Icon } from '@iconify/react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import AddressAutocomplete from './AddressAutocomplete'
import { GOOGLE_MAPS_API_KEY } from '../lib/googleMapsKey'

// Fix for default marker icon in react-leaflet
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
})

interface AddressComponents {
  address: string
  city: string
  state: string
  zipCode: string
}

interface LocationPickerProps {
  latitude: string
  longitude: string
  onLocationChange: (lat: string, lng: string) => void
  onAddressFromCoords?: (components: AddressComponents) => void
  address?: string
  city?: string
  state?: string
  zipCode?: string
  onCityChange?: (city: string) => void
  onStateChange?: (state: string) => void
  onZipCodeChange?: (zipCode: string) => void
  onAddressChange?: (address: string) => void
}

// Component to handle map clicks and update position
function LocationMarker({ 
  position, 
  setPosition,
  onManualMove
}: { 
  position: [number, number] | null
  setPosition: (pos: [number, number]) => void
  onManualMove?: (pos: [number, number]) => void 
}) {
  useMapEvents({
    click(e) {
      const newPos: [number, number] = [e.latlng.lat, e.latlng.lng]
      setPosition(newPos)
      if (onManualMove) {
        onManualMove(newPos)
      }
    },
  })

  return position ? <Marker position={position} /> : null
}

// Component to update map view when position or default center changes
function MapUpdater({ position, defaultCenter }: { position: [number, number] | null, defaultCenter: [number, number] }) {
  const map = useMap()
  
  useEffect(() => {
    if (position) {
      map.setView(position, map.getZoom())
    }
  }, [position, map])

  // Update map when default center changes
  useEffect(() => {
    if (!position && defaultCenter) {
      map.setView(defaultCenter, 13)
    }
  }, [defaultCenter, map, position])
  
  return null
}

const LocationPicker = ({ 
  latitude, 
  longitude, 
  onLocationChange, 
  onAddressFromCoords, 
  address,
  city,
  state,
  zipCode,
  onCityChange,
  onStateChange,
  onZipCodeChange,
  onAddressChange,
}: LocationPickerProps) => {
  const [position, setPosition] = useState<[number, number] | null>(null)
  const [isReverseGeocoding, setIsReverseGeocoding] = useState(false)
  const [addressMismatchWarning, setAddressMismatchWarning] = useState<string | null>(null)
  const [originalAddressCoords, setOriginalAddressCoords] = useState<[number, number] | null>(null)
  const mapRef = useRef<L.Map | null>(null)

  // Default center - use world center (no geolocation)
  const [defaultCenter] = useState<[number, number]>([40.7128, -74.0060]) // Default to New York City

  // Reverse geocode coordinates to get address using Google Geocoding API
  const reverseGeocode = async (lat: number, lng: number): Promise<AddressComponents | null> => {
    // Validate coordinates before making API call
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.error('Invalid coordinates:', { lat, lng })
      return null
    }
    
    try {
      setIsReverseGeocoding(true)
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`
      )
      const data = await response.json()

      console.log('=== Reverse Geocode API Response ===')
      console.log('Status:', data.status)
      console.log('Results:', data.results)
      
      if (data.status === 'OK' && data.results.length > 0) {
        const components: AddressComponents = {
          address: '',
          city: '',
          state: '',
          zipCode: '',
        }

        // Helper to check if string is a Plus Code
        const isPlusCode = (str: string): boolean => /^[A-Z0-9]{4}\+[A-Z0-9]{2,}/.test(str)

        // Find the best result (one with street address, not Plus Code)
        let bestResult = data.results[0]
        for (const result of data.results) {
          const formatted = result.formatted_address || ''
          // Prefer results that don't start with Plus Code and have more address components
          if (!isPlusCode(formatted.split(',')[0]) && result.address_components?.length >= 4) {
            bestResult = result
            break
          }
        }
        
        console.log('Best result:', bestResult)

        let streetNumber = ''
        let route = ''
        let sublocality = ''
        let locality = ''
        let adminArea1 = ''
        let country = ''

        // Parse all address components
        bestResult.address_components?.forEach((component: { types: string[]; long_name: string; short_name: string }) => {
          const types = component.types

          if (types.includes('street_number')) {
            streetNumber = component.long_name
          }
          if (types.includes('route')) {
            route = component.long_name
          }
          if (types.includes('sublocality') || types.includes('sublocality_level_1')) {
            sublocality = component.long_name
          }
          if (types.includes('locality')) {
            locality = component.long_name
          }
          if (types.includes('administrative_area_level_1')) {
            adminArea1 = component.long_name
          }
          if (types.includes('country')) {
            country = component.long_name
          }
          if (types.includes('postal_code')) {
            components.zipCode = component.long_name
          }
        })

        // Smart mapping based on available data:
        // If locality exists (like USA cities): City = locality, State = admin_area_level_1
        // If no locality (international): City = admin_area_level_1, State = country
        if (locality) {
          components.city = locality
          components.state = adminArea1 || country
        } else {
          components.city = adminArea1 || sublocality
          components.state = country
        }
        
        // Build address - prefer street address, fallback to first part of formatted address
        if (streetNumber && route) {
          components.address = `${streetNumber} ${route}`
        } else if (route) {
          components.address = route
        } else if (bestResult.formatted_address) {
          // Use first part of formatted address (street part only)
          const parts = bestResult.formatted_address.split(',').map((p: string) => p.trim())
          
          // Remove Plus Code from beginning if present
          if (parts.length > 0 && isPlusCode(parts[0])) {
            parts.shift()
          }
          
          // Use only the first part (street address)
          if (parts.length > 0) {
            components.address = parts[0]
          }
        }

        // If still no zip code, try to find it in other results
        if (!components.zipCode) {
          for (const result of data.results) {
            const postalComponent = result.address_components?.find(
              (c: { types: string[] }) => c.types.includes('postal_code')
            )
            if (postalComponent) {
              components.zipCode = postalComponent.long_name
              break
            }
          }
        }

        // If still no zip code, try a separate API call specifically for postal code
        if (!components.zipCode) {
          // Validate coordinates again before second API call
          if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return components
          }
          
          try {
            const postalResponse = await fetch(
              `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=postal_code&key=${GOOGLE_MAPS_API_KEY}`
            )
            const postalData = await postalResponse.json()
            console.log('Postal code specific API response:', postalData)
            
            if (postalData.status === 'OK' && postalData.results.length > 0) {
              const postalResult = postalData.results[0]
              const postalComponent = postalResult.address_components?.find(
                (c: { types: string[] }) => c.types.includes('postal_code')
              )
              if (postalComponent) {
                components.zipCode = postalComponent.long_name
                console.log('Found postal code from secondary request:', components.zipCode)
              }
            }
          } catch (postalError) {
            console.log('Could not fetch postal code:', postalError)
          }
        }

        console.log('Final components:', components)
        return components
      }
      return null
    } catch (error) {
      console.error('Reverse geocoding error:', error)
      return null
    } finally {
      setIsReverseGeocoding(false)
    }
  }

  // Initialize position from props
  useEffect(() => {
    if (latitude && longitude) {
      const lat = parseFloat(latitude)
      const lng = parseFloat(longitude)
      // Validate coordinates are within valid ranges before setting position
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        setPosition([lat, lng])
      } else {
        console.warn('Invalid coordinates provided to LocationPicker:', { lat, lng })
        setPosition(null)
      }
    } else {
      setPosition(null)
    }
  }, [latitude, longitude])

  // Calculate distance between two coordinates in miles
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3959 // Radius of the Earth in miles
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
    return R * c
  }

  // Handle manual map click
  const handleManualMapMove = (newPosition: [number, number]) => {
    if (originalAddressCoords) {
      const distance = calculateDistance(
        originalAddressCoords[0],
        originalAddressCoords[1],
        newPosition[0],
        newPosition[1]
      )
      
      if (distance > 0.5) { // More than 0.5 miles from original
        setAddressMismatchWarning(
          `⚠️ Pin moved ${distance.toFixed(1)} miles from the geocoded address. ` +
          `This may indicate the address was not accurately geocoded. ` +
          `Please verify the pin location matches the actual address.`
        )
      } else {
        setAddressMismatchWarning(null)
      }
    }
  }

  // Update parent when position changes
  const handlePositionChange = async (newPosition: [number, number], skipReverseGeocode = false) => {
    setPosition(newPosition)
    onLocationChange(newPosition[0].toString(), newPosition[1].toString())
    
    console.log('=== Map Location Selection ===')
    console.log('Latitude:', newPosition[0])
    console.log('Longitude:', newPosition[1])
    
    // Perform reverse geocoding to get address info
    if (!skipReverseGeocode && onAddressFromCoords) {
      const addressComponents = await reverseGeocode(newPosition[0], newPosition[1])
      if (addressComponents) {
        console.log('Reverse Geocoded Address:', addressComponents)
        console.log('Address:', addressComponents.address)
        console.log('City:', addressComponents.city)
        console.log('State:', addressComponents.state)
        console.log('Zip Code:', addressComponents.zipCode)
        console.log('==============================')
        onAddressFromCoords(addressComponents)
      }
    } else {
      console.log('==============================')
    }
  }


  return (
    <div className="space-y-3">
      {/* Address Fields - Above Map */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Address */}
        <div className="relative z-1000">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Address <span className="text-red-500">*</span>
          </label>
          <AddressAutocomplete
            value={address || ''}
            onChange={(value) => {
              onAddressChange?.(value)
              // Clear warning when address changes
              setAddressMismatchWarning(null)
            }}
            onAddressSelect={(components) => {
              if (components.latitude && components.longitude) {
                const lat = parseFloat(components.latitude)
                const lng = parseFloat(components.longitude)
                if (!isNaN(lat) && !isNaN(lng)) {
                  const newPosition: [number, number] = [lat, lng]
                  // Store original geocoded coordinates for comparison
                  setOriginalAddressCoords(newPosition)
                  setAddressMismatchWarning(null)
                  
                  // Skip reverse geocoding since we already have address data from autocomplete
                  handlePositionChange(newPosition, true)
                  
                  // Pass address components to parent
                  if (onAddressFromCoords) {
                    onAddressFromCoords({
                      address: components.address,
                      city: components.city,
                      state: components.state,
                      zipCode: components.zipCode,
                    })
                  }
                }
              }
            }}
            placeholder="Enter Address"
            required
          />
        </div>

        {/* City */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            City <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            placeholder="Enter City"
            value={city || ''}
            onChange={(e) => onCityChange?.(e.target.value)}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>

        {/* State */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            State <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            placeholder="Enter State"
            value={state || ''}
            onChange={(e) => onStateChange?.(e.target.value)}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>

        {/* ZIP Code */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            ZIP Code
          </label>
          <input
            type="text"
            placeholder="Enter ZIP Code"
            value={zipCode || ''}
            onChange={(e) => onZipCodeChange?.(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent"
          />
        </div>
      </div>


      {/* Map - lower z-index for controls */}
      <style>{`
        .leaflet-control-container {
          z-index: 100 !important;
        }
        .leaflet-top, .leaflet-bottom {
          z-index: 100 !important;
        }
      `}</style>
      <div className="border border-gray-300 rounded-lg overflow-hidden relative z-0">
        <MapContainer
          center={position || defaultCenter}
          zoom={13}
          style={{ height: '400px', width: '100%' }}
          ref={mapRef}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <LocationMarker 
            position={position} 
            setPosition={handlePositionChange}
            onManualMove={(pos) => {
              handleManualMapMove(pos)
              handlePositionChange(pos)
            }}
          />
          <MapUpdater position={position} defaultCenter={defaultCenter} />
        </MapContainer>
      </div>

      {/* Address Mismatch Warning */}
      {addressMismatchWarning && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <Icon icon="mdi:alert" className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">{addressMismatchWarning}</p>
          </div>
        </div>
      )}

      {/* Coordinates Display */}
      {position && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm">
            <Icon icon="mdi:map-marker" className="w-5 h-5 text-blue-600" />
            <span className="text-blue-800 font-medium">
              Selected Location: 
            </span>
            <span className="text-blue-700">
              {position[0].toFixed(6)}, {position[1].toFixed(6)}
            </span>
            {isReverseGeocoding && (
              <span className="flex items-center gap-1 text-blue-600">
                <Icon icon="mdi:loading" className="w-4 h-4 animate-spin" />
                Finding address...
              </span>
            )}
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
        <div className="flex items-start justify-between">
          <p className="text-sm text-gray-700">
            <Icon icon="mdi:information" className="inline w-4 h-4 mr-1" />
            Click anywhere on the map to set the event location, or search for an address above.
          </p>
          {position && address && (
            <button
              type="button"
              onClick={async () => {
                if (position) {
                  const addressComponents = await reverseGeocode(position[0], position[1])
                  if (addressComponents) {
                    console.log('Verification check:')
                    console.log('Expected address:', address)
                    console.log('Actual location address:', addressComponents.address)
                    console.log('Distance check needed between these addresses')
                  }
                }
              }}
              className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
            >
              <Icon icon="mdi:map-check" className="inline w-3 h-3 mr-1" />
              Verify Location
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default LocationPicker
