import { databases, appwriteConfig, ID, Query, functions, ExecutionMethod } from './appwrite'
import type { Models } from 'appwrite'
import { DEFAULT_APP_TIMEZONE, appTimeToUTC } from './dateUtils'
import { fetchAllPages } from './paginateAll'

// Collection IDs
export const COLLECTION_IDS = {
  USER_PROFILES: 'user_profiles',
  CLIENTS: 'clients',
  CATEGORIES: 'categories',
  EVENTS: 'events',
  NOTIFICATIONS: 'notifications',
  TRIVIA: 'trivia',
  TRIVIA_RESPONSES: 'trivia_responses',
  REVIEWS: 'reviews',
  CHECKINS: 'checkins',
  SETTINGS: 'settings',
  TIERS: 'tiers',
  LOCATIONS: 'locations',
} as const

/**
 * Short-lived cache of whole-collection reads for DatabaseService.searchAll.
 *
 * searchAll fetches every row matching `baseQueries` and then filters by the search term in the
 * browser. The term is not part of the server query, so typing re-read the entire collection once
 * per character — and the Locations, Categories, Trivia and Clients pages refetch on every keystroke
 * with no debounce. Each of those reads costs a ~0.5s round trip, so a six-letter search spent
 * several seconds re-fetching identical rows.
 *
 * Entries are keyed by collection + baseQueries, expire quickly, and are dropped outright whenever
 * a document in that collection is created, updated or deleted, so a stale list cannot outlive an
 * edit made from the admin panel.
 */
const SEARCH_ALL_CACHE_TTL_MS = 30_000
const searchAllCache = new Map<string, { documents: Models.Document[]; at: number }>()

const searchAllCacheKey = (collectionId: string, baseQueries: string[]) =>
  `${collectionId}::${JSON.stringify(baseQueries)}`

/**
 * Drop every cached full read for a collection. Called automatically on any write through
 * DatabaseService, and exported for writes that happen server-side in a Function (which never touch
 * DatabaseService and so cannot self-invalidate).
 */
export function invalidateSearchAllCache(collectionId: string): void {
  for (const key of searchAllCache.keys()) {
    if (key.startsWith(`${collectionId}::`)) searchAllCache.delete(key)
  }
}

