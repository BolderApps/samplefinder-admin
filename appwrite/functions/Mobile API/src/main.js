import { Client, Databases, ExecutionMethod, Functions, Query, ID, Users, } from 'node-appwrite';
/**
 * Format: 6 uppercase alphanumeric characters (excluding I, O, 0, 1)
 */
function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}
async function checkReferralCodeExists(databases, code) {
    try {
        const result = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('referralCode', code), Query.limit(1)]);
        return (result.total ?? 0) > 0;
    }
    catch {
        return false;
    }
}
async function generateUniqueReferralCode(databases) {
    let code = generateReferralCode();
    let attempts = 0;
    const maxAttempts = 10;
    while ((await checkReferralCodeExists(databases, code)) &&
        attempts < maxAttempts) {
        code = generateReferralCode();
        attempts++;
    }
    if (attempts >= maxAttempts) {
        code =
            generateReferralCode() + Date.now().toString(36).slice(-2).toUpperCase();
    }
    return code;
}
// ============================================================================
// REFERRAL FUNCTIONS
// ============================================================================
const REFERRAL_SETTING_REFEREE_PTS_ID = 'ref_setting_referee_pts';
const REFERRAL_SETTING_REFERRER_PTS_ID = 'ref_setting_referrer_pts';
async function getReferralPointSettings(databases) {
    const [refereeDoc, referrerDoc] = await Promise.all([
        databases.getDocument(DATABASE_ID, SETTINGS_TABLE_ID, REFERRAL_SETTING_REFEREE_PTS_ID),
        databases.getDocument(DATABASE_ID, SETTINGS_TABLE_ID, REFERRAL_SETTING_REFERRER_PTS_ID),
    ]);
    const refereePts = parseInt(refereeDoc.value, 10);
    const referrerPts = parseInt(referrerDoc.value, 10);
    if (isNaN(refereePts) || refereePts < 0) {
        throw { code: 500, message: 'Invalid referee points setting' };
    }
    if (isNaN(referrerPts) || referrerPts < 0) {
        throw { code: 500, message: 'Invalid referrer points setting' };
    }
    return { refereePts, referrerPts };
}
/**
 * Apply a referral code after signup verification.
 *
 * 1. Look up the referrer by referralCode.
 * 2. Validate referrer exists and is not the same user.
 * 3. Check idempotency via usedReferralCode on the invitee profile.
 * 4. Read point values from the Settings table.
 * 5. Award points to both referrer and invitee.
 * 6. Mark invitee's usedReferralCode so it cannot be applied again.
 * 7. Send push notification to referrer via the Notification function.
 */
async function applyReferral(databases, functions, data, log) {
    const { userId, referralCode } = data;
    // 1. Get invitee profile (userId may be an Auth ID, not a document ID)
    let inviteeProfile;
    try {
        inviteeProfile = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId);
    }
    catch {
        // Fallback: look up by authID field
        const profileResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId), Query.limit(1)]);
        if (profileResult.total === 0) {
            throw { code: 404, message: 'User profile not found' };
        }
        inviteeProfile = profileResult.documents[0];
    }
    // 2. Idempotency check: invitee already used a referral code
    if (inviteeProfile.usedReferralCode) {
        log(`User ${userId} already used referral code: ${inviteeProfile.usedReferralCode}`);
        throw {
            code: 409,
            message: 'Referral code already applied for this account',
        };
    }
    // 3. Find the referrer by referralCode
    const referrerResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('referralCode', referralCode), Query.limit(1)]);
    if (referrerResult.total === 0) {
        throw { code: 404, message: 'Referral code not found' };
    }
    const referrerProfile = referrerResult.documents[0];
    // 4. Prevent self-referral (compare doc IDs since userId may be an auth ID)
    if (referrerProfile.$id === inviteeProfile.$id) {
        throw { code: 400, message: 'Cannot use your own referral code' };
    }
    // 5. Read point values from Settings table
    const { refereePts, referrerPts } = await getReferralPointSettings(databases);
    log(`Referral points from settings — referee: ${refereePts}, referrer: ${referrerPts}`);
    // 6. Award points to referrer
    const referrerCurrentPts = referrerProfile.totalPoints || 0;
    await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, referrerProfile.$id, { totalPoints: referrerCurrentPts + referrerPts });
    log(`Awarded ${referrerPts} pts to referrer ${referrerProfile.$id}`);
    // 7. Award points to invitee and mark usedReferralCode
    const inviteeCurrentPts = inviteeProfile.totalPoints || 0;
    await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, inviteeProfile.$id, {
        totalPoints: inviteeCurrentPts + refereePts,
        usedReferralCode: referralCode,
    });
    log(`Awarded ${refereePts} pts to invitee ${inviteeProfile.$id}, set usedReferralCode`);
    // 8. Send push notification to referrer (best-effort)
    const notificationFunctionId = process.env.APPWRITE_NOTIFICATION_FUNCTION_ID;
    if (notificationFunctionId) {
        try {
            await functions.createExecution(notificationFunctionId, JSON.stringify({
                userId: referrerProfile.authID || referrerProfile.$id,
                points: referrerPts,
            }), false, '/send-referral-points-notification', ExecutionMethod.POST, { 'Content-Type': 'application/json' });
            log(`Referral notification sent to referrer ${referrerProfile.$id}`);
        }
        catch (notifErr) {
            const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
            log(`Failed to send referral notification (non-fatal): ${msg}`);
        }
    }
    else {
        log('APPWRITE_NOTIFICATION_FUNCTION_ID not set — skipping referral push notification');
    }
    return {
        success: true,
        referrerPtsAwarded: referrerPts,
        refereePtsAwarded: refereePts,
    };
}
// ============================================================================
// CONSTANTS
// ============================================================================
const DATABASE_ID = '69217af50038b9005a61';
const EVENTS_TABLE_ID = 'events';
const LOCATIONS_TABLE_ID = 'locations';
const CLIENTS_TABLE_ID = 'clients';
const TRIVIA_TABLE_ID = 'trivia';
const TRIVIA_RESPONSES_TABLE_ID = 'trivia_responses';
const POPUPS_TABLE_ID = 'popups';
const POPUP_INTERACTIONS_TABLE_ID = 'popup_interactions';
const USER_PROFILES_TABLE_ID = 'user_profiles';
const SETTINGS_TABLE_ID = 'settings';
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_PAGE = 1;
// ============================================================================
// EVENT FUNCTIONS
// ============================================================================
/**
 * Calculate distance between two coordinates using Haversine formula
 * @param lat1 Latitude of first point
 * @param lon1 Longitude of first point
 * @param lat2 Latitude of second point
 * @param lon2 Longitude of second point
 * @returns Distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRadians = (angle) => (Math.PI / 180) * angle;
    const R = 6371000; // Earth's radius in meters
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in meters
}
/**
 * Validate request body for events by location
 */
