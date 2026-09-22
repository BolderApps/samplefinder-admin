import { useState, useEffect, useRef, useCallback } from 'react'
import { Icon } from '@iconify/react'
import { GOOGLE_MAPS_API_KEY } from '../lib/googleMapsKey'

// Declare Google Maps types on window
declare global {
  interface Window {
    google?: {
      maps?: {
        places?: {
          AutocompleteService: new () => GoogleAutocompleteService
          PlacesService: new (div: HTMLDivElement) => GooglePlacesService
          PlacesServiceStatus: {
            OK: string
          }
        }
      }
    }
  }
}

interface GoogleAutocompleteService {
  getPlacePredictions: (
    request: { input: string; componentRestrictions?: { country: string }; types?: string[] },
    callback: (results: Prediction[] | null, status: string) => void
  ) => void
}

// Place name (main_text) suitable for an establishment selection — e.g.
// "Lincoln Financial Field" or "Giant".
type AddressComponents = {
  address: string
  city: string
  state: string
  zipCode: string
  latitude: string
  longitude: string
  name?: string
}

interface GooglePlacesService {
  getDetails: (
    request: { placeId: string; fields: string[] },
    callback: (place: GooglePlaceResult | null, status: string) => void
  ) => void
}

interface GooglePlaceResult {
  address_components?: Array<{
    types: string[]
    long_name: string
    short_name: string
  }>
  geometry?: {
    location: {
      lat: () => number
      lng: () => number
    }
  }
  formatted_address?: string
  name?: string
}

interface AddressAutocompleteProps {
  value: string
  onChange: (value: string) => void
  onAddressSelect: (components: AddressComponents) => void
  placeholder?: string
  required?: boolean
  className?: string
  // After a prediction is selected, what should the input's value become?
  // 'address' (default) — the parsed street address (existing behavior).
  // 'name' — the place's main_text (e.g., "Giant", "Lincoln Financial Field").
  // Use 'name' when this autocomplete is driving a Location Name / Store Name field.
  valueOnSelect?: 'address' | 'name'
}

interface Prediction {
  place_id: string
  description: string
  structured_formatting: {
    main_text: string
    secondary_text: string
  }
}

// Load Google Maps Script
const loadGoogleMapsScript = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.places) {
      resolve()
      return
    }

    const existingScript = document.getElementById('google-maps-script')
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve())
      return
    }

    const script = document.createElement('script')
    script.id = 'google-maps-script'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Maps script'))
    document.head.appendChild(script)
  })
}