// Generic database service functions
export class DatabaseService {
  // Create a document
  static async create<T extends Models.Document>(
    collectionId: string,
    data: Omit<T, keyof Models.Document>
  ): Promise<T> {
    const created = await databases.createDocument(
      appwriteConfig.databaseId,
      collectionId,
      ID.unique(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data as any
    ) as T
    invalidateSearchAllCache(collectionId)
    return created
  }

  // Get a document by ID
  static async getById<T extends Models.Document>(
    collectionId: string,
    documentId: string
  ): Promise<T> {
    return await databases.getDocument(
      appwriteConfig.databaseId,
      collectionId,
      documentId
    ) as T
  }

  // List documents with optional queries
  static async list<T extends Models.Document>(
    collectionId: string,
    queries?: string[]
  ): Promise<Models.DocumentList<T>> {
    return await databases.listDocuments(
      appwriteConfig.databaseId,
      collectionId,
      queries
    ) as Models.DocumentList<T>
  }

  // Update a document
  static async update<T extends Models.Document>(
    collectionId: string,
    documentId: string,
    data: Partial<Omit<T, keyof Models.Document>>
  ): Promise<T> {
    const updated = await databases.updateDocument(
      appwriteConfig.databaseId,
      collectionId,
      documentId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data as any
    ) as T
    invalidateSearchAllCache(collectionId)
    return updated
  }

  // Delete a document
  static async delete(
    collectionId: string,
    documentId: string
  ): Promise<void> {
    await databases.deleteDocument(
      appwriteConfig.databaseId,
      collectionId,
      documentId
    )
    invalidateSearchAllCache(collectionId)
  }

  // Search documents (client-side filtering since full-text indexes may not be configured)
  static async search<T extends Models.Document>(
    collectionId: string,
    searchTerm: string,
    searchFields: string[],
    queries?: string[]
  ): Promise<Models.DocumentList<T>> {
    // Fetch documents with the provided queries (without search)
    const result = await this.list<T>(collectionId, queries)
    
    // If no search term, return all results
    if (!searchTerm.trim()) {
      return result
    }
    
    // Client-side filtering: match search term against any of the specified fields
    const lowerSearchTerm = searchTerm.toLowerCase().trim()
    const filteredDocuments = result.documents.filter((doc) => {
      return searchFields.some((field) => {
        const fieldValue = (doc as Record<string, unknown>)[field]
        if (typeof fieldValue === 'string') {
          return fieldValue.toLowerCase().includes(lowerSearchTerm)
        }
        return false
      })
    })
    
    return {
      total: filteredDocuments.length,
      documents: filteredDocuments,
    } as Models.DocumentList<T>
  }

  // Like search(), but pages through the ENTIRE collection (matching baseQueries) before filtering,
  // so a match is never hidden outside a capped/paginated fetch window (the root cause of the admin
  // "search only shows some results" bug). `baseQueries` should carry ordering/filters but NOT
  // limit/offset/cursor — paging is handled here. Returns the full matched set; the caller paginates.
  static async searchAll<T extends Models.Document>(
    collectionId: string,
    searchTerm: string,
    searchFields: string[],
    baseQueries: string[] = []
  ): Promise<{ documents: T[]; total: number }> {
    // Reuse the last full read of this collection when only the search term changed — see
    // searchAllCache above for why that dominated the cost of typing in a search box.
    const cacheKey = searchAllCacheKey(collectionId, baseQueries)
    const cached = searchAllCache.get(cacheKey)
    let all: T[]
    if (cached && Date.now() - cached.at < SEARCH_ALL_CACHE_TTL_MS) {
      all = cached.documents as T[]
    } else {
      all = await fetchAllPages<T>((cursor, limit) =>
        this.list<T>(collectionId, [
          ...baseQueries,
          Query.limit(limit),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ])
      )
      searchAllCache.set(cacheKey, { documents: all, at: Date.now() })
    }

    const term = searchTerm.toLowerCase().trim()
    // Copy: the array may be the cached one, and callers are free to sort their result in place.
    if (!term) return { documents: [...all], total: all.length }

    const filtered = all.filter((doc) =>
      searchFields.some((field) => {
        const value = (doc as Record<string, unknown>)[field]
        return typeof value === 'string' && value.toLowerCase().includes(term)
      })
    )
    return { documents: filtered, total: filtered.length }
  }

  // Get most recent document update time from a collection
  static async getMostRecentUpdateTime(collectionId: string): Promise<Date | null> {
    try {
      const result = await databases.listDocuments(
        appwriteConfig.databaseId,
        collectionId,
        [
          Query.orderDesc('$updatedAt'),
          Query.limit(1)
        ]
      )
      
      if (result.documents.length > 0) {
        return new Date(result.documents[0].$updatedAt)
      }
      return null
    } catch (error) {
      console.error(`Error fetching most recent update time for ${collectionId}:`, error)
      return null
    }
  }
}

// Reports metadata service
export const reportsService = {
  // Get last generated time for each report type based on source data
  getReportMetadata: async () => {
    try {
      const [
        eventsTime,
        clientsTime,
        usersTime,
        reviewsTime,
      ] = await Promise.all([
        DatabaseService.getMostRecentUpdateTime(COLLECTION_IDS.EVENTS),
        DatabaseService.getMostRecentUpdateTime(COLLECTION_IDS.CLIENTS),
        DatabaseService.getMostRecentUpdateTime(COLLECTION_IDS.USER_PROFILES),
        DatabaseService.getMostRecentUpdateTime(COLLECTION_IDS.REVIEWS),
      ])

      return {
        events: eventsTime,
        clients: clientsTime,
        users: usersTime,
        reviews: reviewsTime,
      }
    } catch (error) {
      console.error('Error fetching report metadata:', error)
      return {
        events: null,
        clients: null,
        users: null,
        reviews: null,
      }
    }
  }
}

// User Profile interface
export interface UserProfile extends Models.Document {
  authID: string
  role: string
  firstname?: string
  lastname?: string
  username?: string
  phoneNumber?: string
  dob?: string
  zipCode?: string
  isBlocked?: boolean
  idAdult?: boolean
  avatarURL?: string // User profile image URL
  // Points & stats fields (match actual database column names)
  totalPoints?: number
  totalReviews?: number
  totalEvents?: number
  isAmbassador?: boolean
  isInfluencer?: boolean
  referralCode?: string
  favoriteIds?: string | string[] // JSON string array or array of event IDs
  savedEventIds?: string // JSON string with saved event data
  // Legacy field names for backward compatibility
  userPoints?: number
  tierLevel?: string
  baBadge?: boolean
  influencerBadge?: boolean
  checkIns?: number
  reviews?: number
  triviasWon?: number
  checkInReviewPoints?: number
  [key: string]: unknown
}

/** Parse user favoriteIds (JSON string or array) to event ID array for counting favorites. */
function parseFavoriteIds(favoriteIds?: string | string[]): string[] {
  if (favoriteIds == null) return []
  if (Array.isArray(favoriteIds)) return favoriteIds.filter((id): id is string => typeof id === 'string')
  try {
    const parsed = JSON.parse(favoriteIds as string)
    return Array.isArray(parsed) ? parsed.filter((id: unknown): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

// User Profiles service
export const userProfilesService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<UserProfile>(appwriteConfig.collections.userProfiles, data),
  getById: (id: string) =>
    DatabaseService.getById<UserProfile>(appwriteConfig.collections.userProfiles, id),
  list: (queries?: string[]) =>
    DatabaseService.list<UserProfile>(appwriteConfig.collections.userProfiles, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<UserProfile>(appwriteConfig.collections.userProfiles, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.userProfiles, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<UserProfile>(
      appwriteConfig.collections.userProfiles,
      searchTerm,
      ['firstname', 'lastname', 'username', 'phoneNumber'],
      queries
    ),
  findByAuthID: async (authID: string): Promise<UserProfile | null> => {
    const result = await DatabaseService.list<UserProfile>(
      appwriteConfig.collections.userProfiles,
      [Query.equal('authID', [authID])]
    )
    return result.documents[0] || null
  },
}

// Client Document interface
export interface ClientDocument extends Models.Document {
  name: string
  logoURL?: string
  productType?: string[]
  [key: string]: unknown
}

// Client interface (for UI)
export type Client = ClientDocument

// Client Form Data interface
export interface ClientFormData {
  name: string
  logoURL?: string
  productType?: string[]
  description?: string
}

// Clients service
export const clientsService = {
  create: (data: ClientFormData) => {
    const dbData: Record<string, unknown> = {
      name: data.name,
      logoURL: data.logoURL || null,
      productType: data.productType || [],
      description: data.description || null,
    }

    return DatabaseService.create<ClientDocument>(appwriteConfig.collections.clients, dbData)
  },
  getById: (id: string) =>
    DatabaseService.getById<ClientDocument>(appwriteConfig.collections.clients, id),
  list: (queries?: string[]) =>
    DatabaseService.list<ClientDocument>(appwriteConfig.collections.clients, queries),
  listAll: async (): Promise<ClientDocument[]> => {
    const PAGE_SIZE = 500
    const allClients: ClientDocument[] = []
    let offset = 0

    for (;;) {
      const page = await DatabaseService.list<ClientDocument>(
        appwriteConfig.collections.clients,
        [Query.limit(PAGE_SIZE), Query.offset(offset)]
      )
      allClients.push(...page.documents)
      if (page.documents.length < PAGE_SIZE) {
        break
      }
      offset += PAGE_SIZE
    }

    return allClients
  },
  /**
   * Resolve many clients by ID in as few requests as possible.
   *
   * This used to issue one getDocument per ID, so rendering the events list — which resolves a brand
   * name for every visible event — fired one request per distinct client. A single
   * Query.equal('$id', [...]) returns the whole batch in one round trip instead, which matters
   * because each round trip to Appwrite Cloud costs ~0.5s regardless of how little it returns.
   *
   * Missing IDs are simply absent from the returned map, as before.
   */
  getByIds: async (ids: string[]): Promise<Map<string, ClientDocument>> => {
    const clientsMap = new Map<string, ClientDocument>()
    if (ids.length === 0) return clientsMap

    // Appwrite rejects an equality query carrying more than 500 values; chunk well below that.
    const CHUNK_SIZE = 100
    const unique = [...new Set(ids)]

    try {
      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const chunk = unique.slice(i, i + CHUNK_SIZE)
        const page = await DatabaseService.list<ClientDocument>(
          appwriteConfig.collections.clients,
          [Query.equal('$id', chunk), Query.limit(chunk.length)]
        )
        for (const client of page.documents) {
          clientsMap.set(client.$id, client)
        }
      }
    } catch (err) {
      console.error('Error fetching clients batch:', err)
    }

    return clientsMap
  },
  update: (id: string, data: Partial<ClientFormData>) => {
    const dbData: Record<string, unknown> = {
      ...data,
    }

    return DatabaseService.update<ClientDocument>(appwriteConfig.collections.clients, id, dbData)
  },
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.clients, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<ClientDocument>(
      appwriteConfig.collections.clients,
      searchTerm,
      ['name'],
      queries
    ),
  findByName: async (name: string): Promise<ClientDocument | null> => {
    const result = await DatabaseService.list<ClientDocument>(
      appwriteConfig.collections.clients,
      [Query.equal('name', [name])]
    )
    return result.documents[0] || null
  },
  
  // Compute stats for a single client
  getClientStats: async (clientId: string): Promise<{
    totalEvents: number
    totalFavorites: number
    totalCheckIns: number
    totalPoints: number
  }> => {
    try {
      // 1. Get all events for this client
      const eventsResult = await DatabaseService.list<EventDocument>(
        appwriteConfig.collections.events,
        [Query.equal('client', [clientId]), Query.limit(1000)]
      )
      const events = eventsResult.documents
      const totalEvents = eventsResult.total
      const eventIds = events.map(e => e.$id)
      
      let totalCheckIns = 0
      let totalPoints = 0
      if (eventIds.length > 0) {
        const chunkSize = 100
        for (let i = 0; i < eventIds.length; i += chunkSize) {
          const chunk = eventIds.slice(i, i + chunkSize)
          const reviewsResult = await DatabaseService.list<ReviewDocument>(
            appwriteConfig.collections.reviews,
            [Query.equal('event', chunk), Query.limit(1000)]
          )
          totalCheckIns += reviewsResult.total
          totalPoints += reviewsResult.documents.reduce((sum, r) => sum + (r.pointsEarned || 0), 0)
        }
      }

      // 3. Count favorites from all users' favoriteIds arrays (paginate so we don't miss anyone)
      let totalFavorites = 0
      const userPageSize = 500
      let userOffset = 0
      let userChunk: UserProfile[]
      do {
        const usersResult = await DatabaseService.list<UserProfile>(
          appwriteConfig.collections.userProfiles,
          [Query.limit(userPageSize), Query.offset(userOffset)]
        )
        userChunk = usersResult.documents ?? []
        const eventIdSet = new Set(eventIds)
        for (const user of userChunk) {
          const ids = parseFavoriteIds(user.favoriteIds)
          for (const favId of ids) {
            if (eventIdSet.has(favId) || favId === clientId) totalFavorites++
          }
        }
        userOffset += userPageSize
      } while (userChunk.length === userPageSize)
      
      return { totalEvents, totalFavorites, totalCheckIns, totalPoints }
    } catch (err) {
      console.error('Error computing client stats:', err)
      return { totalEvents: 0, totalFavorites: 0, totalCheckIns: 0, totalPoints: 0 }
    }
  },
  
  // Compute stats for multiple clients (batch operation)
  getClientsStats: async (clientIds: string[]): Promise<Map<string, {
    totalEvents: number
    totalFavorites: number
    totalCheckIns: number
    totalPoints: number
  }>> => {
    const statsMap = new Map<string, { totalEvents: number; totalFavorites: number; totalCheckIns: number; totalPoints: number }>()
    
    if (clientIds.length === 0) return statsMap
    
    try {
      // 1. Get all events for all clients (chunk clientIds to stay under Appwrite's 100-value limit per query)
      const eventsByClient = new Map<string, EventDocument[]>()
      const allEventIds: string[] = []
      const CLIENT_IDS_CHUNK = 100

      for (let i = 0; i < clientIds.length; i += CLIENT_IDS_CHUNK) {
        const chunk = clientIds.slice(i, i + CLIENT_IDS_CHUNK)
        const eventsResult = await DatabaseService.list<EventDocument>(
          appwriteConfig.collections.events,
          [Query.equal('client', chunk), Query.limit(5000)]
        )
        for (const event of eventsResult.documents) {
          const clientId = event.client as string
          if (clientId) {
            if (!eventsByClient.has(clientId)) {
              eventsByClient.set(clientId, [])
            }
            eventsByClient.get(clientId)!.push(event)
            allEventIds.push(event.$id)
          }
        }
      }
      
      // 2. Get all reviews for all events
      const reviewsByEvent = new Map<string, ReviewDocument[]>()
      if (allEventIds.length > 0) {
        const chunkSize = 100
        for (let i = 0; i < allEventIds.length; i += chunkSize) {
          const chunk = allEventIds.slice(i, i + chunkSize)
          const reviewsResult = await DatabaseService.list<ReviewDocument>(
            appwriteConfig.collections.reviews,
            [Query.equal('event', chunk), Query.limit(5000)]
          )
          for (const review of reviewsResult.documents) {
            const eventId = review.event as string
            if (eventId) {
              if (!reviewsByEvent.has(eventId)) {
                reviewsByEvent.set(eventId, [])
              }
              reviewsByEvent.get(eventId)!.push(review)
            }
          }
        }
      }
      
      // 3. Fetch ALL users in pages so we don't miss anyone (favorites count from favoriteIds)
      const allUsers: UserProfile[] = []
      const USER_PAGE_SIZE = 500
      let userOffset = 0
      let userChunk: UserProfile[]
      do {
        const userResult = await DatabaseService.list<UserProfile>(
          appwriteConfig.collections.userProfiles,
          [Query.limit(USER_PAGE_SIZE), Query.offset(userOffset)]
        )
        userChunk = userResult.documents ?? []
        allUsers.push(...userChunk)
        userOffset += USER_PAGE_SIZE
      } while (userChunk.length === USER_PAGE_SIZE)

      // 4. Compute stats for each client
      for (const clientId of clientIds) {
        const clientEvents = eventsByClient.get(clientId) || []
        const clientEventIds = clientEvents.map(e => e.$id)

        let totalCheckIns = 0
        let totalPoints = 0

        for (const eventId of clientEventIds) {
          const eventReviews = reviewsByEvent.get(eventId) || []
          totalCheckIns += eventReviews.length
          totalPoints += eventReviews.reduce((sum, r) => sum + (r.pointsEarned || 0), 0)
        }

        // Favorites count from users' favoriteIds: event IDs that belong to this client, or the client ID itself
        let totalFavorites = 0
        const clientEventIdSet = new Set(clientEventIds)
        for (const user of allUsers) {
          const ids = parseFavoriteIds(user.favoriteIds)
          for (const favId of ids) {
            if (clientEventIdSet.has(favId) || favId === clientId) totalFavorites++
          }
        }

        statsMap.set(clientId, {
          totalEvents: clientEvents.length,
          totalFavorites,
          totalCheckIns,
          totalPoints,
        })
      }
      
      return statsMap
    } catch (err) {
      console.error('Error computing clients stats batch:', err)
      return statsMap
    }
  },
}

// Event Document interface
export interface EventDocument extends Models.Document {
  name: string
  date: string
  startTime: string
  endTime: string
  city: string
  address: string
  state: string
  zipCode: string
  products?: string[]
  discount?: string
  discountImageURL?: string
  checkInCode: string
  checkInPoints: number
  reviewPoints: number
  eventInfo: string
  brandDescription?: string // Brand description text field
  isArchived: boolean
  isHidden: boolean
  radius?: number
  location?: [number, number] // [longitude, latitude]
  /** Display name of the venue/location (denormalized for mobile and API consumers). */
  locationName?: string
  locationId?: string // Location document ID (relationship) - used when event is linked to a Location
  client?: string // Client ID (relationship)
  categories?: string // Category ID (relationship)
  timezone?: string // IANA timezone used when creating/editing the event
  [key: string]: unknown
}

// Events service
export const eventsService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<EventDocument>(appwriteConfig.collections.events, data),
  getById: (id: string) =>
    DatabaseService.getById<EventDocument>(appwriteConfig.collections.events, id),
  list: (queries?: string[]) =>
    DatabaseService.list<EventDocument>(appwriteConfig.collections.events, queries),
  /**
   * Every event, paged. `list()` with no queries returns Appwrite's default page
   * of 25, which silently hides most events from any client-side picker.
   */
  listAll: async (): Promise<EventDocument[]> => {
    const PAGE_SIZE = 500
    const allEvents: EventDocument[] = []
    let offset = 0

    for (;;) {
      const page = await DatabaseService.list<EventDocument>(
        appwriteConfig.collections.events,
        [Query.limit(PAGE_SIZE), Query.offset(offset)]
      )
      allEvents.push(...page.documents)
      if (page.documents.length < PAGE_SIZE) {
        break
      }
      offset += PAGE_SIZE
    }

    return allEvents
  },
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<EventDocument>(appwriteConfig.collections.events, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.events, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<EventDocument>(
      appwriteConfig.collections.events,
      searchTerm,
      ['name', 'city', 'address', 'state', 'locationName'],
      queries
    ),

  /** Push saved Location fields onto every event linked via `locationId` (denormalized copy on the event). */
  updateDenormalizedFieldsForLinkedLocation: async (
    locationId: string,
    fields: {
      locationName: string
      address: string
      city: string
      state: string
      zipCode: string
      location?: [number, number] | null
    }
  ): Promise<void> => {
    if (!appwriteConfig.eventsHasLocationIdAttribute) {
      return
    }
    const batchSize = 100
    let offset = 0
    for (;;) {
      const result = await DatabaseService.list<EventDocument>(
        appwriteConfig.collections.events,
        [
          Query.equal('locationId', [locationId]),
          Query.limit(batchSize),
          Query.offset(offset),
        ]
      )
      const patch: Record<string, unknown> = {
        locationName: fields.locationName,
        address: fields.address,
        city: fields.city,
        state: fields.state,
        zipCode: fields.zipCode,
      }
      if (fields.location !== undefined) {
        patch.location = fields.location
      }
      await Promise.all(
        result.documents.map((doc) =>
          DatabaseService.update<EventDocument>(
            appwriteConfig.collections.events,
            doc.$id,
            patch
          )
        )
      )
      if (result.documents.length < batchSize) break
      offset += batchSize
    }
  },
}

// Category Document interface
export interface CategoryDocument extends Models.Document {
  title: string
  isAdult?: boolean
  [key: string]: unknown
}

// Categories service
export const categoriesService = {
  create: (data: { title: string; isAdult?: boolean }) =>
    DatabaseService.create<CategoryDocument>(appwriteConfig.collections.categories || 'categories', data),
  getById: (id: string) =>
    DatabaseService.getById<CategoryDocument>(appwriteConfig.collections.categories || 'categories', id),
  list: (queries?: string[]) =>
    DatabaseService.list<CategoryDocument>(appwriteConfig.collections.categories || 'categories', queries),
  update: (id: string, data: { title: string; isAdult?: boolean }) =>
    DatabaseService.update<CategoryDocument>(appwriteConfig.collections.categories || 'categories', id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.categories || 'categories', id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<CategoryDocument>(
      appwriteConfig.collections.categories || 'categories',
      searchTerm,
      ['title'],
      queries
    ),
  // Full-collection search (see DatabaseService.searchAll) — pass ordering in baseQueries, no limit/offset.
  searchAll: (searchTerm: string, baseQueries?: string[]) =>
    DatabaseService.searchAll<CategoryDocument>(
      appwriteConfig.collections.categories || 'categories',
      searchTerm,
      ['title'],
      baseQueries
    ),
  findByTitle: async (title: string): Promise<CategoryDocument | null> => {
    const result = await DatabaseService.list<CategoryDocument>(
      appwriteConfig.collections.categories || 'categories',
      [Query.equal('title', [title])]
    )
    return result.documents[0] || null
  },
}

// Trivia Document interface
export interface TriviaDocument extends Models.Document {
  client?: string // Relationship to clients table
  question: string
  answers?: string[]
  correctOptionIndex: number
  startDate: string
  endDate: string
  points: number
  views?: number // Number of times trivia was viewed
  skips?: number // Number of times trivia was skipped
  [key: string]: unknown
}

// Trivia Response Document interface
export interface TriviaResponseDocument extends Models.Document {
  trivia?: string // Relationship to trivia table (trivia ID)
  answer?: string // Answer text
  answerIndex: number // Index of the answer selected (0-10000)
  user?: string // Relationship to user_profiles table (user ID)
  [key: string]: unknown
}

/** Compare answerIndex to correctOptionIndex as numbers (Appwrite may return integers as strings). */
export function isCorrectTriviaResponse(
  response: { answerIndex?: number | string },
  correctOptionIndex: number | string | undefined
): boolean {
  return Number(response.answerIndex) === Number(correctOptionIndex)
}

// Trivia Responses service
export const triviaResponsesService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<TriviaResponseDocument>(appwriteConfig.collections.triviaResponses, data),
  getById: (id: string) =>
    DatabaseService.getById<TriviaResponseDocument>(appwriteConfig.collections.triviaResponses, id),
  list: (queries?: string[]) =>
    DatabaseService.list<TriviaResponseDocument>(appwriteConfig.collections.triviaResponses, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<TriviaResponseDocument>(appwriteConfig.collections.triviaResponses, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.triviaResponses, id),
  getByTriviaId: async (triviaId: string): Promise<TriviaResponseDocument[]> => {
    const result = await DatabaseService.list<TriviaResponseDocument>(
      appwriteConfig.collections.triviaResponses,
      [Query.equal('trivia', [triviaId]), Query.limit(5000)]
    )
    return result.documents
  },
  getByUserId: async (userId: string): Promise<TriviaResponseDocument[]> => {
    const result = await DatabaseService.list<TriviaResponseDocument>(
      appwriteConfig.collections.triviaResponses,
      [Query.equal('user', [userId]), Query.limit(5000)]
    )
    return result.documents
  },
  /** Count correct trivia answers (wins) for a user from trivia_responses + trivia correctOptionIndex */
  getTriviasWonCountByUserId: async (userId: string): Promise<number> => {
    const responses = await triviaResponsesService.getByUserId(userId)
    if (responses.length === 0) return 0
    const triviaIds = [...new Set(responses.map((r) => r.trivia).filter(Boolean))] as string[]
    let count = 0
    for (const tid of triviaIds) {
      try {
        const trivia = await triviaService.getById(tid)
        const correct = responses.filter(
          (r) => r.trivia === tid && isCorrectTriviaResponse(r, trivia.correctOptionIndex)
        )
        count += correct.length
      } catch {
        // Trivia may be deleted, skip
      }
    }
    return count
  },
}

// Trivia service
export const triviaService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<TriviaDocument>(appwriteConfig.collections.trivia, data),
  getById: (id: string) =>
    DatabaseService.getById<TriviaDocument>(appwriteConfig.collections.trivia, id),
  list: (queries?: string[]) =>
    DatabaseService.list<TriviaDocument>(appwriteConfig.collections.trivia, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<TriviaDocument>(appwriteConfig.collections.trivia, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.trivia, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<TriviaDocument>(
      appwriteConfig.collections.trivia,
      searchTerm,
      ['question'],
      queries
    ),
  // Full-collection search (see DatabaseService.searchAll) — pass ordering in baseQueries, no limit/offset.
  searchAll: (searchTerm: string, baseQueries?: string[]) =>
    DatabaseService.searchAll<TriviaDocument>(
      appwriteConfig.collections.trivia,
      searchTerm,
      ['question'],
      baseQueries
    ),
  getWithClient: async (id: string): Promise<{ trivia: TriviaDocument; client: ClientDocument | null }> => {
    const trivia = await DatabaseService.getById<TriviaDocument>(appwriteConfig.collections.trivia, id)
    let client: ClientDocument | null = null
    if (trivia.client) {
      try {
        client = await DatabaseService.getById<ClientDocument>(appwriteConfig.collections.clients, trivia.client)
      } catch (error) {
        console.error('Error fetching client:', error)
      }
    }
    return { trivia, client }
  },
  getWithStatistics: async (id: string): Promise<{
    trivia: TriviaDocument
    client: ClientDocument | null
    responses: TriviaResponseDocument[]
    statistics: {
      totalResponses: number
      correctResponses: number
      incorrectResponses: number
      uniqueUsers: number
    }
  }> => {
    const { trivia, client } = await triviaService.getWithClient(id)
    const responses = await triviaResponsesService.getByTriviaId(id)
    
    const correctResponses = responses.filter((response) =>
      isCorrectTriviaResponse(response, trivia.correctOptionIndex)
    )
    const uniqueUsers = new Set(responses.map((r) => r.user).filter(Boolean)).size
    
    return {
      trivia,
      client,
      responses,
      statistics: {
        totalResponses: responses.length,
        correctResponses: correctResponses.length,
        incorrectResponses: responses.length - correctResponses.length,
        uniqueUsers,
      },
    }
  },
}

// User Form Data interface (for creating/updating users)
export interface UserFormData {
  email: string
  password: string
  firstname?: string
  lastname?: string
  username?: string
  phoneNumber?: string
  dob?: string
  zipCode?: string
  avatarURL?: string
  role?: 'admin' | 'user'
  tierLevel?: string
  totalPoints?: number
}

/**
 * Columns a user LIST screen actually renders, for Query.select.
 *
 * Without a select, every listed profile ships its `notifications` array — measured at ~3.2KB of a
 * ~3.3KB average document, i.e. almost the entire payload, and up to 39KB on the largest profile.
 * Fetching the whole collection cost 1.83MB before this list and 0.38MB after it. The omitted
 * columns (`notifications`, `notificationPreferences`, `savedEventIds`, `favoriteIds`,
 * `nearbyFavoriteNotifiedEventIds`) are per-user bookkeeping that no list column shows; the Edit
 * modal re-reads the complete document via appUsersService.getById, so nothing downstream loses a
 * field. Report exports deliberately do NOT use this — they read full documents.
 *
 * `$id` is required for cursor paging in fetchAllPages, and `$createdAt` backs the default sort.
 */
export const USER_PROFILE_LIST_FIELDS = [
  '$id',
  '$createdAt',
  '$updatedAt',
  'authID',
  'firstname',
  'lastname',
  'username',
  'phoneNumber',
  'dob',
  'avatarURL',
  'isBlocked',
  'zipCode',
  'referalCode',
  'referralCode',
  'usedReferralCode',
  'role',
  'totalEvents',
  'totalReviews',
  'totalPoints',
  'isAmbassador',
  'isInfluencer',
  'idAdult',
  'tierLevel',
  'triviasWon',
] as const

// App User interface (combines Auth user and user_profiles)
export interface AppUser extends UserProfile {
  email?: string
  firstName?: string // Mapped from firstname for UI compatibility
  lastName?: string // Mapped from lastname for UI compatibility
  lastLoginDate?: string // Last login date from Auth (accessedAt)
  // Additional fields from Auth user can be added here
}

/**
 * Auth IDs per get-user-emails execution.
 *
 * This was 25, which meant one Users-page search (emails are needed for every profile before the
 * list can be filtered) fanned out to 27 executions for ~650 users. Measured in production that
 * cost ~20s per search, and ~77s when the search was refined, because the endpoint resolved each ID
 * with its own Auth round trip.
 *
 * Worse, it was losing data: the Statistics function's timeout is 15s, and 16% of those executions
 * (97 of 596 sampled) died at ~15.3s with a 500. A failed execution yields no emails for its batch,
 * so those users rendered with a blank email and last-login — and an email search could not find
 * them at all.
 *
 * The endpoint now batches internally via users.list, so a much larger slice finishes in about a
 * second — 250 IDs is 3 internal round trips there, leaving a wide margin under the 15s timeout.
 * Raising this further is only safe alongside that batching; do not increase it without checking
 * the function's configured timeout.
 */
const GET_USER_EMAILS_BATCH_SIZE = 250

/**
 * Max get-user-emails executions to run concurrently. Bounds the fan-out so fetching emails for a
 * large user set (e.g. an admin search over the whole collection) doesn't fire hundreds of parallel
 * Function executions at once, which risks rate limits / quota exhaustion.
 */
const GET_USER_EMAILS_CONCURRENCY = 5

/**
 * Fetches emails and last login dates for auth IDs in batches to avoid function timeout.
 * Each batch runs in a separate execution so no single call exceeds the function's timeout; batches
 * are run in bounded-concurrency groups so the total parallel fan-out stays capped.
 */
async function fetchUserEmailsInBatches(authIDs: string[]): Promise<{
  emailMap: Record<string, string>
  lastLoginMap: Record<string, string>
}> {
  const emailMap: Record<string, string> = {}
  const lastLoginMap: Record<string, string> = {}
  if (authIDs.length === 0 || !appwriteConfig.functions.statisticsFunctionId) {
    return { emailMap, lastLoginMap }
  }
  const chunks: string[][] = []
  for (let i = 0; i < authIDs.length; i += GET_USER_EMAILS_BATCH_SIZE) {
    chunks.push(authIDs.slice(i, i + GET_USER_EMAILS_BATCH_SIZE))
  }

  const runChunk = async (chunk: string[]) => {
    const execution = await functions.createExecution({
      functionId: appwriteConfig.functions.statisticsFunctionId,
      xpath: '/get-user-emails',
      method: ExecutionMethod.POST,
      body: JSON.stringify({ authIDs: chunk }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (execution.status !== 'completed' || !execution.responseBody) return { emails: {} as Record<string, string>, lastLogins: {} as Record<string, string> }
    try {
      const response = JSON.parse(execution.responseBody)
      if (!response.success) return { emails: {}, lastLogins: {} }
      return {
        emails: response.emails ?? {},
        lastLogins: response.lastLogins ?? {},
      }
    } catch {
      return { emails: {}, lastLogins: {} }
    }
  }

  // Run chunks in bounded-concurrency groups so we never fire more than N executions at once.
  for (let i = 0; i < chunks.length; i += GET_USER_EMAILS_CONCURRENCY) {
    const group = chunks.slice(i, i + GET_USER_EMAILS_CONCURRENCY)
    const groupResults = await Promise.all(group.map(runChunk))
    for (const r of groupResults) {
      Object.assign(emailMap, r.emails)
      Object.assign(lastLoginMap, r.lastLogins)
    }
  }
  return { emailMap, lastLoginMap }
}

// Users service - handles creating Auth users and user_profiles
export const appUsersService = {
  // Create a new user (Auth + user_profiles) via Mobile API function (server-side creates both)
  create: async (userData: UserFormData): Promise<AppUser> => {
    try {
      if (!appwriteConfig.functions.mobileApiFunctionId) {
        throw new Error('Mobile API function is not configured. Cannot create Auth user.')
      }

      const body = {
        email: userData.email,
        password: userData.password,
        firstname: userData.firstname ?? '',
        lastname: userData.lastname ?? '',
        username: userData.username ?? '',
        phoneNumber: userData.phoneNumber ?? '',
        role: userData.role ?? 'user',
        tierLevel: userData.tierLevel ?? '',
        totalPoints: userData.totalPoints ?? 100,
        dob: userData.dob ?? '',
        zipCode: userData.zipCode ?? '',
        avatarURL: userData.avatarURL ?? '',
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.mobileApiFunctionId,
        xpath: '/create-user',
        method: ExecutionMethod.POST,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      })

      if (execution.status !== 'completed' || !execution.responseBody) {
        const msg =
          execution.status === 'failed'
            ? execution.responseBody ?? 'Create user failed'
            : 'Create user request did not complete in time.'
        throw new Error(msg)
      }

      const response = JSON.parse(execution.responseBody) as {
        success?: boolean
        error?: string
        profileId?: string
      }

      const status = execution.responseStatusCode ?? 0
      if (status < 200 || status >= 300) {
        throw new Error(response.error ?? 'Failed to create user.')
      }

      if (!response.success || !response.profileId) {
        throw new Error(response.error ?? 'Failed to create user.')
      }

      const profile = await userProfilesService.getById(response.profileId)
      if (!profile) throw new Error('User profile was created but could not be retrieved.')

      return {
        ...profile,
        firstName: (profile as { firstname?: string }).firstname,
        lastName: (profile as { lastname?: string }).lastname,
      } as AppUser
    } catch (error) {
      console.error('Error creating user:', error)
      throw error
    }
  },

  // Check if an Auth user already exists for a given email via Mobile API
  checkEmailAvailability: async (email: string): Promise<{ exists: boolean }> => {
    if (!appwriteConfig.functions.mobileApiFunctionId) {
      throw new Error('Mobile API function is not configured. Cannot check email availability.')
    }

    const trimmedEmail = email.trim().toLowerCase()
    if (!trimmedEmail) {
      return { exists: false }
    }

    try {
      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.mobileApiFunctionId,
        xpath: '/get-user-by-email',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ email: trimmedEmail }),
        headers: { 'Content-Type': 'application/json' },
      })

      // If function did not complete properly, assume not exists but log
      if (execution.status !== 'completed') {
        console.warn('get-user-by-email execution did not complete:', execution.status)
        return { exists: false }
      }

      const status = execution.responseStatusCode ?? 0

      // 200-range: user found => exists
      if (status >= 200 && status < 300) {
        return { exists: true }
      }

      // 404: user not found => does not exist
      if (status === 404) {
        return { exists: false }
      }

      // Other status codes: log and treat as non-existent to avoid blocking form
      console.warn('Unexpected status from get-user-by-email:', status, execution.responseBody)
      return { exists: false }
    } catch (error) {
      console.error('Error checking email availability:', error)
      // On error, do not block user creation; treat as not existing
      return { exists: false }
    }
  },

  // List all users with their profiles
  list: async (queries?: string[]): Promise<AppUser[]> => {
    try {
      const profiles = await userProfilesService.list(queries)
      
      // Fetch Auth user emails and last login dates via Cloud Function (batched to stay under the function timeout)
      const authIDs = profiles.documents
        .map((profile) => (profile as { authID?: string }).authID)
        .filter((id): id is string => !!id)

      let emailMap: Record<string, string> = {}
      let lastLoginMap: Record<string, string> = {}
      try {
        const result = await fetchUserEmailsInBatches(authIDs)
        emailMap = result.emailMap
        lastLoginMap = result.lastLoginMap
      } catch (emailError) {
        console.warn('Failed to fetch user emails:', emailError)
        // Continue without emails rather than failing completely
      }

      // Map profiles with emails, last login dates, and name fields
      return profiles.documents.map((profile) => {
        const authID = (profile as { authID?: string }).authID
        return {
          ...profile,
          // Map firstname/lastname to firstName/lastName for UI compatibility
          firstName: (profile as { firstname?: string }).firstname,
          lastName: (profile as { lastname?: string }).lastname,
          // Add email from Auth user
          email: authID ? emailMap[authID] : undefined,
          // Add last login date from Auth user
          lastLoginDate: authID ? lastLoginMap[authID] : undefined,
        }
      }) as AppUser[]
    } catch (error) {
      console.error('Error listing users:', error)
      throw error
    }
  },

  /**
   * List every user profile (all pages). Use for admin UIs that must show the full user set
   * (e.g. notification audience picker). Plain `list()` only returns Appwrite’s default first page.
   */
  listAll: async (): Promise<AppUser[]> => {
    try {
      const PAGE_SIZE = 500
      const allDocuments: UserProfile[] = []
      let offset = 0
      let total = 0
      for (;;) {
        const profiles = await userProfilesService.list([
          Query.orderDesc('$createdAt'),
          Query.limit(PAGE_SIZE),
          Query.offset(offset),
        ])
        total = profiles.total
        allDocuments.push(...profiles.documents)
        if (profiles.documents.length < PAGE_SIZE || allDocuments.length >= total) break
        offset += PAGE_SIZE
      }

      const authIDs = allDocuments
        .map((profile) => (profile as { authID?: string }).authID)
        .filter((id): id is string => !!id)

      let emailMap: Record<string, string> = {}
      let lastLoginMap: Record<string, string> = {}
      try {
        const result = await fetchUserEmailsInBatches(authIDs)
        emailMap = result.emailMap
        lastLoginMap = result.lastLoginMap
      } catch (emailError) {
        console.warn('Failed to fetch user emails:', emailError)
      }

      return allDocuments.map((profile) => {
        const authID = (profile as { authID?: string }).authID
        return {
          ...profile,
          firstName: (profile as { firstname?: string }).firstname,
          lastName: (profile as { lastname?: string }).lastname,
          email: authID ? emailMap[authID] : undefined,
          lastLoginDate: authID ? lastLoginMap[authID] : undefined,
        }
      }) as AppUser[]
    } catch (error) {
      console.error('Error listing all users:', error)
      throw error
    }
  },
  
  // List users with pagination info
  listWithPagination: async (queries?: string[]): Promise<{ users: AppUser[]; total: number }> => {
    try {
      const profiles = await userProfilesService.list(queries)
      
      // Fetch Auth user emails and last login dates via Cloud Function (batched to stay under the function timeout)
      const authIDs = profiles.documents
        .map((profile) => (profile as { authID?: string }).authID)
        .filter((id): id is string => !!id)

      let emailMap: Record<string, string> = {}
      let lastLoginMap: Record<string, string> = {}
      try {
        const result = await fetchUserEmailsInBatches(authIDs)
        emailMap = result.emailMap
        lastLoginMap = result.lastLoginMap
      } catch (emailError) {
        console.warn('Failed to fetch user emails:', emailError)
        // Continue without emails rather than failing completely
      }

      // Map profiles with emails, last login dates, and name fields
      const users = profiles.documents.map((profile) => {
        const authID = (profile as { authID?: string }).authID
        return {
          ...profile,
          // Map firstname/lastname to firstName/lastName for UI compatibility
          firstName: (profile as { firstname?: string }).firstname,
          lastName: (profile as { lastname?: string }).lastname,
          // Add email from Auth user
          email: authID ? emailMap[authID] : undefined,
          // Add last login date from Auth user
          lastLoginDate: authID ? lastLoginMap[authID] : undefined,
        }
      }) as AppUser[]
      
      return {
        users,
        total: profiles.total,
      }
    } catch (error) {
      console.error('Error listing users:', error)
      throw error
    }
  },

  /**
   * Like listWithPagination, but pages through EVERY profile matching `queries` (not just the
   * first 500) and fetches emails for all of them. Use for the search / client-side-sort paths so
   * results are never capped to an arbitrary window — the cap is what let matches "disappear" until
   * an unrelated filter/sort shifted the fetched window. Pass ordered queries WITHOUT
   * Query.limit/cursor — paging is handled internally.
   */
  listAllWithPagination: async (queries: string[] = []): Promise<{ users: AppUser[]; total: number }> => {
    try {
      const allProfiles = await fetchAllPages<UserProfile>((cursor, limit) =>
        userProfilesService.list([
          ...queries,
          Query.limit(limit),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ])
      )

      // Fetch Auth user emails and last login dates via Cloud Function (batched to stay under the function timeout)
      const authIDs = allProfiles
        .map((profile) => (profile as { authID?: string }).authID)
        .filter((id): id is string => !!id)

      let emailMap: Record<string, string> = {}
      let lastLoginMap: Record<string, string> = {}
      try {
        const result = await fetchUserEmailsInBatches(authIDs)
        emailMap = result.emailMap
        lastLoginMap = result.lastLoginMap
      } catch (emailError) {
        console.warn('Failed to fetch user emails:', emailError)
        // Continue without emails rather than failing completely
      }

      const users = allProfiles.map((profile) => {
        const authID = (profile as { authID?: string }).authID
        return {
          ...profile,
          firstName: (profile as { firstname?: string }).firstname,
          lastName: (profile as { lastname?: string }).lastname,
          email: authID ? emailMap[authID] : undefined,
          lastLoginDate: authID ? lastLoginMap[authID] : undefined,
        }
      }) as AppUser[]

      return { users, total: allProfiles.length }
    } catch (error) {
      console.error('Error listing all users (paginated):', error)
      throw error
    }
  },

  // Get user by ID
  getById: async (id: string): Promise<AppUser | null> => {
    try {
      const profile = await userProfilesService.getById(id)
      if (!profile) return null
      
      // Fetch Auth user email via Cloud Function (uses same batched helper for consistency)
      const authID = (profile as { authID?: string }).authID
      let email: string | undefined
      if (authID) {
        try {
          const { emailMap } = await fetchUserEmailsInBatches([authID])
          email = emailMap[authID]
        } catch (emailError) {
          console.warn('Failed to fetch user email:', emailError)
        }
      }

      // Map firstname/lastname to firstName/lastName for UI compatibility
      return {
        ...profile,
        firstName: (profile as { firstname?: string }).firstname,
        lastName: (profile as { lastname?: string }).lastname,
        email,
      } as AppUser
    } catch (error) {
      console.error('Error getting user:', error)
      return null
    }
  },

  // Update user profile
  update: async (id: string, data: Record<string, unknown>): Promise<AppUser> => {
    try {
      const currentUser = await userProfilesService.getById(id)

      // Validate username uniqueness if username is being updated
      if (data.username && typeof data.username === 'string' && data.username.trim()) {
      const existingUsers = await userProfilesService.list([
        Query.equal('username', data.username.trim())
      ])
      
      // Check if username exists for a different user (exclude current user)
      const duplicateUser = existingUsers.documents.find(user => user.$id !== id)
      if (duplicateUser) {
        throw new Error('Username already exists. Please choose a different username.')
      }
    }

    // Validate phone number uniqueness if phoneNumber is being updated
    if (data.phoneNumber && typeof data.phoneNumber === 'string' && data.phoneNumber.trim()) {
      const normalizePhone = (value: string) => value.replace(/\D/g, '')
      const incomingPhoneRaw = data.phoneNumber.trim()
      const incomingPhoneNormalized = normalizePhone(incomingPhoneRaw)
      const currentPhoneNormalized = normalizePhone(String(currentUser.phoneNumber ?? ''))

      // Skip duplicate checks when the effective phone number is unchanged.
      if (incomingPhoneNormalized !== currentPhoneNormalized) {
        const candidateValues = Array.from(
          new Set([incomingPhoneRaw, incomingPhoneNormalized].filter(Boolean))
        )

        let duplicatePhoneUser: UserProfile | undefined
        for (const candidate of candidateValues) {
          const existingByPhone = await userProfilesService.list([
            Query.equal('phoneNumber', [candidate])
          ])
          duplicatePhoneUser = existingByPhone.documents.find(user => user.$id !== id)
          if (duplicatePhoneUser) break
        }

        if (duplicatePhoneUser) {
          throw new Error('Phone number already exists. Please use a different phone number.')
        }
      }
    }
      
      // Update user_profiles
      const updatedProfile = await userProfilesService.update(id, data)
      
      // Map firstname/lastname to firstName/lastName for UI compatibility
      return {
        ...updatedProfile,
        firstName: (updatedProfile as { firstname?: string }).firstname,
        lastName: (updatedProfile as { lastname?: string }).lastname,
      } as AppUser
    } catch (error) {
      console.error('Error updating user:', error)
      throw error
    }
  },

  // Delete user (Auth + user_profiles) via Mobile API server-side function
  delete: async (id: string): Promise<void> => {
    try {
      if (!appwriteConfig.functions.mobileApiFunctionId) {
        throw new Error('Mobile API function is not configured. Cannot delete Auth user.')
      }

      // Get the user profile to retrieve the authID
      const userProfile = await userProfilesService.getById(id)
      if (!userProfile.authID) {
        throw new Error('User profile does not have an authID')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.mobileApiFunctionId,
        xpath: '/delete-account',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ userId: userProfile.authID }),
        headers: { 'Content-Type': 'application/json' },
      })

      if (execution.status !== 'completed' || !execution.responseBody) {
        const msg = execution.responseBody ?? 'Delete user request did not complete'
        throw new Error(msg)
      }

      const response = JSON.parse(execution.responseBody)
      const status = execution.responseStatusCode ?? 0

      if (status < 200 || status >= 300 || !response.success) {
        throw new Error(response.error ?? 'Failed to delete user')
      }
    } catch (error) {
      console.error('Error deleting user:', error)
      throw error
    }
  },

  // Search users
  // Note: Appwrite Tables search may require different query syntax
  search: async (searchTerm: string, queries?: string[]): Promise<AppUser[]> => {
    try {
      const result = await userProfilesService.search(
        searchTerm,
        queries
      )
      
      // Fetch Auth user emails via Cloud Function (batched to stay under the function timeout)
      const authIDs = result.documents
        .map((profile) => (profile as { authID?: string }).authID)
        .filter((id): id is string => !!id)

      let emailMap: Record<string, string> = {}
      try {
        const batchResult = await fetchUserEmailsInBatches(authIDs)
        emailMap = batchResult.emailMap
      } catch (emailError) {
        console.warn('Failed to fetch user emails:', emailError)
      }

      // Map firstname/lastname to firstName/lastName for UI compatibility
      return result.documents.map((profile) => {
        const authID = (profile as { authID?: string }).authID
        return {
          ...profile,
          firstName: (profile as { firstname?: string }).firstname,
          lastName: (profile as { lastname?: string }).lastname,
          email: authID ? emailMap[authID] : undefined,
        }
      }) as AppUser[]
    } catch (error) {
      console.error('Error searching users:', error)
      throw error
    }
  },

  // Block a user (update both Appwrite Auth and user_profile)
  // Note: userId parameter is the user_profile document ID
  blockUser: async (userId: string): Promise<void> => {
    try {
      if (!appwriteConfig.functions.mobileApiFunctionId) {
        throw new Error('Mobile API function ID is not configured')
      }

      // Get the user profile to retrieve the authID
      const userProfile = await userProfilesService.getById(userId)
      if (!userProfile.authID) {
        throw new Error('User profile does not have an authID')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.mobileApiFunctionId,
        xpath: '/update-user-status',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ userId: userProfile.authID, block: true }),
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (execution.responseStatusCode !== 200) {
        throw new Error(`Failed to block user: ${execution.responseBody}`)
      }

      const response = JSON.parse(execution.responseBody)
      if (!response.success) {
        throw new Error(response.error || 'Failed to block user')
      }
    } catch (error) {
      console.error('Error blocking user:', error)
      throw error
    }
  },