function validateEventsRequestBody(body) {
    if (!body || typeof body !== 'object') {
        throw new Error('Request body is required');
    }
    const bodyObj = body;
    if (typeof bodyObj.latitude !== 'number' || isNaN(bodyObj.latitude)) {
        throw new Error('latitude must be a valid number');
    }
    if (typeof bodyObj.longitude !== 'number' || isNaN(bodyObj.longitude)) {
        throw new Error('longitude must be a valid number');
    }
    if (bodyObj.latitude < -90 || bodyObj.latitude > 90) {
        throw new Error('latitude must be between -90 and 90');
    }
    if (bodyObj.longitude < -180 || bodyObj.longitude > 180) {
        throw new Error('longitude must be between -180 and 180');
    }
    const page = bodyObj.page !== undefined ? Number(bodyObj.page) : DEFAULT_PAGE;
    const pageSize = bodyObj.pageSize !== undefined
        ? Number(bodyObj.pageSize)
        : DEFAULT_PAGE_SIZE;
    if (page < 1 || !Number.isInteger(page)) {
        throw new Error('page must be a positive integer');
    }
    if (pageSize < 1 || !Number.isInteger(pageSize) || pageSize > 100) {
        throw new Error('pageSize must be a positive integer between 1 and 100');
    }
    return {
        latitude: bodyObj.latitude,
        longitude: bodyObj.longitude,
        page,
        pageSize,
    };
}
function parseLonLatFromGeoField(field) {
    if (!field) {
        return null;
    }
    if (Array.isArray(field) && field.length >= 2) {
        const lon = Number(field[0]);
        const lat = Number(field[1]);
        if (!isNaN(lon) && !isNaN(lat)) {
            return { lon, lat };
        }
    }
    if (typeof field === 'object' &&
        field !== null &&
        'coordinates' in field &&
        Array.isArray(field.coordinates) &&
        field.coordinates.length >= 2) {
        const coords = field.coordinates;
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!isNaN(lon) && !isNaN(lat)) {
            return { lon, lat };
        }
    }
    return null;
}
/** Prefer coordinates from the linked Location row so colocated stores are not conflated. */
function getEventCoordinatesForDistance(event, locationById) {
    const lid = typeof event.locationId === 'string' ? event.locationId.trim() : '';
    if (lid) {
        const locRow = locationById.get(lid);
        if (locRow) {
            const fromLoc = parseLonLatFromGeoField(locRow.location);
            if (fromLoc) {
                return fromLoc;
            }
        }
    }
    return parseLonLatFromGeoField(event.location);
}
async function loadClientDataForEvent(databases, event, log) {
    let clientData = null;
    if (!event.client) {
        return null;
    }
    try {
        if (typeof event.client === 'string') {
            const clientResponse = await databases.getDocument(DATABASE_ID, CLIENTS_TABLE_ID, event.client);
            clientData = clientResponse;
        }
        else if (event.client && typeof event.client === 'object') {
            const clientObj = event.client;
            if (clientObj.$id || clientObj.name) {
                clientData = clientObj;
            }
            else {
                const clientId = (clientObj.id || clientObj.$id);
                if (clientId && typeof clientId === 'string') {
                    const clientResponse = await databases.getDocument(DATABASE_ID, CLIENTS_TABLE_ID, clientId);
                    clientData = clientResponse;
                }
            }
        }
    }
    catch (err) {
        const clientInfo = typeof event.client === 'string'
            ? event.client
            : event.client?.$id ||
                JSON.stringify(event.client).substring(0, 50);
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Error fetching client ${clientInfo}: ${errorMessage}`);
    }
    return clientData;
}
/**
 * Validate request body for events pinned to a specific Location id (map / store detail).
 */
function validateGetEventsForLocationIdBody(body) {
    if (!body || typeof body !== 'object') {
        throw new Error('Request body is required');
    }
    const bodyObj = body;
    const locationId = typeof bodyObj.locationId === 'string' ? bodyObj.locationId.trim() : '';
    if (!locationId) {
        throw new Error('locationId must be a non-empty string');
    }
    const page = bodyObj.page !== undefined ? Number(bodyObj.page) : DEFAULT_PAGE;
    const pageSize = bodyObj.pageSize !== undefined
        ? Number(bodyObj.pageSize)
        : DEFAULT_PAGE_SIZE;
    if (page < 1 || !Number.isInteger(page)) {
        throw new Error('page must be a positive integer');
    }
    if (pageSize < 1 || !Number.isInteger(pageSize) || pageSize > 100) {
        throw new Error('pageSize must be a positive integer between 1 and 100');
    }
    return {
        locationId,
        page,
        pageSize,
    };
}
/**
 * Get events sorted by location
 */
async function getEventsByLocation(databases, userLat, userLon, page, pageSize, log) {
    // Get current date for filtering upcoming events
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayISO = today.toISOString();
    // Build queries for filtering events
    const queries = [
        Query.equal('isArchived', false),
        Query.equal('isHidden', false),
        Query.greaterThanEqual('date', todayISO),
        Query.orderAsc('date'),
        Query.select(['*', 'client.*']),
        Query.limit(1000),
    ];
    // Fetch all matching events
    const eventsResponse = await databases.listDocuments(DATABASE_ID, EVENTS_TABLE_ID, queries);
    const events = eventsResponse.documents;
    const locationIds = [
        ...new Set(events
            .map((e) => typeof e.locationId === 'string' ? e.locationId.trim() : '')
            .filter(Boolean)),
    ];
    const locationById = new Map();
    await Promise.all(locationIds.map(async (id) => {
        try {
            const doc = await databases.getDocument(DATABASE_ID, LOCATIONS_TABLE_ID, id);
            locationById.set(id, doc);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Could not load location ${id} for coordinate resolution: ${msg}`);
        }
    }));
    // Fetch client data for each event and calculate distances
    const eventsWithClients = [];
    for (const event of events) {
        let distance = Infinity;
        const coords = getEventCoordinatesForDistance(event, locationById);
        if (coords) {
            distance = haversineDistance(userLat, userLon, coords.lat, coords.lon);
        }
        const clientData = await loadClientDataForEvent(databases, event, log);
        eventsWithClients.push({
            ...event,
            client: clientData,
            distance,
        });
    }
    // Filter out events without valid event locations
    const validEvents = eventsWithClients.filter((event) => event.distance !== Infinity);
    // Sort by distance (nearest first)
    validEvents.sort((a, b) => a.distance - b.distance);
    // Calculate pagination
    const total = validEvents.length;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedEvents = validEvents.slice(startIndex, endIndex);
    return {
        events: paginatedEvents,
        pagination: {
            page,
            pageSize,
            total,
            totalPages,
        },
    };
}
/**
 * Upcoming events for a single Location (map pin / store). Uses `locationId` only — not
 * lat/long proximity — so colocated stores do not share each other's events.
 */
async function getEventsForLocationId(databases, locationId, page, pageSize, log) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayISO = today.toISOString();
    const queries = [
        Query.equal('isArchived', false),
        Query.equal('isHidden', false),
        Query.greaterThanEqual('date', todayISO),
        Query.equal('locationId', [locationId]),
        Query.orderAsc('date'),
        Query.select(['*', 'client.*']),
        Query.limit(1000),
    ];
    const eventsResponse = await databases.listDocuments(DATABASE_ID, EVENTS_TABLE_ID, queries);
    const events = eventsResponse.documents;
    const eventsWithClients = [];
    for (const event of events) {
        const clientData = await loadClientDataForEvent(databases, event, log);
        eventsWithClients.push({
            ...event,
            client: clientData,
            distance: 0,
        });
    }
    const total = eventsWithClients.length;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedEvents = eventsWithClients.slice(startIndex, endIndex);
    log(`getEventsForLocationId: ${locationId} -> ${total} upcoming event(s), page ${page}`);
    return {
        events: paginatedEvents,
        pagination: {
            page,
            pageSize,
            total,
            totalPages,
        },
    };
}
// ============================================================================
// TRIVIA FUNCTIONS
// ============================================================================
/**
 * Trivia availability gate.
 * Default behavior is enabled daily to support QA/testing and faster bug resolution.
 * Set TRIVIA_ONLY_TUESDAY_ET=true to restore Tuesday-only gating.
 */
function isTriviaAvailableNow(now = new Date()) {
    const enforceTuesdayOnly = String(process.env.TRIVIA_ONLY_TUESDAY_ET || '').toLowerCase() === 'true';
    if (!enforceTuesdayOnly) {
        return true;
    }
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
    }).format(now);
    return weekday === 'Tuesday';
}
/**
 * Get active trivia questions for a user
 * Returns trivia questions that are currently active and not yet answered by the user
 */