const AddressAutocomplete = ({
  value,
  onChange,
  onAddressSelect,
  placeholder = 'Enter address, place, or zip code...',
  required = false,
  className = '',
  valueOnSelect = 'address',
}: AddressAutocompleteProps) => {
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isScriptLoaded, setIsScriptLoaded] = useState(false)
  const [error, setError] = useState('')
  
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const autocompleteServiceRef = useRef<GoogleAutocompleteService | null>(null)
  const placesServiceRef = useRef<GooglePlacesService | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load Google Maps script
  useEffect(() => {
    loadGoogleMapsScript()
      .then(() => {
        setIsScriptLoaded(true)
        if (window.google?.maps?.places) {
          autocompleteServiceRef.current = new window.google.maps.places.AutocompleteService()
          // Create a dummy div for PlacesService (required)
          const dummyDiv = document.createElement('div')
          placesServiceRef.current = new window.google.maps.places.PlacesService(dummyDiv)
        }
      })
      .catch((err) => {
        console.error('Error loading Google Maps:', err)
        setError('Failed to load address search')
      })
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Fetch predictions
  const fetchPredictions = useCallback((input: string) => {
    if (!autocompleteServiceRef.current || !input.trim()) {
      setPredictions([])
      return
    }

    setIsLoading(true)
    // Omit `types` so predictions include both addresses AND establishments
    // (e.g. "Giant Aston PA", "Lincoln Financial Field"). Restricting to
    // ['geocode'] would hide business/place results, which the customer
    // explicitly wants for SAM-518.
    autocompleteServiceRef.current.getPlacePredictions(
      {
        input,
      },
      (results: Prediction[] | null, status: string) => {
        setIsLoading(false)
        if (status === window.google?.maps?.places?.PlacesServiceStatus?.OK && results) {
          setPredictions(results)
          setIsOpen(true)
        } else {
          setPredictions([])
        }
      }
    )
  }, [])

  // Handle input change with debounce
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    onChange(newValue)

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (newValue.trim().length >= 2) {
      debounceTimerRef.current = setTimeout(() => {
        fetchPredictions(newValue)
      }, 300)
    } else {
      setPredictions([])
      setIsOpen(false)
    }
  }

  // Parse address components from place details
  const parseAddressComponents = (
    place: GooglePlaceResult
  ): AddressComponents => {
    const components: AddressComponents = {
      address: '',
      city: '',
      state: '',
      zipCode: '',
      latitude: '',
      longitude: '',
    }

    if (place.geometry?.location) {
      const lat = place.geometry.location.lat()
      const lng = place.geometry.location.lng()
      
      // Validate coordinates are within valid ranges
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.error('Invalid coordinates from Google Places:', { lat, lng })
      }
      
      components.latitude = lat.toString()
      components.longitude = lng.toString()
      
      // Log for debugging
      console.log('Google Places coordinates:', {
        lat,
        lng,
        address: place.formatted_address
      })
    }

    let streetNumber = ''
    let route = ''
    let sublocality = ''
    let locality = ''
    let adminArea1 = ''
    let country = ''

    place.address_components?.forEach((component: { types: string[]; long_name: string; short_name: string }) => {
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
    } else if (place.formatted_address) {
      // Use first part of formatted address (street part only)
      const parts = place.formatted_address.split(',').map((p: string) => p.trim())
      
      // Remove Plus Code from beginning if present
      if (parts.length > 0 && /^[A-Z0-9]{4}\+[A-Z0-9]{2,}/.test(parts[0])) {
        parts.shift()
      }
      
      // Use only the first part (street address)
      if (parts.length > 0) {
        components.address = parts[0]
      }
    }

    return components
  }

  // Check if string looks like a Plus Code (e.g., "8GXX+PH")
  const isPlusCode = (str: string): boolean => {
    return /^[A-Z0-9]{4}\+[A-Z0-9]{2,}/.test(str)
  }

  // Handle prediction selection
  const handleSelect = (prediction: Prediction) => {
    if (!placesServiceRef.current) return

    setIsLoading(true)
    placesServiceRef.current.getDetails(
      {
        placeId: prediction.place_id,
        fields: ['address_components', 'geometry', 'formatted_address', 'name'],
      },
      (place: GooglePlaceResult | null, status: string) => {
        setIsLoading(false)
        if (status === window.google?.maps?.places?.PlacesServiceStatus?.OK && place) {
          const components = parseAddressComponents(place)

          // Use the original prediction text if parsed address is a Plus Code or empty
          let displayAddress = components.address
          if (!displayAddress || isPlusCode(displayAddress)) {
            // Use the full description from prediction (e.g., "North Hollywood, CA 91607, USA")
            displayAddress = prediction.description.split(',')[0]
          }

          // Place / establishment name — falls back to prediction main_text.
          const placeName = place.name || prediction.structured_formatting.main_text

          const finalComponents: AddressComponents = {
            ...components,
            address: displayAddress,
            name: placeName,
          }

          // Drive the input value based on caller intent. Address fields
          // want the street address; Location Name / Store Name fields
          // want the establishment name.
          const nextValue = valueOnSelect === 'name' ? placeName : displayAddress

          onChange(nextValue)
          onAddressSelect(finalComponents)
        }
        setIsOpen(false)
        setPredictions([])
      }
    )
  }

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }

  // Clear input
  const handleClear = () => {
    onChange('')
    setPredictions([])
    setIsOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={() => predictions.length > 0 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          className={`w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74] focus:border-transparent ${className}`}
          autoComplete="off"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {isLoading && (
            <Icon icon="mdi:loading" className="w-5 h-5 text-gray-400 animate-spin" />
          )}
          {value && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <Icon icon="mdi:close" className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-500 mt-1">{error}</p>
      )}

      {/* Predictions Dropdown */}
      {isOpen && predictions.length > 0 && isScriptLoaded && (
        <div
          ref={dropdownRef}
          className="absolute z-[9999] w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {predictions.map((prediction) => (
            <button
              key={prediction.place_id}
              type="button"
              onClick={() => handleSelect(prediction)}
              className="w-full px-4 py-3 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none flex items-center gap-3"
            >
              <Icon icon="mdi:map-marker" className="w-5 h-5 text-gray-700 flex-shrink-0" />
              <span className="text-sm text-gray-900">
                <span className="font-semibold">{prediction.structured_formatting.main_text}</span>
                {prediction.structured_formatting.secondary_text && (
                  <span className="text-gray-600"> {prediction.structured_formatting.secondary_text}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default AddressAutocomplete