  // Unblock a user (update both Appwrite Auth and user_profile)
  // Note: userId parameter is the user_profile document ID
  unblockUser: async (userId: string): Promise<void> => {
    try {
      if (!appwriteConfig.functions.mobileApiFunctionId) {
        throw new Error('Mobile API function ID is not configured')
      }

      // Get the user profile to retrieve the authID
      const userProfile = await userProfilesService.getById(userId)
      if (!userProfile.authID) {
        throw new Error('User profile does not have an authID')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.mobileApiFunctionId,
        xpath: '/update-user-status',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ userId: userProfile.authID, block: false }),
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (execution.responseStatusCode !== 200) {
        throw new Error(`Failed to unblock user: ${execution.responseBody}`)
      }

      const response = JSON.parse(execution.responseBody)
      if (!response.success) {
        throw new Error(response.error || 'Failed to unblock user')
      }
    } catch (error) {
      console.error('Error unblocking user:', error)
      throw error
    }
  },
}

// Statistics Type Definitions
export interface DashboardStats {
  totalClientsBrands: number
  totalPointsAwarded: number
  totalUsers: number
  averagePPU: number
  totalCheckins: number
  reviews: number
  totalClientsBrandsChange?: number
  totalPointsAwardedChange?: number
  totalUsersChange?: number
  averagePPUChange?: number
  totalCheckinsChange?: number
  reviewsChange?: number
}