/** Max documents to fetch in getActiveTrivia to stay within function timeout */
const GET_ACTIVE_TRIVIA_LIMIT = 100;
const GET_ACTIVE_TRIVIA_RESPONSES_LIMIT = 500;
async function getActiveTrivia(databases, userId, log) {
    if (!isTriviaAvailableNow()) {
        log('Trivia is not available by current schedule configuration');
        return [];
    }
    const now = new Date().toISOString();
    // Fetch active trivia and user's responses in parallel to minimize execution time
    const [activeTriviaResponse, userResponsesResult] = await Promise.all([
        databases.listDocuments(DATABASE_ID, TRIVIA_TABLE_ID, [
            Query.lessThanEqual('startDate', now),
            Query.greaterThanEqual('endDate', now),
            Query.limit(GET_ACTIVE_TRIVIA_LIMIT),
        ]),
        databases.listDocuments(DATABASE_ID, TRIVIA_RESPONSES_TABLE_ID, [
            Query.equal('user', userId),
            Query.limit(GET_ACTIVE_TRIVIA_RESPONSES_LIMIT),
        ]),
    ]);
    log(`Found ${activeTriviaResponse.total} active trivia questions`);
    if (activeTriviaResponse.total === 0) {
        return [];
    }
    // Create a set of trivia IDs that the user has already answered
    const answeredTriviaIds = new Set();
    for (const response of userResponsesResult.documents) {
        const triviaRef = response.trivia;
        const triviaId = typeof triviaRef === 'string'
            ? triviaRef
            : triviaRef?.$id || triviaRef?.id;
        if (triviaId) {
            answeredTriviaIds.add(triviaId);
        }
    }
    log(`User has answered ${answeredTriviaIds.size} trivia questions`);
    // Filter out trivia that the user has already answered or skipped
    // Also remove correctOptionIndex from the response for security
    const unansweredTrivia = [];
    const triviaToIncrementViews = [];
    for (const trivia of activeTriviaResponse.documents) {
        const wasSkippedByUser = Array.isArray(trivia.skippedUsers) &&
            trivia.skippedUsers.includes(userId);
        if (!answeredTriviaIds.has(trivia.$id) && !wasSkippedByUser) {
            unansweredTrivia.push({
                $id: trivia.$id,
                question: trivia.question,
                answers: trivia.answers,
                startDate: trivia.startDate,
                endDate: trivia.endDate,
                points: trivia.points,
                client: trivia.client,
            });
            triviaToIncrementViews.push(trivia);
        }
    }
    // Increment views for each trivia returned (admin View column).
    // Uses the already-fetched trivia objects and runs updates in parallel to avoid
    // redundant getDocument calls that can fail due to relationship expansion issues.
    await Promise.allSettled(triviaToIncrementViews.map((trivia) => databases
        .updateDocument(DATABASE_ID, TRIVIA_TABLE_ID, trivia.$id, {
        views: (trivia.views ?? 0) + 1,
    })
        .catch((err) => log(`Failed to increment views for trivia ${trivia.$id}: ${String(err)}`))));
    log(`Returning ${unansweredTrivia.length} unanswered trivia questions`);
    return unansweredTrivia;
}
/**
 * Submit an answer for a trivia question
 * Creates a response record and awards points if correct
 */
async function submitTriviaAnswer(databases, userId, triviaId, answerIndex, log) {
    const now = new Date().toISOString();
    // 1. Get the trivia question and validate it exists
    let trivia;
    try {
        trivia = (await databases.getDocument(DATABASE_ID, TRIVIA_TABLE_ID, triviaId));
    }
    catch {
        throw { code: 404, message: 'Trivia question not found' };
    }
    // 2. Check if trivia is currently active
    const startDate = new Date(trivia.startDate);
    const endDate = new Date(trivia.endDate);
    const currentDate = new Date(now);
    if (currentDate < startDate || currentDate > endDate) {
        throw {
            code: 400,
            message: 'This trivia question is not currently active',
        };
    }
    if (!isTriviaAvailableNow()) {
        throw {
            code: 400,
            message: 'Trivia is not available right now',
        };
    }
    // 3. Validate the user exists
    try {
        await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId);
    }
    catch {
        throw { code: 404, message: 'User not found' };
    }
    // 4. Check if user has already answered this trivia
    const existingResponses = await databases.listDocuments(DATABASE_ID, TRIVIA_RESPONSES_TABLE_ID, [Query.equal('user', userId), Query.equal('trivia', triviaId)]);
    if (existingResponses.total > 0) {
        throw {
            code: 400,
            message: 'You have already answered this trivia question',
        };
    }
    // 5. Validate answerIndex is within bounds
    if (answerIndex < 0 || answerIndex >= trivia.answers.length) {
        throw {
            code: 400,
            message: `Invalid answer index. Must be between 0 and ${trivia.answers.length - 1}`,
        };
    }
    // 6. Check if answer is correct (coerce to number - DB may return string)
    const correctIndex = Number(trivia.correctOptionIndex);
    if (!Number.isInteger(correctIndex) ||
        correctIndex < 0 ||
        correctIndex >= trivia.answers.length) {
        log(`Invalid correctOptionIndex for trivia ${triviaId}: ${String(trivia.correctOptionIndex)} (answers length: ${trivia.answers.length})`);
        throw {
            code: 500,
            message: 'Trivia configuration error: invalid correct answer index',
        };
    }
    const isCorrect = Number(answerIndex) === correctIndex;
    const answerText = trivia.answers[answerIndex];
    // 7. Create the trivia response record
    await databases.createDocument(DATABASE_ID, TRIVIA_RESPONSES_TABLE_ID, ID.unique(), {
        trivia: triviaId,
        user: userId,
        answer: answerText,
        answerIndex: answerIndex,
    });
    log(`Created trivia response for user ${userId}, trivia ${triviaId}, isCorrect: ${isCorrect}`);
    // 8. If correct, award points to the user
    let pointsAwarded = 0;
    if (isCorrect) {
        pointsAwarded = trivia.points;
        // Get current user points
        const userDoc = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId);
        const currentPoints = Number(userDoc.totalPoints) || 0;
        const currentTriviasWon = Number(userDoc.triviasWon) || 0;
        await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId, {
            totalPoints: currentPoints + pointsAwarded,
            triviasWon: currentTriviasWon + 1,
        });
        log(`Awarded ${pointsAwarded} points to user ${userId}; triviasWon ${currentTriviasWon} -> ${currentTriviasWon + 1}`);
    }
    return {
        isCorrect,
        correctAnswerIndex: correctIndex,
        pointsAwarded,
        message: isCorrect
            ? `Correct! You earned ${pointsAwarded} points.`
            : 'Incorrect answer. Better luck next time!',
    };
}
/**
 * Record that a user skipped/dismissed a trivia question (no answer submitted).
 * Adds the user's profile ID to the trivia's skippedUsers array so it won't be shown again,
 * and returns the correctAnswerIndex so the client can reveal the correct answer in the
 * "Times Up" UI.
 */
async function dismissTrivia(databases, userId, triviaId, log) {
    try {
        await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId);
    }
    catch {
        throw { code: 404, message: 'User not found' };
    }
    if (!isTriviaAvailableNow()) {
        throw {
            code: 400,
            message: 'Trivia is not available right now',
        };
    }
    let trivia;
    try {
        trivia = (await databases.getDocument(DATABASE_ID, TRIVIA_TABLE_ID, triviaId));
    }
    catch {
        throw { code: 404, message: 'Trivia question not found' };
    }
    const correctIndex = Number(trivia.correctOptionIndex);
    const correctAnswerIndex = Number.isFinite(correctIndex) ? correctIndex : -1;
    const skippedUsers = Array.isArray(trivia.skippedUsers)
        ? [...trivia.skippedUsers]
        : [];
    if (skippedUsers.includes(userId)) {
        log(`User ${userId} already in skippedUsers for trivia ${triviaId}, no update`);
        return { correctAnswerIndex };
    }
    skippedUsers.push(userId);
    const updatePayload = {
        skippedUsers,
        skips: (trivia.skips ?? 0) + 1,
    };
    if (typeof trivia.skips === 'number') {
        updatePayload.skips = trivia.skips + 1;
    }
    await databases.updateDocument(DATABASE_ID, TRIVIA_TABLE_ID, triviaId, updatePayload);
    log(`Added user ${userId} to skippedUsers for trivia ${triviaId}`);
    return { correctAnswerIndex };
}
// ============================================================================
// POPUP FUNCTIONS (SAM-5)
// ============================================================================
const POPUP_APP_TIMEZONE = 'America/New_York';
const GET_ACTIVE_POPUPS_LIMIT = 100;
const POPUP_INTERACTIONS_TODAY_LIMIT = 200;
/**
 * One user's rows for one pop-up on one day. Normally a single row; each "Show again" adds
 * one more, so this only has to be larger than the number of resets a campaign can plausibly
 * receive in a day.
 */
const POPUP_USER_DAY_ROWS_LIMIT = 25;
/** Day key (YYYY-MM-DD) in the app timezone; one serve per user per popup per day key. */
function getPopupDayKey(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: POPUP_APP_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}
function computeAgeInYears(dobIso, now) {
    const dob = new Date(dobIso);
    if (isNaN(dob.getTime()))
        return null;
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
        age--;
    }
    return age;
}
/**
 * 21+ eligibility: requires the signup attestation (idAdult) AND, when a birthdate
 * exists and parses, a computed age of at least 21.
 */
function isUser21Plus(profile, now) {
    if (profile.idAdult !== true)
        return false;
    if (profile.dob) {
        const age = computeAgeInYears(profile.dob, now);
        if (age !== null && age < 21)
            return false;
    }
    return true;
}
/** Same tier names the Notification function targets. */
const POPUP_TIER_AUDIENCE_MAP = {
    Tier1: 'NewbieSampler',
    Tier2: 'SampleFan',
    Tier3: 'SuperSampler',
    Tier4: 'VIS',
    Tier5: 'SampleMaster',
};
const POPUP_NEW_USERS_DEFAULT_DAYS = 30;
/** Serve-time inversion of the notification audience resolution: does THIS user match? */
function popupAudienceMatches(popup, profile, now) {
    const audience = popup.targetAudience || 'All';
    switch (audience) {
        case 'All':
            return true;
        case 'NewUsers': {
            const days = typeof popup.newUsersTimeRange === 'number' && popup.newUsersTimeRange > 0
                ? popup.newUsersTimeRange
                : POPUP_NEW_USERS_DEFAULT_DAYS;
            const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
            const createdMs = new Date(profile.$createdAt).getTime();
            return Number.isFinite(createdMs) && createdMs >= cutoffMs;
        }
        case 'BrandAmbassadors':
            return profile.isAmbassador === true;
        case 'Influencers':
            return profile.isInfluencer === true;
        case 'Tier1':
        case 'Tier2':
        case 'Tier3':
        case 'Tier4':
        case 'Tier5':
            return (profile.tierLevel || 'NewbieSampler') === POPUP_TIER_AUDIENCE_MAP[audience];
        case 'ZipCode':
            return (Array.isArray(popup.selectedZipCodes) &&
                !!profile.zipCode &&
                popup.selectedZipCodes.includes(profile.zipCode));
        case 'Targeted':
            return (Array.isArray(popup.selectedUserIds) &&
                popup.selectedUserIds.includes(profile.$id));
        default: {
            // Exhaustiveness guard: every PopupAudience must be handled above, so a new
            // enum value fails the build here instead of silently serving to nobody.
            // Unknown runtime values still fall through to the safe "no match" default.
            const _exhaustive = audience;
            void _exhaustive;
            return false;
        }
    }
}
function extractRelId(ref) {
    if (!ref)
        return undefined;
    return typeof ref === 'string' ? ref : ref.$id;
}
/**
 * Gates a single popup for a user, deliberately excluding the already-served-today
 * rule — that rule belongs to the caller. A fetch filters on it; a view report uses
 * it as an idempotency key instead, so a repeat view is a no-op rather than a refusal.
 */
function popupIsEligibleForUser(popup, profile, now) {
    const nowMs = now.getTime();
    if (new Date(popup.startDate).getTime() > nowMs)
        return false;
    if (new Date(popup.endDate).getTime() < nowMs)
        return false;
    // only21Plus defaults to true; treat missing as gated (safe default for ads).
    if (popup.only21Plus !== false && !isUser21Plus(profile, now))
        return false;
    return popupAudienceMatches(popup, profile, now);
}
/**
 * Does this recorded impression still count as "already served today"?
 *
 * An admin can re-open a campaign to users who have already seen it ("Show again"), at two
 * scopes: `popups.interactionsResetAt` re-opens it for everyone in a single write, and a
 * row's own `resetAt` re-opens it for that one user. Nothing is ever deleted, so the report
 * keeps every impression it has already counted and a user shown a banner twice counts twice.
 *
 * Every place that asks "has this user seen it today?" must agree on this answer, or the
 * pop-up is served forever: the view report would keep finding the reset row, call it a
 * duplicate, and never write the fresh row the fetch gate is waiting for.
 *
 * Timestamps are parsed rather than compared as strings: `shownAt` and `interactionsResetAt`
 * both come back from Appwrite, but a column default or a hand-written value can carry a
 * different offset spelling, and lexicographic order is wrong across formats.
 */
function interactionCountsAsServed(row, popup) {
    if (row.resetAt)
        return false;
    if (popup.interactionsResetAt && row.shownAt) {
        const resetAtMs = Date.parse(popup.interactionsResetAt);
        const shownAtMs = Date.parse(row.shownAt);
        if (Number.isFinite(resetAtMs) && Number.isFinite(shownAtMs) && shownAtMs < resetAtMs) {
            return false;
        }
    }
    return true;
}
/** Newest first, so a click lands on the impression it belongs to. */
function sortRowsByShownAtDesc(rows) {
    return [...rows].sort((a, b) => (Date.parse(b.shownAt ?? '') || 0) - (Date.parse(a.shownAt ?? '') || 0));
}
/**
 * Drop pop-ups whose in-app destination the app cannot open.
 *
 * The client's `fetchEventById` returns null for an archived or hidden event, so the CTA
 * navigates to a dead "Event not found" screen. The admin picker refuses to select such an
 * event, but that is not enough on its own: an event can be archived, hidden or deleted long
 * after the pop-up was saved. Enforcing it here also reaches builds already in the field,
 * which no admin-side change can.
 *
 * The banner is dropped whole rather than served without its link — the tap is the entire
 * point of an event pop-up, and a served banner costs an impression.
 *
 * One query resolves every distinct destination; `GET_ACTIVE_POPUPS_LIMIT` caps that at 100
 * ids, well inside what an equality query accepts. If the events table cannot be read, the
 * batch is served unchanged: a transient failure must not blank a live campaign.
 */
async function dropPopupsWithUnopenableEvent(databases, popups, log) {
    const eventIds = [
        ...new Set(popups
            .filter((p) => p.destinationType === 'event')
            .map((p) => p.destinationEventId)
            .filter((id) => !!id)),
    ];
    if (eventIds.length === 0)
        return popups;
    const openable = new Set();
    try {
        const result = await databases.listDocuments(DATABASE_ID, EVENTS_TABLE_ID, [
            Query.equal('$id', eventIds),
            Query.equal('isArchived', false),
            Query.equal('isHidden', false),
            Query.limit(eventIds.length),
        ]);
        for (const row of result.documents)
            openable.add(row.$id);
    }
    catch (err) {
        log(`Could not verify pop-up destinations, serving them unchecked: ${String(err)}`);
        return popups;
    }
    return popups.filter((popup) => {
        if (popup.destinationType !== 'event')
            return true;
        if (popup.destinationEventId && openable.has(popup.destinationEventId))
            return true;
        log(`Dropping popup ${popup.$id}: destination event ${popup.destinationEventId ?? '(unset)'} is missing, archived or hidden`);
        return false;
    });
}
/**
 * Get pop-ups to show this user right now.
 *
 * When `clientReportsViews` is false (builds already in the field, which cannot
 * report for themselves) serving still records the impression, as it always did.
 * When true, this is a pure read: the client calls /record-popup-view once the
 * banner is genuinely on screen, so a pop-up fetched but never displayed is no
 * longer burned for the rest of the day.
 */