export interface ClientsStats {
  totalClients: number
  newThisMonth: number
}

export interface UsersStats {
  totalUsers: number
  avgPoints: number
  newThisWeek: number
  usersInBlacklist: number
}

export interface NotificationsStats {
  totalSent: number
  avgOpenRate: number
  avgClickRate: number
  scheduled: number
}

export interface TriviaStats {
  totalQuizzes: number
  scheduled: number
  active: number
  completed: number
}

export interface PopupsStats {
  totalPopups: number
  scheduled: number
  active: number
  completed: number
}

/**
 * One row per USER of "Who saw this pop-up", not one per sighting (SAM-12): a repeat viewer
 * arrives once, with `impressions` carrying how many times they were shown it.
 */
export interface PopupViewerRow {
  userId: string
  /** Display name from user_profiles, falling back to username then the raw id. */
  name: string
  username: string
  /** Sightings by this user, same-day repeats included. Always >= 1. */
  impressions: number
  firstShownAt: string | null
  lastShownAt: string | null
  /** The most recent click, or null for a user who never clicked any sighting. */
  clickedAt: string | null
  /** Distinct Eastern "YYYY-MM-DD" days this user was shown the pop-up. */
  dayKeys: string[]
  is21Plus: boolean
}

export interface PopupDetailStatistics {
  totalImpressions: number
  uniqueUsersShown: number
  uniqueClickers: number
  clickers21Plus: number
  /** uniqueClickers / uniqueUsersShown, 0–1 */
  ctr: number
  viewers: PopupViewerRow[]
  /** True when the campaign has more unique viewers than the response cap (1000). */
  viewersTruncated: boolean
}