async function getActivePopups(databases, userId, clientReportsViews, log) {
    const now = new Date();
    const nowIso = now.toISOString();
    const dayKey = getPopupDayKey(now);
    let profile;
    try {
        profile = (await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId));
    }
    catch {
        throw { code: 404, message: 'User not found' };
    }
    const [activePopupsResult, todaysInteractionsResult] = await Promise.all([
        databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
            Query.lessThanEqual('startDate', nowIso),
            Query.greaterThanEqual('endDate', nowIso),
            // Oldest campaign first. Legacy builds are handed exactly one pop-up per
            // fetch, so this ordering decides which one they get; leaving it to the
            // backend's default ordering made that choice implicit.
            Query.orderAsc('$createdAt'),
            Query.limit(GET_ACTIVE_POPUPS_LIMIT),
        ]),
        databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
            Query.equal('user', userId),
            Query.equal('dayKey', dayKey),
            Query.limit(POPUP_INTERACTIONS_TODAY_LIMIT),
        ]),
    ]);
    log(`Popups: ${activePopupsResult.total} active, user has ${todaysInteractionsResult.total} interactions for ${dayKey}`);
    // Grouped rather than reduced to a set of ids: whether a row closes today's door
    // depends on the pop-up it belongs to (see interactionCountsAsServed).
    const todaysRowsByPopup = new Map();
    for (const row of todaysInteractionsResult.documents) {
        const popupId = extractRelId(row.popup);
        if (!popupId)
            continue;
        const rows = todaysRowsByPopup.get(popupId);
        if (rows)
            rows.push(row);
        else
            todaysRowsByPopup.set(popupId, [row]);
    }
    const user21Plus = isUser21Plus(profile, now);
    const eligible = [];
    for (const popup of activePopupsResult.documents) {
        const todaysRows = todaysRowsByPopup.get(popup.$id);
        if (todaysRows?.some((row) => interactionCountsAsServed(row, popup)))
            continue;
        if (!popupIsEligibleForUser(popup, profile, now))
            continue;
        eligible.push(popup);
    }
    // Legacy clients only: serve == impression, so every pop-up handed over is
    // consumed whether or not it reaches the screen. These builds render one at a
    // time from an in-memory queue, so handing them the whole batch is what burned
    // the rest of the day's pop-ups. Give them exactly one and let the next fetch
    // deliver the next — slower, but nothing is lost. New clients report on display
    // and get the full list.
    // Before the slice below, not after: a pop-up pointing at an archived event would
    // otherwise consume a legacy build's single pop-up per fetch and show nothing for it.
    const deliverable = await dropPopupsWithUnopenableEvent(databases, eligible, log);
    const served = clientReportsViews ? deliverable : deliverable.slice(0, 1);
    if (!clientReportsViews) {
        await Promise.allSettled(served.map(async (popup) => {
            try {
                await databases.createDocument(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, ID.unique(), {
                    popup: popup.$id,
                    user: userId,
                    dayKey,
                    shownAt: nowIso,
                    is21Plus: user21Plus,
                });
                await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popup.$id, {
                    views: (popup.views ?? 0) + 1,
                });
            }
            catch (err) {
                log(`Failed to record popup serve for ${popup.$id}: ${String(err)}`);
            }
        }));
    }
    log(`Returning ${served.length} of ${eligible.length} eligible popups (${eligible.length - deliverable.length} dropped for an unopenable destination) (${clientReportsViews ? 'client reports views' : 'legacy: one per fetch, recorded on serve'})`);
    return served.map((p) => ({
        $id: p.$id,
        title: p.title ?? null,
        imageUrl: p.imageUrl,
        link: p.link ?? null,
        description: p.description ?? null,
        destinationType: p.destinationType === 'event' ? 'event' : 'external',
        destinationEventId: p.destinationType === 'event' ? p.destinationEventId ?? null : null,
    }));
}
/**
 * Record that a pop-up was actually displayed. Idempotent per user/popup/day:
 * an existing row IS the dedup key, so a re-render or a retry cannot double-count.
 */
async function recordPopupView(databases, userId, popupId, log) {
    const now = new Date();
    const nowIso = now.toISOString();
    const dayKey = getPopupDayKey(now);
    let profile;
    try {
        profile = (await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId));
    }
    catch {
        throw { code: 404, message: 'User not found' };
    }
    let popup;
    try {
        popup = (await databases.getDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId));
    }
    catch {
        throw { code: 404, message: 'Popup not found' };
    }
    // Never take the client's word that this pop-up was theirs to see.
    if (!popupIsEligibleForUser(popup, profile, now)) {
        throw { code: 403, message: 'Popup is not eligible for this user' };
    }
    // Every row for today, not just the first: after a "Show again" the user legitimately has
    // more than one, and only the ones that still count make this a duplicate.
    const existing = await databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
        Query.equal('user', userId),
        Query.equal('popup', popupId),
        Query.equal('dayKey', dayKey),
        Query.limit(POPUP_USER_DAY_ROWS_LIMIT),
    ]);
    const alreadyCounted = existing.documents.some((row) => interactionCountsAsServed(row, popup));
    if (alreadyCounted) {
        log(`Popup ${popupId} already recorded for ${userId} on ${dayKey}`);
        return { alreadyViewed: true };
    }
    await databases.createDocument(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, ID.unique(), {
        popup: popupId,
        user: userId,
        dayKey,
        shownAt: nowIso,
        is21Plus: isUser21Plus(profile, now),
    });
    await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId, {
        views: (popup.views ?? 0) + 1,
    });
    log(`Recorded popup view ${popupId} for ${userId} on ${dayKey}`);
    return { alreadyViewed: false };
}
/**
 * Record a banner tap. `clicks` on the popup doc counts UNIQUE clickers:
 * it is incremented only when this user has never clicked this popup before.
 */
async function recordPopupClick(databases, userId, popupId, log) {
    const now = new Date();
    const nowIso = now.toISOString();
    const dayKey = getPopupDayKey(now);
    let profile;
    try {
        profile = (await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, userId));
    }
    catch {
        throw { code: 404, message: 'User not found' };
    }
    let popup;
    try {
        popup = (await databases.getDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId));
    }
    catch {
        throw { code: 404, message: 'Popup not found' };
    }
    const [previousClicksResult, todaysRowsResult] = await Promise.all([
        databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
            Query.equal('user', userId),
            Query.equal('popup', popupId),
            Query.equal('clicked', true),
            Query.limit(1),
        ]),
        databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
            Query.equal('user', userId),
            Query.equal('popup', popupId),
            Query.equal('dayKey', dayKey),
            Query.limit(POPUP_USER_DAY_ROWS_LIMIT),
        ]),
    ]);
    const hadClickedBefore = previousClicksResult.total > 0;
    // The click belongs to the impression the user is looking at, which is the newest row that
    // still counts. A row left behind by a "Show again" must not absorb it, or the click would
    // be attached to a banner the user closed hours ago.
    const todaysRow = sortRowsByShownAtDesc(todaysRowsResult.documents.filter((row) => interactionCountsAsServed(row, popup)))[0];
    if (todaysRow) {
        if (todaysRow.clicked !== true) {
            await databases.updateDocument(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, todaysRow.$id, { clicked: true, clickedAt: nowIso });
        }
    }
    else {
        // No row this click can belong to: the app-TZ day rolled over while the modal stayed
        // open, or a "Show again" retired today's row. Record the click on a fresh row rather
        // than losing it.
        await databases.createDocument(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, ID.unique(), {
            popup: popupId,
            user: userId,
            dayKey,
            shownAt: nowIso,
            clicked: true,
            clickedAt: nowIso,
            is21Plus: isUser21Plus(profile, now),
        });
    }
    if (!hadClickedBefore) {
        await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId, {
            clicks: (popup.clicks ?? 0) + 1,
        });
        log(`First click by user ${userId} on popup ${popupId}; clicks incremented`);
    }
    return { alreadyClicked: hadClickedBefore };
}
/**
 * Re-open a campaign to users who have already seen it today ("Show again" in the admin).
 *
 * Two scopes share one meaning — "impressions older than this no longer close today's door":
 *  - without a userId, one write on the pop-up itself, so the cost is the same whether ten
 *    users or ten thousand have seen it, and no viewer's row has to be touched;
 *  - with a userId, that user's rows for today are stamped instead and nobody else is
 *    affected.
 *
 * The pop-up-level marker needs no cleanup: tomorrow's rows are newer than it, so it stops
 * mattering by itself once the day rolls over.
 */
async function resetPopupInteractions(databases, popupId, userId, log) {
    const now = new Date();
    const nowIso = now.toISOString();
    try {
        await databases.getDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId);
    }
    catch {
        throw { code: 404, message: 'Popup not found' };
    }
    if (!userId) {
        await databases.updateDocument(DATABASE_ID, POPUPS_TABLE_ID, popupId, {
            interactionsResetAt: nowIso,
        });
        log(`Popup ${popupId} re-opened for every user as of ${nowIso}`);
        return { scope: 'all', affected: 1 };
    }
    const dayKey = getPopupDayKey(now);
    const rows = await databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, [
        Query.equal('user', userId),
        Query.equal('popup', popupId),
        Query.equal('dayKey', dayKey),
        Query.limit(POPUP_USER_DAY_ROWS_LIMIT),
    ]);
    let affected = 0;
    for (const row of rows.documents) {
        // Already retired: leave the original timestamp, which is when it was actually retired.
        if (row.resetAt)
            continue;
        await databases.updateDocument(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, row.$id, { resetAt: nowIso });
        affected++;
    }
    log(`Popup ${popupId} re-opened for user ${userId}: ${affected} of ${rows.total} row(s) for ${dayKey} retired`);
    return { scope: 'user', affected };
}
/**
 * Gate for endpoints only the admin panel may call.
 *
 * This function's execute permission is `any`, which is what the mobile app's own session
 * calls need, but it would also let anyone on the internet replay a campaign. Appwrite passes
 * the caller's id in `x-appwrite-user-id` for a session-authenticated execution and leaves it
 * empty otherwise, so the caller's `admin` label — the same label the popups table itself is
 * permissioned on — is the check. Scoped deliberately to the new endpoint: the existing ones
 * are unchanged.
 */