// Statistics Service
export const statisticsService = {
  /**
   * Get statistics for a specific page
   * @param page - The page to get statistics for: 'dashboard' | 'clients' | 'users' | 'notifications' | 'trivia'
   * @returns Statistics object for the requested page
   */
  getStatistics: async <T extends DashboardStats | ClientsStats | UsersStats | NotificationsStats | TriviaStats | PopupsStats | PopupDetailStatistics>(
    page: 'dashboard' | 'clients' | 'users' | 'notifications' | 'trivia' | 'popups',
    extra?: { popupId?: string }
  ): Promise<T> => {
    try {
      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.statisticsFunctionId,
        xpath: '/get-statistics',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ page, ...(extra ?? {}) }),
        headers: {
          'Content-Type': 'application/json',
        },
      })

      // Check execution status
      if (execution.status === 'failed') {
        let errorMessage = 'Function execution failed'
        
        // Try to parse the response body for error details
        if (execution.responseBody) {
          try {
            const errorResponse = JSON.parse(execution.responseBody)
            if (errorResponse.error) {
              errorMessage = errorResponse.error
            }
          } catch {
            // If responseBody is not JSON, use it as the error message
            errorMessage = execution.responseBody
          }
        }
        
        // Include execution errors if available
        if (execution.errors) {
          errorMessage += ` (Execution errors: ${execution.errors})`
        }
        
        throw new Error(errorMessage)
      }

      // Check response status code
      if (execution.responseStatusCode && execution.responseStatusCode >= 400) {
        let errorMessage = `Function returned status ${execution.responseStatusCode}`
        
        if (execution.responseBody) {
          try {
            const errorResponse = JSON.parse(execution.responseBody)
            if (errorResponse.error) {
              errorMessage = errorResponse.error
            }
          } catch {
            errorMessage = execution.responseBody
          }
        }
        
        throw new Error(errorMessage)
      }

      // Parse response body
      let response: Record<string, unknown> = {}
      if (execution.responseBody) {
        try {
          response = JSON.parse(execution.responseBody) as Record<string, unknown>
        } catch {
          throw new Error(`Invalid JSON response from function: ${execution.responseBody}`)
        }
      }

      if (!response.success) {
        const errorMessage = typeof response.error === 'string' ? response.error : 'Failed to fetch statistics'
        throw new Error(errorMessage)
      }

      return response.statistics as T
    } catch (error) {
      console.error(`Error fetching statistics for ${page}:`, error)
      throw error
    }
  },
}

// Notification Document interface
export type NotificationAudience =
  | 'All'
  | 'NewUsers'
  | 'BrandAmbassadors'
  | 'Influencers'
  | 'Tier1'
  | 'Tier2'
  | 'Tier3'
  | 'Tier4'
  | 'Tier5'
  | 'ZipCode'
  | 'Targeted'

// Notification Document interface (category kept for existing DB records; admin only creates AppPush)
export interface NotificationDocument extends Models.Document {
  title: string
  message: string
  type: 'Notification' | 'Event Reminder' | 'Promotional' | 'Engagement'
  targetAudience: NotificationAudience
  category?: 'AppPush' | 'SystemPush'
  status: 'Scheduled' | 'Sent' | 'Draft'
  scheduledAt?: string // ISO date string for scheduled notifications
  sentAt?: string // ISO date string when notification was sent
  recipients?: number // Number of recipients
  openRate?: number // Percentage of users who opened
  clickRate?: number // Percentage of users who clicked
  selectedUserIds?: string[] // Array of user IDs for targeted notifications
  selectedZipCodes?: string[] // Array of zip codes for ZipCode audience
  newUsersTimeRange?: number // Days back for NewUsers audience
  [key: string]: unknown
}

/** Result of creating or updating a notification (DB write + optional immediate send). */
export type NotificationSaveResult = {
  document: NotificationDocument
  /** True when the row was saved but the push function failed or returned an error. */
  sendFailed?: boolean
  sendError?: string
}

// Notification Form Data interface (admin only creates App Push notifications)
export interface NotificationFormData {
  title: string
  message: string
  type: 'Notification' | 'Event Reminder' | 'Promotional' | 'Engagement'
  targetAudience: NotificationAudience
  category?: 'AppPush'
  schedule: 'Send Immediately' | 'Schedule for Later' | 'Recurring'
  scheduledAt?: string // ISO date string
  scheduledTime?: string // Time string (HH:mm)
  selectedUserIds?: string[] // Array of user IDs for targeted notifications
  selectedZipCodes?: string[] // Array of zip codes for ZipCode audience
  newUsersTimeRange?: number // Days back for NewUsers audience
}

const VALID_NOTIFICATION_TYPES: Array<NotificationFormData['type']> = [
  'Notification',
  'Event Reminder',
  'Promotional',
  'Engagement',
]

/**
 * Map arbitrary input to a valid Appwrite `notifications.type` enum value.
 * Trims whitespace; maps legacy/mistaken values (e.g. category mixed into type).
 */
function coerceAppwriteNotificationType(value: unknown): NotificationFormData['type'] {
  if (typeof value !== 'string') {
    return 'Event Reminder'
  }
  const normalized = value.replace(/\u00a0/g, ' ').trim()
  if (VALID_NOTIFICATION_TYPES.includes(normalized as NotificationFormData['type'])) {
    return normalized as NotificationFormData['type']
  }
  // Common mistake: channel/category stored or submitted as notification type
  if (normalized === 'AppPush' || normalized === 'SystemPush') {
    return 'Promotional'
  }
  return 'Event Reminder'
}

const VALID_TARGET_AUDIENCES: Array<NotificationAudience> = [
  'All',
  'NewUsers',
  'BrandAmbassadors',
  'Influencers',
  'Tier1',
  'Tier2',
  'Tier3',
  'Tier4',
  'Tier5',
  'ZipCode',
  'Targeted',
]

/** Normalize type and targetAudience to valid enum values for form display and API payloads. */
export function normalizeNotificationFormData(doc: { type?: string; targetAudience?: string }): {
  type: NotificationFormData['type']
  targetAudience: NotificationAudience
} {
  const type = coerceAppwriteNotificationType(doc.type)

  const targetAudience: NotificationAudience =
    doc.targetAudience && VALID_TARGET_AUDIENCES.includes(doc.targetAudience as NotificationAudience)
      ? (doc.targetAudience as NotificationAudience)
      : 'All'

  return { type, targetAudience }
}

function normalizeNotificationPayload(
  data: Partial<NotificationFormData>
): { type: NotificationFormData['type']; targetAudience: NotificationAudience } {
  return normalizeNotificationFormData(data)
}

const NOTIFICATION_SEND_TIME_EST = '13:00'