async function requireAdminCaller(users, headers, log) {
    const callerId = headers['x-appwrite-user-id'];
    if (!callerId) {
        // Says which half failed: an anonymous call, versus a signed-in caller without the label.
        log('Rejected admin-only request: no x-appwrite-user-id header on the execution');
        throw { code: 401, message: 'Authentication required' };
    }
    let labels = [];
    try {
        const caller = await users.get(callerId);
        labels = caller.labels ?? [];
    }
    catch {
        throw { code: 401, message: 'Authentication required' };
    }
    if (!labels.includes('admin')) {
        log(`Rejected admin-only request from ${callerId} (labels: ${labels.join(', ') || 'none'})`);
        throw { code: 403, message: 'Admin access required' };
    }
}
// ============================================================================
// USER STATUS MANAGEMENT FUNCTION
// ============================================================================
/**
 * Update user status (block/unblock) in both Appwrite Auth and user profile.
 * This is a server-side-only operation because updating user status in Appwrite Auth
 * requires an API key with appropriate permissions.
 *
 * It will:
 * 1. Update the user status in Appwrite Auth (enable/disable the account)
 * 2. Update the isBlocked field in the user_profiles collection
 */
async function updateUserStatus(users, databases, userId, block, log) {
    log(`Starting user status update for user: ${userId}, block: ${block}`);
    try {
        // 1. Verify the user exists in Auth
        try {
            await users.get(userId);
            log(`User ${userId} found in Auth`);
        }
        catch {
            throw { code: 404, message: 'User not found in authentication system' };
        }
        // 2. Update user status in Appwrite Auth
        // When block=true, set status to false (disabled)
        // When block=false, set status to true (enabled)
        log(`Updating user auth status to: ${!block ? 'enabled' : 'disabled'}`);
        await users.updateStatus(userId, !block);
        log(`User auth status updated successfully`);
        // 3. Update user profile isBlocked field
        try {
            log(`Attempting to find user profile by authID: ${userId}`);
            const profileQuery = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId)]);
            log(`Profile query completed. Total found: ${profileQuery.total}`);
            if (profileQuery.total === 0) {
                throw { code: 404, message: 'User profile not found' };
            }
            // Update the profile document
            const profile = profileQuery.documents[0];
            log(`Updating user profile document: ${profile.$id}`);
            await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, profile.$id, { isBlocked: block });
            log(`User profile updated successfully`);
        }
        catch (profileError) {
            const typedProfileError = profileError;
            log(`Error updating profile: ${typedProfileError.message || 'Unknown error'}`);
            // If profile update fails, revert the auth status
            await users.updateStatus(userId, block);
            throw {
                code: 500,
                message: `Failed to update user profile: ${typedProfileError.message || 'Unknown error'}`,
            };
        }
        return {
            success: true,
            message: block
                ? 'User successfully blocked'
                : 'User successfully unblocked',
        };
    }
    catch (err) {
        const typedErr = err;
        log(`Error during user status update: ${typedErr.message || 'Unknown error'}`);
        throw typedErr;
    }
}
// ============================================================================
// CREATE USER FUNCTION
// ============================================================================
/**
 * Create a new user in both Appwrite Auth and user_profiles collection.
 * Requires server-side execution as creating Auth users needs users.write scope.
 */
async function createUser(users, databases, data, log) {
    log(`Creating user: ${data.email}`);
    try {
        // 1. Check if email already exists in Auth
        const existingByEmail = await users.list([
            Query.equal('email', data.email),
        ]);
        if (existingByEmail.total > 0) {
            throw {
                code: 409,
                message: 'A user with this email already exists. Please use a different email.',
            };
        }
        // 2. Check if phone already exists (when provided)
        if (data.phoneNumber?.trim()) {
            const phoneFormatted = `+1${data.phoneNumber.replace(/\D/g, '')}`;
            if (phoneFormatted.length >= 12) {
                const existingByPhone = await users.list([
                    Query.equal('phone', phoneFormatted),
                ]);
                if (existingByPhone.total > 0) {
                    throw {
                        code: 409,
                        message: 'A user with this phone number already exists. Please use a different email or phone.',
                    };
                }
            }
        }
        // 3. Validate username uniqueness if provided
        if (data.username?.trim()) {
            const existingByUsername = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('username', data.username.trim())]);
            if (existingByUsername.total > 0) {
                throw {
                    code: 409,
                    message: 'Username already exists. Please choose a different username.',
                };
            }
        }
        // 4. Create Auth user (node-appwrite v14 uses positional params: userId, email, phone, password, name)
        const userId = ID.unique();
        const name = [data.firstname, data.lastname].filter(Boolean).join(' ').trim() || '';
        await users.create(userId, data.email, data.phoneNumber ? `+1${data.phoneNumber.replace(/\D/g, '')}` : undefined, data.password, name || undefined);
        log(`Auth user created: ${userId}`);
        // 5. Create user profile
        const referralCode = await generateUniqueReferralCode(databases);
        const profileData = {
            authID: userId,
            firstname: data.firstname || '',
            lastname: data.lastname || '',
            username: data.username || '',
            phoneNumber: data.phoneNumber || '',
            role: data.role || 'user',
            tierLevel: data.tierLevel || '',
            isBlocked: false,
            idAdult: true,
            referralCode,
            // Welcome bonus: match mobile signup so admin-created users start with
            // the tier minimum (typically 100) instead of 0.
            totalPoints: typeof data.totalPoints === 'number' ? data.totalPoints : 100,
            ...(data.zipCode?.trim() ? { zipCode: data.zipCode.trim() } : {}),
            ...(data.avatarURL?.trim() ? { avatarURL: data.avatarURL.trim() } : {}),
            ...(data.dob?.trim()
                ? {
                    dob: data.dob.trim().length === 10
                        ? `${data.dob.trim()}T00:00:00.000Z`
                        : data.dob.trim(),
                }
                : {}),
        };
        const profile = await databases.createDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, ID.unique(), profileData);
        log(`User profile created: ${profile.$id}`);
        return {
            success: true,
            userId,
            profileId: profile.$id,
        };
    }
    catch (err) {
        const typedErr = err;
        log(`Error creating user: ${typedErr.message || 'Unknown error'}`);
        throw typedErr;
    }
}
// ============================================================================
// PUBLIC SIGNUP AVAILABILITY CHECK
// ============================================================================
const getPhoneDigits = (value) => value.replace(/\D/g, '');
async function checkUsernamePhoneAvailability(_users, databases, data, log) {
    const result = {};
    const rawUsername = typeof data.username === 'string' ? data.username.trim() : '';
    const rawPhone = typeof data.phoneNumber === 'string' ? data.phoneNumber.trim() : '';
    if (!rawUsername && !rawPhone) {
        throw { code: 400, message: 'username or phoneNumber is required' };
    }
    if (rawUsername) {
        const usernameLower = rawUsername.toLowerCase();
        const usernameResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.limit(1000)]);
        result.usernameExists = usernameResult.documents.some((doc) => {
            const docUsername = typeof doc.username === 'string' ? doc.username.toLowerCase() : '';
            return docUsername === usernameLower;
        });
    }
    if (rawPhone) {
        const targetDigits = getPhoneDigits(rawPhone);
        if (!targetDigits) {
            result.phoneExists = false;
        }
        else {
            // Use profiles table because mobile signup creates Auth user without phone.
            const phoneResult = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.limit(1000)]);
            result.phoneExists = phoneResult.documents.some((doc) => {
                const profilePhone = typeof doc.phoneNumber === 'string' ? doc.phoneNumber : '';
                return getPhoneDigits(profilePhone) === targetDigits;
            });
        }
    }
    log(`[check-username-phone-availability] usernameChecked=${Boolean(rawUsername)} phoneChecked=${Boolean(rawPhone)}`);
    return result;
}
// ============================================================================
// ACCOUNT DELETION FUNCTION
// ============================================================================
/**
 * Delete user account from Appwrite Auth
 * This function should be called when a user wants to delete their account
 * It will:
 * 1. Delete the user from Appwrite Auth first (which is only possible from server-side)
 * 2. Then delete the user profile from database (best effort)
 * 3. This will also cascade delete all related auth data (sessions, tokens, etc.)
 */
async function deleteUserAccount(users, databases, userId, log) {
    log(`Starting account deletion for user: ${userId}`);
    try {
        // 1. Verify the user exists
        try {
            await users.get(userId);
            log(`User ${userId} found in Auth`);
        }
        catch {
            throw { code: 404, message: 'User not found in authentication system' };
        }
        // 2. Delete the user from Appwrite Auth FIRST
        // This will automatically delete all sessions, tokens, and related auth data
        // This is the most important step - if this fails, the user can still sign in
        log(`Deleting user from Appwrite Auth: ${userId}`);
        await users.delete(userId);
        log(`User ${userId} successfully deleted from Appwrite Auth`);
        // 3. Find and delete user profile from database (best effort - don't fail if this doesn't work)
        // Note: The user profile document ID is different from the auth user ID
        // We need to query by the 'authID' field to find the profile document
        try {
            log(`Attempting to find user profile by authID: ${userId}`);
            log(`Database ID: ${DATABASE_ID}, Table ID: ${USER_PROFILES_TABLE_ID}`);
            // Query for the user profile document where authID matches the user's auth ID
            const profileQuery = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId)]);
            log(`Profile query completed. Total found: ${profileQuery.total}`);
            if (profileQuery.total === 0) {
                log(`No user profile found with authID: ${userId} - auth deletion already completed successfully`);
            }
            else {
                log(`Found ${profileQuery.total} profile(s) to delete`);
                // Delete the profile document(s) - there should only be one, but handle multiple just in case
                for (const profile of profileQuery.documents) {
                    log(`Profile document details: ID=${profile.$id}, authID=${profile.authID || 'N/A'}`);
                    log(`Attempting to delete user profile document: ${profile.$id}`);
                    await databases.deleteDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, profile.$id);
                    log(`User profile deleted successfully: ${profile.$id}`);
                }
                log(`Deleted ${profileQuery.total} user profile(s) from database`);
            }
        }
        catch (profileError) {
            // Log the error but don't fail the entire operation since Auth user is already deleted
            const typedProfileError = profileError;
            log(`Warning: Error during profile deletion process (Auth user already deleted)`);
            log(`Error type: ${typedProfileError.constructor?.name || 'Unknown'}`);
            log(`Error message: ${typedProfileError.message || 'N/A'}`);
            log(`Error code: ${typedProfileError.code || 'N/A'}`);
            log(`Error type field: ${typedProfileError.type || 'N/A'}`);
            log(`Full error details: ${JSON.stringify({
                message: typedProfileError.message,
                code: typedProfileError.code,
                type: typedProfileError.type,
                response: typedProfileError.response,
            })}`);
            log(`Profile deletion failed but auth deletion succeeded - user cannot sign in anymore`);
        }
        return {
            success: true,
            message: 'Account successfully deleted',
        };
    }
    catch (err) {
        const typedErr = err;
        log(`Error during account deletion: ${typedErr.message || 'Unknown error'}`);
        throw typedErr;
    }
}
// ============================================================================
// USER LOOKUP (for password recovery)
// ============================================================================
/**
 * Get user ID by email address.
 * Searches Appwrite Auth for a user with the specified email address.
 */
async function getUserByEmail(users, email, log) {
    log(`Searching for user with email: ${email}`);
    try {
        const trimmedEmail = email.trim().toLowerCase();
        if (!trimmedEmail) {
            throw { code: 400, message: 'Email is required' };
        }
        log(`Querying users with email: ${trimmedEmail}`);
        const result = await users.list([Query.equal('email', trimmedEmail)]);
        log(`Query completed. Total users found: ${result.total}`);
        if (result.total === 0) {
            throw { code: 404, message: 'User not found with this email address' };
        }
        const user = result.users[0];
        log(`User found: ${user.$id}`);
        return {
            userId: user.$id,
            name: user.name,
            emailVerification: user.emailVerification,
        };
    }
    catch (err) {
        const typedErr = err;
        log(`Error during user lookup: ${typedErr.message || 'Unknown error'}`);
        throw typedErr;
    }
}
// ============================================================================
// PASSWORD RESET AFTER OTP
// ============================================================================
/**
 * Verify the OTP by creating a session with Appwrite's client API.
 * This ensures only a valid, non-expired OTP is accepted (e.g. latest after Resend).
 * Does not use API key so Appwrite validates the token and rejects expired/invalid.
 */
async function verifyEmailOTP(endpoint, projectId, userId, otp, log) {
    const url = `${endpoint.replace(/\/v1\/?$/, '')}/v1/account/sessions/token`;
    log(`Verifying OTP for user ${userId} via ${url}`);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Appwrite-Project': projectId,
        },
        body: JSON.stringify({ userId, secret: otp }),
    });
    if (!res.ok) {
        const text = await res.text();
        log(`OTP verification failed: ${res.status} ${text}`);
        if (res.status === 401 || res.status === 400 || res.status === 404) {
            throw {
                code: 400,
                message: 'Invalid or expired code. Please request a new password reset.',
            };
        }
        throw {
            code: 400,
            message: 'Invalid or expired code. Please request a new password reset.',
        };
    }
}
/**
 * Reset user password after OTP verification.
 * Verifies the OTP with Appwrite (rejects expired/invalid); then updates the password using server-side permissions.
 * Validates that the new password is not the same as the user's username.
 */