// Notifications service
export const notificationsService = {
  create: async (
    data: NotificationFormData,
    _appTimezone?: string
  ): Promise<NotificationSaveResult> => {
    const { targetAudience } = normalizeNotificationPayload(data)
    const dbData: Record<string, unknown> = {
      title: data.title,
      message: data.message,
      type: 'Notification' satisfies NotificationFormData['type'],
      targetAudience,
      category: data.category || 'AppPush',
      // Send Immediately stays immediate; Schedule for Later uses fixed 1:00 PM EST
      status: data.schedule === 'Schedule for Later' ? 'Scheduled' : 'Draft',
      recipients: 0, // Will be updated when notification is sent
    }

    // Add audience-specific fields only when matching targetAudience
    if (targetAudience === 'Targeted' && data.selectedUserIds && data.selectedUserIds.length > 0) {
      dbData.selectedUserIds = data.selectedUserIds
    }
    if (targetAudience === 'ZipCode' && data.selectedZipCodes && data.selectedZipCodes.length > 0) {
      dbData.selectedZipCodes = data.selectedZipCodes
    }
    if (targetAudience === 'NewUsers' && data.newUsersTimeRange != null) {
      const days = Number(data.newUsersTimeRange)
      if (!isNaN(days) && days > 0) {
        dbData.newUsersTimeRange = days
      }
    }

    if (data.schedule === 'Schedule for Later' && data.scheduledAt) {
      // Admin scheduled notifications are fixed to 1:00 PM Eastern.
      const sourceTimezone = DEFAULT_APP_TIMEZONE
      const utcDate = appTimeToUTC(
        data.scheduledAt,
        NOTIFICATION_SEND_TIME_EST,
        sourceTimezone
      )
      dbData.scheduledAt = utcDate.toISOString()
    }

    const notification = await DatabaseService.create<NotificationDocument>(
      appwriteConfig.collections.notifications,
      dbData
    )

    // Send runs after the document exists; failures must not imply "create failed" or users retry and duplicate rows.
    if (data.schedule === 'Send Immediately') {
      try {
        await notificationsService.sendNotification(notification.$id)
      } catch (e) {
        const sendError = e instanceof Error ? e.message : String(e)
        console.error('Error sending notification after create:', e)
        return { document: notification, sendFailed: true, sendError }
      }
    }

    return { document: notification }
  },

  getById: (id: string) =>
    DatabaseService.getById<NotificationDocument>(appwriteConfig.collections.notifications, id),

  list: (queries?: string[]) =>
    DatabaseService.list<NotificationDocument>(appwriteConfig.collections.notifications, queries),

  update: async (
    id: string,
    data: Partial<NotificationFormData>,
    _appTimezone?: string
  ): Promise<NotificationSaveResult> => {
    const { targetAudience } = normalizeNotificationPayload(data)
    // Only include actual database fields
    const dbData: Record<string, unknown> = {
      title: data.title,
      message: data.message,
      type: 'Notification' satisfies NotificationFormData['type'],
      targetAudience,
      category: data.category || 'AppPush',
    }
    
    // Add audience-specific fields only when matching targetAudience
    if (targetAudience === 'Targeted' && data.selectedUserIds && data.selectedUserIds.length > 0) {
      dbData.selectedUserIds = data.selectedUserIds
    }
    if (targetAudience === 'ZipCode' && data.selectedZipCodes && data.selectedZipCodes.length > 0) {
      dbData.selectedZipCodes = data.selectedZipCodes
    }
    if (targetAudience === 'NewUsers' && data.newUsersTimeRange != null) {
      const days = Number(data.newUsersTimeRange)
      if (!isNaN(days) && days > 0) {
        dbData.newUsersTimeRange = days
      }
    }

    // Handle scheduling updates (all sends are pinned to 1:00 PM EST)
    if (data.schedule === 'Schedule for Later' && data.scheduledAt) {
      // Admin scheduled notifications are fixed to 1:00 PM Eastern.
      const sourceTimezone = DEFAULT_APP_TIMEZONE
      const utcDate = appTimeToUTC(
        data.scheduledAt,
        NOTIFICATION_SEND_TIME_EST,
        sourceTimezone
      )
      dbData.scheduledAt = utcDate.toISOString()
      dbData.status = 'Scheduled'
    } else if (data.schedule === 'Send Immediately') {
      dbData.scheduledAt = null
      dbData.status = 'Draft'
    }

    const updated = await DatabaseService.update<NotificationDocument>(
      appwriteConfig.collections.notifications,
      id,
      dbData
    )

    if (data.schedule === 'Send Immediately') {
      try {
        await notificationsService.sendNotification(id)
      } catch (e) {
        const sendError = e instanceof Error ? e.message : String(e)
        console.error('Error sending notification after update:', e)
        return { document: updated, sendFailed: true, sendError }
      }
    }

    return { document: updated }
  },

  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.notifications, id),

  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<NotificationDocument>(
      appwriteConfig.collections.notifications,
      searchTerm,
      ['title', 'message'],
      queries
    ),
  // Full-collection search (see DatabaseService.searchAll) — pass ordering/filters in baseQueries, no limit/offset.
  searchAll: (searchTerm: string, baseQueries?: string[]) =>
    DatabaseService.searchAll<NotificationDocument>(
      appwriteConfig.collections.notifications,
      searchTerm,
      ['title', 'message'],
      baseQueries
    ),

  // Send notification via Appwrite function
  sendNotification: async (notificationId: string): Promise<void> => {
    try {
      if (!appwriteConfig.functions.notificationFunctionId) {
        throw new Error('Notification function ID is not configured')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.notificationFunctionId,
        xpath: '/send-notification',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ notificationId }),
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (execution.status === 'failed') {
        let errorMessage = 'Function execution failed'

        if (execution.responseBody) {
          try {
            const errorResponse = JSON.parse(execution.responseBody) as { error?: string }
            if (errorResponse.error) {
              errorMessage = errorResponse.error
            }
          } catch {
            errorMessage = execution.responseBody
          }
        } else if (
          !execution.responseBody &&
          typeof (execution as { duration?: number }).duration === 'number' &&
          (execution as { duration: number }).duration >= 10
        ) {
          // Empty body + multi-second run often indicates a timeout before the handler could respond.
          errorMessage =
            'Notification function timed out or crashed (empty response). For large audiences, increase the function timeout in Appwrite and redeploy the latest Notification function.'
        }

        if (execution.errors) {
          errorMessage += ` (Execution errors: ${execution.errors})`
        }

        throw new Error(errorMessage)
      }

      if (execution.responseStatusCode && execution.responseStatusCode >= 400) {
        let errorMessage = `Function returned status ${execution.responseStatusCode}`
        
        if (execution.responseBody) {
          try {
            const errorResponse = JSON.parse(execution.responseBody)
            if (errorResponse.error) {
              errorMessage = errorResponse.error
            }
          } catch {
            errorMessage = execution.responseBody
          }
        }
        
        throw new Error(errorMessage)
      }

      const response = execution.responseBody
        ? JSON.parse(execution.responseBody)
        : {}

      if (!response.success) {
        throw new Error(response.error || 'Failed to send notification')
      }

      // The Function stamps status/sentAt on the notification server-side, so nothing here went
      // through DatabaseService. Drop the cached full read explicitly, or a search run in the next
      // few seconds could still label this notification as Draft/Scheduled.
      invalidateSearchAllCache(appwriteConfig.collections.notifications)
    } catch (error) {
      console.error('Error sending notification:', error)
      throw error
    }
  },

  sendBadgeNotification: async (
    authId: string,
    badgeType: 'ambassador' | 'influencer'
  ): Promise<void> => {
    try {
      if (!appwriteConfig.functions.notificationFunctionId) {
        throw new Error('Notification function ID is not configured')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.notificationFunctionId,
        xpath: '/send-badge-notification',
        method: ExecutionMethod.POST,
        body: JSON.stringify({ userId: authId, badgeType }),
        headers: { 'Content-Type': 'application/json' },
      })

      if (execution.status === 'failed') {
        const errorMessage = execution.responseBody
          ? (() => { try { return JSON.parse(execution.responseBody).error } catch { return execution.responseBody } })()
          : 'Function execution failed'
        throw new Error(errorMessage)
      }

      if (execution.responseStatusCode && execution.responseStatusCode >= 400) {
        const errorMessage = execution.responseBody
          ? (() => { try { return JSON.parse(execution.responseBody).error } catch { return execution.responseBody } })()
          : `Function returned status ${execution.responseStatusCode}`
        throw new Error(errorMessage)
      }

      const responseData = execution.responseBody
        ? (() => {
            try {
              return JSON.parse(execution.responseBody) as { success?: boolean; error?: string }
            } catch {
              return null
            }
          })()
        : null
      if (!responseData?.success) {
        throw new Error(
          responseData?.error ?? 'Badge notification function returned unexpected response'
        )
      }
    } catch (error) {
      console.error('Error sending badge notification:', error)
      throw error
    }
  },

  /**
   * Send a tier-changed notification to a single auth user.
   * Mirrors the mobile app's `tierChanged` notification semantics.
   */
  sendTierNotification: async (
    authId: string,
    oldTierName: string | null,
    newTierName: string
  ): Promise<void> => {
    try {
      if (!appwriteConfig.functions.notificationFunctionId) {
        throw new Error('Notification function ID is not configured')
      }

      const execution = await functions.createExecution({
        functionId: appwriteConfig.functions.notificationFunctionId,
        xpath: '/send-tier-notification',
        method: ExecutionMethod.POST,
        body: JSON.stringify({
          userId: authId,
          oldTierName: oldTierName ?? undefined,
          newTierName,
        }),
        headers: { 'Content-Type': 'application/json' },
      })

      if (execution.status === 'failed') {
        const errorMessage = execution.responseBody
          ? (() => {
              try {
                return JSON.parse(execution.responseBody).error
              } catch {
                return execution.responseBody
              }
            })()
          : 'Function execution failed'
        throw new Error(errorMessage)
      }

      if (execution.responseStatusCode && execution.responseStatusCode >= 400) {
        const errorMessage = execution.responseBody
          ? (() => {
              try {
                return JSON.parse(execution.responseBody).error
              } catch {
                return execution.responseBody
              }
            })()
          : `Function returned status ${execution.responseStatusCode}`
        throw new Error(errorMessage)
      }

      const responseData = execution.responseBody
        ? (() => {
            try {
              return JSON.parse(execution.responseBody) as { success?: boolean; error?: string }
            } catch {
              return null
            }
          })()
        : null

      if (!responseData?.success) {
        throw new Error(
          responseData?.error ?? 'Tier notification function returned unexpected response'
        )
      }
    } catch (error) {
      console.error('Error sending tier notification:', error)
      throw error
    }
  },
}

// ============================================================================
// Popups (SAM-5)
// ============================================================================

// Popup Document interface — banner image pop-ups shown in the mobile app
export interface PopupDocument extends Models.Document {
  title: string
  imageUrl: string
  imageFileId: string
  link?: string | null
  /** Optional body text shown under the title on the pop-up. */
  description?: string | null
  startDate: string
  endDate: string
  /** Display gate: only serve to 21+ verified users. Defaults to true. */
  only21Plus?: boolean
  targetAudience: NotificationAudience
  selectedUserIds?: string[]
  selectedZipCodes?: string[]
  newUsersTimeRange?: number | null
  /** Where tapping the pop-up goes: an external URL (default when absent) or an in-app event page. */
  destinationType?: 'external' | 'event' | null
  destinationEventId?: string | null
  /** Serve events (impressions), maintained by the Mobile API function */
  views?: number
  /** Unique clickers, maintained by the Mobile API function */
  clicks?: number
  /**
   * Set by "Show again": impressions recorded before this moment no longer count towards the
   * one-sighting-per-user-per-day rule, so today's viewers see the banner once more.
   */
  interactionsResetAt?: string | null
  [key: string]: unknown
}

export const popupsService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<PopupDocument>(appwriteConfig.collections.popups, data),
  getById: (id: string) =>
    DatabaseService.getById<PopupDocument>(appwriteConfig.collections.popups, id),
  list: (queries?: string[]) =>
    DatabaseService.list<PopupDocument>(appwriteConfig.collections.popups, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<PopupDocument>(appwriteConfig.collections.popups, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.popups, id),

  /**
   * "Show again": re-open this pop-up to users who have already seen it today.
   *
   * Server-side rather than a direct write, for two reasons: `popup_interactions` grants no
   * client access at all, and the one-sighting-per-day rule that this relaxes lives in the
   * Mobile API. Pass a `userId` (a user_profiles document id, exactly as the viewers table
   * reports it) to re-open it for that one person; omit it for everyone.
   */
  resetInteractions: async (
    popupId: string,
    userId?: string
  ): Promise<{ scope: 'all' | 'user'; affected: number }> => {
    if (!appwriteConfig.functions.mobileApiFunctionId) {
      throw new Error('Mobile API function is not configured. Cannot re-show this pop-up.')
    }

    const execution = await functions.createExecution({
      functionId: appwriteConfig.functions.mobileApiFunctionId,
      xpath: '/reset-popup-interactions',
      method: ExecutionMethod.POST,
      body: JSON.stringify(userId ? { popupId, userId } : { popupId }),
      headers: { 'Content-Type': 'application/json' },
    })

    if (execution.status !== 'completed' || !execution.responseBody) {
      throw new Error(execution.responseBody || 'The re-show request did not complete')
    }

    const response = JSON.parse(execution.responseBody) as {
      success?: boolean
      error?: string
      scope?: 'all' | 'user'
      affected?: number
    }
    const status = execution.responseStatusCode ?? 0
    if (status < 200 || status >= 300 || !response.success) {
      throw new Error(response.error || 'Failed to re-show this pop-up')
    }

    return {
      scope: response.scope ?? (userId ? 'user' : 'all'),
      affected: response.affected ?? 0,
    }
  },
}

// Review Document interface
export interface ReviewDocument extends Models.Document {
  rating: number
  liked?: string
  hasPurchased?: boolean
  review?: string
  user?: string // User ID (relationship)
  event?: string // Event ID (relationship)
  pointsEarned?: number
  helpfulCount?: number
  isHidden?: boolean // Flag for content moderation - hidden reviews are not shown to users
  [key: string]: unknown
}

// Reviews service
export const reviewsService = {
  create: (data: Record<string, unknown>) =>
    DatabaseService.create<ReviewDocument>(appwriteConfig.collections.reviews, data),
  getById: (id: string) =>
    DatabaseService.getById<ReviewDocument>(appwriteConfig.collections.reviews, id),
  list: (queries?: string[]) =>
    DatabaseService.list<ReviewDocument>(appwriteConfig.collections.reviews, queries),
  update: (id: string, data: Record<string, unknown>) =>
    DatabaseService.update<ReviewDocument>(appwriteConfig.collections.reviews, id, data),
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.reviews, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<ReviewDocument>(
      appwriteConfig.collections.reviews,
      searchTerm,
      ['review'],
      queries
    ),
  // Get reviews with populated user and event data
  listWithRelations: async (queries?: string[]): Promise<ReviewDocument[]> => {
    const result = await DatabaseService.list<ReviewDocument>(
      appwriteConfig.collections.reviews,
      queries
    )
    return result.documents
  },
  // Hide a review (moderation action)
  hideReview: async (reviewId: string): Promise<ReviewDocument> => {
    return DatabaseService.update<ReviewDocument>(
      appwriteConfig.collections.reviews,
      reviewId,
      { isHidden: true }
    )
  },
  // Unhide a review (restore visibility)
  unhideReview: async (reviewId: string): Promise<ReviewDocument> => {
    return DatabaseService.update<ReviewDocument>(
      appwriteConfig.collections.reviews,
      reviewId,
      { isHidden: false }
    )
  },
}