async function resetPasswordAfterOTP(users, databases, endpoint, projectId, userId, otp, newPassword, log) {
    log(`Resetting password for user: ${userId}`);
    if (!userId || !otp || !newPassword) {
        throw { code: 400, message: 'userId, otp and newPassword are required' };
    }
    if (newPassword.length < 8) {
        throw { code: 400, message: 'Password must be at least 8 characters long' };
    }
    await verifyEmailOTP(endpoint, projectId, userId, otp, log);
    try {
        const profileQuery = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('authID', userId)]);
        if (profileQuery.total > 0) {
            const username = profileQuery.documents[0].username ?? '';
            if (username &&
                newPassword.trim().toLowerCase() === username.trim().toLowerCase()) {
                throw { code: 400, message: 'Password Cannot be same as Username' };
            }
        }
        log(`Updating password with server-side permissions`);
        await users.updatePassword(userId, newPassword);
        log(`Password updated successfully for user: ${userId}`);
    }
    catch (err) {
        const typedErr = err;
        if (typedErr.code === 400 && typedErr.message) {
            throw typedErr;
        }
        log(`Error updating password: ${typedErr.message || 'Unknown error'}`);
        throw {
            code: 400,
            message: 'Failed to update password. Please try again.',
        };
    }
}
// ============================================================================
// MAIN HANDLER
// ============================================================================
export default async function handler({ req, res, log, error, }) {
    try {
        // Initialize Appwrite client
        const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
            'https://nyc.cloud.appwrite.io/v1';
        const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID || '691d4a54003b21bf0136';
        const apiKey = process.env.APPWRITE_FUNCTION_KEY ||
            process.env.APPWRITE_API_KEY ||
            req.headers['x-appwrite-key'] ||
            req.headers['x-appwrite-function-key'] ||
            '';
        if (!apiKey) {
            error('API key is missing');
            return res.json({
                success: false,
                error: 'Server configuration error: API key missing',
            }, 500);
        }
        const client = new Client()
            .setEndpoint(endpoint)
            .setProject(projectId)
            .setKey(apiKey);
        const databases = new Databases(client);
        const users = new Users(client);
        const appwriteFunctions = new Functions(client);
        // ========================================================================
        // PING ENDPOINT
        // ========================================================================
        if (req.path === '/ping') {
            return res.text('Pong');
        }
        // ========================================================================
        // EVENT ENDPOINTS
        // ========================================================================
        // GET events by location
        if (req.path === '/get-events-by-location' && req.method === 'POST') {
            log('Processing get-events-by-location request');
            let requestBody;
            try {
                requestBody = validateEventsRequestBody(req.body);
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error
                    ? validationError.message
                    : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({
                    success: false,
                    error: errorMessage,
                }, 400);
            }
            log(`Fetching events for location: (${requestBody.latitude}, ${requestBody.longitude}), page: ${requestBody.page}, pageSize: ${requestBody.pageSize}`);
            const result = await getEventsByLocation(databases, requestBody.latitude, requestBody.longitude, requestBody.page, requestBody.pageSize, log);
            log(`Found ${result.pagination.total} events, returning ${result.events.length} for page ${result.pagination.page}`);
            return res.json({
                success: true,
                ...result,
            });
        }
        // Upcoming events for one store / map pin (filters by events.locationId)
        if (req.path === '/get-events-for-location-id' && req.method === 'POST') {
            log('Processing get-events-for-location-id request');
            let requestBody;
            try {
                requestBody = validateGetEventsForLocationIdBody(req.body);
            }
            catch (validationError) {
                const errorMessage = validationError instanceof Error
                    ? validationError.message
                    : String(validationError);
                error(`Validation error: ${errorMessage}`);
                return res.json({
                    success: false,
                    error: errorMessage,
                }, 400);
            }
            const result = await getEventsForLocationId(databases, requestBody.locationId, requestBody.page, requestBody.pageSize, log);
            return res.json({
                success: true,
                ...result,
            });
        }
        // ========================================================================
        // TRIVIA ENDPOINTS
        // ========================================================================
        // GET active trivia for user
        if (req.path === '/get-active-trivia' && req.method === 'POST') {
            log('Processing get-active-trivia request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({
                    success: false,
                    error: 'userId is required',
                }, 400);
            }
            const activeTrivia = await getActiveTrivia(databases, body.userId, log);
            return res.json({
                success: true,
                trivia: activeTrivia,
                count: activeTrivia.length,
            });
        }
        // SUBMIT trivia answer
        if (req.path === '/submit-answer' && req.method === 'POST') {
            log('Processing submit-answer request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({
                    success: false,
                    error: 'userId is required',
                }, 400);
            }
            if (!body.triviaId) {
                return res.json({
                    success: false,
                    error: 'triviaId is required',
                }, 400);
            }
            if (body.answerIndex === undefined || body.answerIndex === null) {
                return res.json({
                    success: false,
                    error: 'answerIndex is required',
                }, 400);
            }
            if (typeof body.answerIndex !== 'number' || body.answerIndex < 0) {
                return res.json({
                    success: false,
                    error: 'answerIndex must be a non-negative number',
                }, 400);
            }
            try {
                const result = await submitTriviaAnswer(databases, body.userId, body.triviaId, body.answerIndex, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // DISMISS trivia (user skipped / closed without answering)
        if (req.path === '/dismiss-trivia' && req.method === 'POST') {
            log('Processing dismiss-trivia request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({ success: false, error: 'userId is required' }, 400);
            }
            if (!body.triviaId) {
                return res.json({ success: false, error: 'triviaId is required' }, 400);
            }
            try {
                const dismissResult = await dismissTrivia(databases, body.userId, body.triviaId, log);
                return res.json({ success: true, ...dismissResult });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code != null && typedErr.message) {
                    return res.json({ success: false, error: typedErr.message }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // POPUP ENDPOINTS (SAM-5)
        // ========================================================================
        // GET active popups for user (serving also records the impression)
        if (req.path === '/get-active-popups' && req.method === 'POST') {
            log('Processing get-active-popups request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({ success: false, error: 'userId is required' }, 400);
            }
            try {
                const popups = await getActivePopups(databases, body.userId, body.clientReportsViews === true, log);
                return res.json({ success: true, popups, count: popups.length });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code != null && typedErr.message) {
                    return res.json({ success: false, error: typedErr.message }, typedErr.code);
                }
                throw err;
            }
        }
        // RECORD popup view (banner actually rendered on screen)
        if (req.path === '/record-popup-view' && req.method === 'POST') {
            log('Processing record-popup-view request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({ success: false, error: 'userId is required' }, 400);
            }
            if (!body.popupId) {
                return res.json({ success: false, error: 'popupId is required' }, 400);
            }
            try {
                const result = await recordPopupView(databases, body.userId, body.popupId, log);
                return res.json({ success: true, ...result });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code != null && typedErr.message) {
                    return res.json({ success: false, error: typedErr.message }, typedErr.code);
                }
                throw err;
            }
        }
        // RECORD popup click (banner tapped; opens link in browser client-side)
        if (req.path === '/record-popup-click' && req.method === 'POST') {
            log('Processing record-popup-click request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({ success: false, error: 'userId is required' }, 400);
            }
            if (!body.popupId) {
                return res.json({ success: false, error: 'popupId is required' }, 400);
            }
            try {
                const result = await recordPopupClick(databases, body.userId, body.popupId, log);
                return res.json({ success: true, ...result });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code != null && typedErr.message) {
                    return res.json({ success: false, error: typedErr.message }, typedErr.code);
                }
                throw err;
            }
        }
        // RESET popup interactions ("Show again"): admin-only, everyone or one user
        if (req.path === '/reset-popup-interactions' && req.method === 'POST') {
            log('Processing reset-popup-interactions request');
            const body = req.body;
            if (!body || !body.popupId) {
                return res.json({ success: false, error: 'popupId is required' }, 400);
            }
            try {
                await requireAdminCaller(users, req.headers, log);
                const result = await resetPopupInteractions(databases, body.popupId, body.userId, log);
                return res.json({ success: true, ...result });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code != null && typedErr.message) {
                    return res.json({ success: false, error: typedErr.message }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // ACCOUNT DELETION ENDPOINT
        // ========================================================================
        // DELETE user account
        if (req.path === '/delete-account' && req.method === 'POST') {
            log('Processing delete-account request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({
                    success: false,
                    error: 'userId is required',
                }, 400);
            }
            try {
                const result = await deleteUserAccount(users, databases, body.userId, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // CREATE USER ENDPOINT
        // ========================================================================
        if (req.path === '/create-user' && req.method === 'POST') {
            log('Processing create-user request');
            const body = req.body;
            if (!body || !body.email || !body.password) {
                return res.json({
                    success: false,
                    error: 'email and password are required',
                }, 400);
            }
            if (body.password.length < 8) {
                return res.json({
                    success: false,
                    error: 'Password must be at least 8 characters',
                }, 400);
            }
            try {
                const result = await createUser(users, databases, body, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        if (req.path === '/check-username-phone-availability' &&
            req.method === 'POST') {
            log('Processing check-username-phone-availability request');
            const body = (req.body || {});
            try {
                const result = await checkUsernamePhoneAvailability(users, databases, body, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // USER STATUS MANAGEMENT
        // ========================================================================
        // UPDATE user status (block/unblock)
        if (req.path === '/update-user-status' && req.method === 'POST') {
            log('Processing update-user-status request');
            const body = req.body;
            if (!body || !body.userId || typeof body.block !== 'boolean') {
                return res.json({
                    success: false,
                    error: 'userId and block (boolean) are required',
                }, 400);
            }
            try {
                const result = await updateUserStatus(users, databases, body.userId, body.block, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // USER LOOKUP (password recovery)
        // ========================================================================
        if (req.path === '/get-user-by-email' && req.method === 'POST') {
            log('Processing get-user-by-email request');
            const body = req.body;
            if (!body || !body.email) {
                return res.json({
                    success: false,
                    error: 'email is required',
                }, 400);
            }
            try {
                const result = await getUserByEmail(users, body.email, log);
                return res.json({
                    success: true,
                    ...result,
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // PASSWORD RESET AFTER OTP
        // ========================================================================
        if (req.path === '/reset-password-after-otp' && req.method === 'POST') {
            log('Processing reset-password-after-otp request');
            const body = req.body;
            if (!body || !body.userId || !body.otp || !body.newPassword) {
                return res.json({
                    success: false,
                    error: 'userId, otp and newPassword are required',
                }, 400);
            }
            try {
                await resetPasswordAfterOTP(users, databases, endpoint, projectId, body.userId, body.otp, body.newPassword, log);
                return res.json({
                    success: true,
                    message: 'Password reset successfully',
                });
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // APPLY REFERRAL ENDPOINT
        // ========================================================================
        if (req.path === '/apply-referral' && req.method === 'POST') {
            log('Processing apply-referral request');
            const body = req.body;
            if (!body || !body.userId || !body.referralCode) {
                return res.json({
                    success: false,
                    error: 'userId and referralCode are required',
                }, 400);
            }
            try {
                const result = await applyReferral(databases, appwriteFunctions, body, log);
                return res.json(result);
            }
            catch (err) {
                const typedErr = err;
                if (typedErr.code && typedErr.message) {
                    return res.json({
                        success: false,
                        error: typedErr.message,
                    }, typedErr.code);
                }
                throw err;
            }
        }
        // ========================================================================
        // DEFAULT RESPONSE
        // ========================================================================
        return res.json({
            success: false,
            error: 'Invalid endpoint. Available endpoints: POST /get-events-by-location, POST /get-events-for-location-id, POST /get-active-trivia, POST /submit-answer, POST /dismiss-trivia, POST /create-user, POST /check-username-phone-availability, POST /delete-account, POST /update-user-status, POST /get-user-by-email, POST /reset-password-after-otp, POST /apply-referral, GET /ping',
        });
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Internal server error';
        error(`Function error: ${errorMessage}`);
        console.error('Function error:', err);
        return res.json({
            success: false,
            error: errorMessage,
        }, 500);
    }
}