// Check-in Document interface (one row per user check-in to an event)
export interface CheckinDocument extends Models.Document {
  user?: string // Relationship to user_profiles table (user ID)
  event?: string // Relationship to events table (event ID)
  points?: number // Points earned for this check-in
  [key: string]: unknown
}

// Check-ins service (read-only here; check-ins are created by the mobile app)
export const checkinsService = {
  list: (queries?: string[]) =>
    DatabaseService.list<CheckinDocument>(appwriteConfig.collections.checkins, queries),
}

// Settings Document interface
export interface SettingsDocument extends Models.Document {
  key: string
  value: string
  description?: string
  [key: string]: unknown
}

/**
 * Read one of the two referral-bonus Settings docs BY DOCUMENT ID, mirroring the Mobile API's
 * getReferralPointSettings (appwrite/functions/Mobile API/src/main.ts) so the admin reports price a
 * referral exactly the way the function that awarded it did. Returns null — never a silent 0 — when
 * the doc is missing or the value is not a non-negative integer, so callers can warn instead of
 * quietly under-reporting.
 */
async function readReferralPointsSetting(
  documentId: string,
  label: string
): Promise<number | null> {
  try {
    const doc = await DatabaseService.getById<SettingsDocument>(
      appwriteConfig.collections.settings,
      documentId
    )
    const value = parseInt(doc.value, 10)
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch (error) {
    console.error(`Error fetching ${label} referral points setting:`, error)
    return null
  }
}

// Settings service
export const settingsService = {
  // Get a setting by key
  getByKey: async (key: string): Promise<SettingsDocument | null> => {
    try {
      const result = await DatabaseService.list<SettingsDocument>(
        appwriteConfig.collections.settings,
        [Query.equal('key', [key])]
      )
      return result.documents[0] || null
    } catch (error) {
      console.error(`Error fetching setting with key "${key}":`, error)
      return null
    }
  },
  
  // Create a new setting
  create: (data: { key: string; value: string; description?: string }) =>
    DatabaseService.create<SettingsDocument>(appwriteConfig.collections.settings, data),

  // Update an existing setting
  update: (id: string, data: Partial<Pick<SettingsDocument, 'value' | 'description'>>) =>
    DatabaseService.update<SettingsDocument>(appwriteConfig.collections.settings, id, data),
  
  // Get multiple settings by keys
  getByKeys: async (keys: string[]): Promise<Map<string, string>> => {
    const settingsMap = new Map<string, string>()
    if (keys.length === 0) return settingsMap
    
    try {
      const result = await DatabaseService.list<SettingsDocument>(
        appwriteConfig.collections.settings,
        [Query.equal('key', keys)]
      )
      
      result.documents.forEach((doc) => {
        settingsMap.set(doc.key, doc.value)
      })
    } catch (error) {
      console.error('Error fetching settings:', error)
    }
    
    return settingsMap
  },
  
  // Get default check-in points from settings
  getDefaultCheckInPoints: async (): Promise<number | null> => {
    const setting = await settingsService.getByKey('checkInPoints')
    if (setting && setting.value) {
      const value = parseFloat(setting.value)
      return isNaN(value) ? null : value
    }
    return null
  },
  
  // Get default review points from settings
  getDefaultReviewPoints: async (): Promise<number | null> => {
    const setting = await settingsService.getByKey('reviewPoints')
    if (setting && setting.value) {
      const value = parseFloat(setting.value)
      return isNaN(value) ? null : value
    }
    return null
  },

  /**
   * Referee (new-user) referral bonus. Read by document ID to mirror the Mobile API's
   * getReferralPointSettings (appwrite/functions/Mobile API/src/main.ts), which fetches the
   * settings doc whose $id is 'ref_setting_referee_pts' and parses its integer `value`.
   * Returns null if the setting is missing or not a valid non-negative integer.
   */
  getRefereeReferralPoints: async (): Promise<number | null> => {
    return readReferralPointsSetting('ref_setting_referee_pts', 'referee')
  },

  /**
   * Referrer (inviter) referral bonus. Same contract as getRefereeReferralPoints, for the doc whose
   * $id is 'ref_setting_referrer_pts' — the other half of the award the Mobile API's processReferral
   * hands out. Reports that count only the referee side credit nothing to the user who did the
   * inviting, so a prolific referrer's points look like they came from nowhere.
   */
  getReferrerReferralPoints: async (): Promise<number | null> => {
    return readReferralPointsSetting('ref_setting_referrer_pts', 'referrer')
  },

  /** Get app timezone (IANA). Defaults to America/New_York if not set. */
  getAppTimezone: async (): Promise<string> => {
    const setting = await settingsService.getByKey('appTimezone')
    if (setting?.value) return setting.value
    return DEFAULT_APP_TIMEZONE
  },

  /** Set app timezone (IANA). Upserts the appTimezone setting. */
  setAppTimezone: async (ianaTimezone: string): Promise<void> => {
    const existing = await settingsService.getByKey('appTimezone')
    if (existing) {
      await DatabaseService.update<SettingsDocument>(
        appwriteConfig.collections.settings,
        existing.$id,
        { value: ianaTimezone }
      )
    } else {
      await DatabaseService.create<SettingsDocument>(
        appwriteConfig.collections.settings,
        { key: 'appTimezone', value: ianaTimezone }
      )
    }
  },
}

// Tier Document interface
export interface TierDocument extends Models.Document {
  name: string
  requiredPoints: number
  order: number
  description?: string
  imageURL?: string
  [key: string]: unknown
}

/**
 * Tier name for a point total: highest tier in `tiers` whose requiredPoints the user meets.
 * Matches server-side “threshold” semantics when tier rows use the same requiredPoints as production.
 */
export function tierLevelForTotalPoints(tiers: TierDocument[], totalPoints: number): string {
  if (tiers.length === 0) return ''
  const pts = Number.isFinite(totalPoints) ? Math.max(0, totalPoints) : 0
  const sorted = [...tiers].sort(
    (a, b) => (Number(a.requiredPoints) || 0) - (Number(b.requiredPoints) || 0)
  )
  let chosen = sorted[0]
  for (const t of sorted) {
    const req = Number(t.requiredPoints) || 0
    if (pts >= req) chosen = t
  }
  return String(chosen?.name ?? '').trim()
}

const normalizeTierKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

function resolveStoredTier(tiers: TierDocument[], storedTierLevel: string): TierDocument | null {
  const normalized = normalizeTierKey(storedTierLevel)
  if (!normalized) return null

  const byName = tiers.find((t) => normalizeTierKey(String(t.name ?? '')) === normalized)
  if (byName) return byName

  const numMatch = storedTierLevel.match(/\d+/)
  if (numMatch) {
    const order = Number.parseInt(numMatch[0], 10)
    if (Number.isFinite(order)) {
      const byOrder = tiers.find((t) => Number(t.order) === order)
      if (byOrder) return byOrder
    }
  }

  return null
}

/**
 * Effective tier name shown to users: highest of (a) stored tierLevel resolved against
 * the tier table and (b) the tier the user's current points qualify for. Heals out-of-sync
 * profiles where tierLevel lags points. Mirrors the mobile app's resolveEffectiveTier so
 * the admin Users table never disagrees with the app's Achievements/Profile screens.
 */
export function effectiveTierLevel(
  tiers: TierDocument[],
  storedTierLevel: string | null | undefined,
  totalPoints: number
): string {
  if (tiers.length === 0) return String(storedTierLevel ?? '').trim()

  const pointsTierName = tierLevelForTotalPoints(tiers, totalPoints)
  const stored = (storedTierLevel ?? '').toString()
  const canonical = resolveStoredTier(tiers, stored)

  if (!canonical) return pointsTierName

  const pointsTier = tiers.find(
    (t) => normalizeTierKey(String(t.name ?? '')) === normalizeTierKey(pointsTierName)
  )
  if (!pointsTier) return String(canonical.name ?? '').trim()

  const canonicalOrder = Number(canonical.order) || 0
  const pointsOrder = Number(pointsTier.order) || 0
  return canonicalOrder >= pointsOrder
    ? String(canonical.name ?? '').trim()
    : String(pointsTier.name ?? '').trim()
}

// Tiers service
export const tiersService = {
  // List all tiers ordered by order field
  list: async (): Promise<TierDocument[]> => {
    try {
      const result = await DatabaseService.list<TierDocument>(
        appwriteConfig.collections.tiers,
        [Query.orderAsc('order')]
      )
      return result.documents
    } catch (error) {
      console.error('Error fetching tiers:', error)
      throw error
    }
  },
  
  // Get tier by ID
  getById: (id: string) =>
    DatabaseService.getById<TierDocument>(appwriteConfig.collections.tiers, id),
}

// Location Document interface
export interface LocationDocument extends Models.Document {
  name: string
  address: string
  city: string
  state: string
  zipCode: string
  location?: [number, number] // [longitude, latitude] - Must be type "point" in Appwrite collection
  [key: string]: unknown
}

// Location Form Data interface
export interface LocationFormData {
  name: string
  address: string
  city: string
  state: string
  zipCode: string
  location?: [number, number] // [longitude, latitude] - Must be type "point" in Appwrite collection
}

// Locations service
// Note: The 'location' field must be configured as type "point" in Appwrite collection
// Format: [longitude, latitude] - same as events collection
export const locationsService = {
  create: (data: LocationFormData) => {
    const dbData: Record<string, unknown> = {
      name: data.name,
      address: data.address,
      city: data.city,
      state: data.state,
      zipCode: data.zipCode,
      location: data.location || null,
    }

    return DatabaseService.create<LocationDocument>(appwriteConfig.collections.locations, dbData)
  },
  getById: (id: string) =>
    DatabaseService.getById<LocationDocument>(appwriteConfig.collections.locations, id),
  list: (queries?: string[]) =>
    DatabaseService.list<LocationDocument>(appwriteConfig.collections.locations, queries),
  update: (id: string, data: Partial<LocationFormData>) => {
    const dbData: Record<string, unknown> = {
      ...data,
    }

    return DatabaseService.update<LocationDocument>(appwriteConfig.collections.locations, id, dbData)
  },
  delete: (id: string) =>
    DatabaseService.delete(appwriteConfig.collections.locations, id),
  search: (searchTerm: string, queries?: string[]) =>
    DatabaseService.search<LocationDocument>(
      appwriteConfig.collections.locations,
      searchTerm,
      ['name', 'address', 'city', 'state', 'zipCode'],
      queries
    ),
  // Full-collection search (see DatabaseService.searchAll) — pass ordering in baseQueries, no limit/offset.
  searchAll: (searchTerm: string, baseQueries?: string[]) =>
    DatabaseService.searchAll<LocationDocument>(
      appwriteConfig.collections.locations,
      searchTerm,
      ['name', 'address', 'city', 'state', 'zipCode'],
      baseQueries
    ),
  findByName: async (name: string): Promise<LocationDocument | null> => {
    const result = await DatabaseService.list<LocationDocument>(
      appwriteConfig.collections.locations,
      [Query.equal('name', [name])]
    )
    return result.documents[0] || null
  },
}
