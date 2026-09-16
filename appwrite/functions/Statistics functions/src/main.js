import { Client, Databases, Query, Users } from 'node-appwrite';
// Constants
const DATABASE_ID = '69217af50038b9005a61';
const CLIENTS_TABLE_ID = 'clients';
const USER_PROFILES_TABLE_ID = 'user_profiles';
const REVIEWS_TABLE_ID = 'reviews';
const TRIVIA_TABLE_ID = 'trivia';
const CHECKINS_TABLE_ID = 'checkins';
const NOTIFICATIONS_TABLE_ID = 'notifications';
const POPUPS_TABLE_ID = 'popups';
const POPUP_INTERACTIONS_TABLE_ID = 'popup_interactions';
// Tier thresholds
const TIER_THRESHOLDS = [
    { level: 5, name: 'SampleMaster', minPoints: 100000 },
    { level: 4, name: 'VIS', minPoints: 25000 },
    { level: 3, name: 'SuperSampler', minPoints: 5000 },
    { level: 2, name: 'SampleFan', minPoints: 1000 },
    { level: 1, name: 'NewbieSampler', minPoints: 0 },
];
/**
 * Calculate tier based on points
 */
function getTierFromPoints(points) {
    for (const tier of TIER_THRESHOLDS) {
        if (points >= tier.minPoints) {
            return { level: tier.level, name: tier.name };
        }
    }
    return { level: 1, name: 'NewbieSampler' };
}
/**
 * Get date range for this month
 */
function getThisMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}
/**
 * Get date range for last month
 */
function getLastMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}
/**
 * Get date range for this week
 */
function getThisWeekRange() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Monday
    const start = new Date(now.setDate(diff));
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}
/**
 * Calculate percentage change
 */
function calculateChange(current, previous) {
    if (previous === 0)
        return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
}
// listDocuments returns only 25 rows when no Query.limit is given — never
// rely on that default when aggregating across a whole table.
const USER_SCAN_PAGE_SIZE = 100;
// How many Auth user IDs to resolve per users.list call in /get-user-emails.
// Appwrite rejects an equality query carrying more than 500 values, so stay
// well under that; 100 keeps each request small while collapsing what used to
// be 100 separate round trips into one.
const AUTH_LOOKUP_CHUNK_SIZE = 100;
/**
 * Sum lifetime points across every user profile.
 *
 * user_profiles.totalPoints is the canonical points counter — signup bonus,
 * referrals, trivia, check-ins and reviews all increment it — so aggregate
 * stats must read it directly instead of reconstructing from per-source
 * tables (which misses referral/signup/trivia points entirely).
 * Exported for scripts/verify-avg-points.mjs.
 */
export async function sumUserTotalPoints(databases) {
    let sum = 0;
    let cursor = null;
    for (;;) {
        const queries = [
            Query.limit(USER_SCAN_PAGE_SIZE),
            Query.select(['$id', 'totalPoints']),
        ];
        if (cursor) {
            queries.push(Query.cursorAfter(cursor));
        }
        const page = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, queries);
        for (const profile of page.documents) {
            sum += profile.totalPoints || 0;
        }
        if (page.documents.length < USER_SCAN_PAGE_SIZE)
            break;
        cursor = page.documents[page.documents.length - 1].$id;
    }
    return sum;
}
/**
 * Get Dashboard Statistics
 */
async function getDashboardStats(databases, log) {
    try {
        // Get last month range for comparisons
        const lastMonth = getLastMonthRange();
        // Total Clients/Brands
        const clientsResponse = await databases.listDocuments(DATABASE_ID, CLIENTS_TABLE_ID);
        const totalClientsBrands = clientsResponse.total;
        // Total Users
        const usersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID);
        const totalUsers = usersResponse.total;
        // Total Points Awarded - sum of the canonical lifetime counter on
        // user_profiles (covers signup bonus, referrals, trivia, check-ins, reviews)
        const totalPointsAwarded = await sumUserTotalPoints(databases);
        // Average PPU (Points Per User)
        const averagePPU = totalUsers > 0 ? Math.round(totalPointsAwarded / totalUsers) : 0;
        // Total Check-ins - only the count is needed
        const checkinsResponse = await databases.listDocuments(DATABASE_ID, CHECKINS_TABLE_ID, [Query.limit(1)]);
        const totalCheckins = checkinsResponse.total;
        // Reviews count - only the count is needed
        const reviewsResponse = await databases.listDocuments(DATABASE_ID, REVIEWS_TABLE_ID, [Query.limit(1)]);
        const reviews = reviewsResponse.total;
        // Calculate changes (comparing this month vs last month)
        // For simplicity, we'll use current totals vs previous month totals
        // In a real scenario, you'd filter by date ranges
        const lastMonthClientsResponse = await databases.listDocuments(DATABASE_ID, CLIENTS_TABLE_ID, [Query.lessThanEqual('$createdAt', lastMonth.end)]);
        const lastMonthTotalClients = lastMonthClientsResponse.total;
        const lastMonthUsersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.lessThanEqual('$createdAt', lastMonth.end)]);
        const lastMonthTotalUsers = lastMonthUsersResponse.total;
        return {
            totalClientsBrands,
            totalPointsAwarded,
            totalUsers,
            averagePPU,
            totalCheckins,
            reviews,
            totalClientsBrandsChange: calculateChange(totalClientsBrands, lastMonthTotalClients),
            totalUsersChange: calculateChange(totalUsers, lastMonthTotalUsers),
            // For other metrics, you'd need to calculate based on date ranges
            // For now, we'll set them to 0 or calculate if needed
            totalPointsAwardedChange: 0,
            averagePPUChange: 0,
            totalCheckinsChange: 0,
            reviewsChange: 0,
        };
    }
    catch (error) {
        log(`Error getting dashboard stats: ${error.message}`);
        throw error;
    }
}
/**
 * Get Clients/Brands Statistics
 */
async function getClientsStats(databases, log) {
    try {
        const thisMonth = getThisMonthRange();
        // Total Clients
        const clientsResponse = await databases.listDocuments(DATABASE_ID, CLIENTS_TABLE_ID);
        const totalClients = clientsResponse.total;
        // New This Month
        const newClientsResponse = await databases.listDocuments(DATABASE_ID, CLIENTS_TABLE_ID, [
            Query.greaterThanEqual('$createdAt', thisMonth.start),
            Query.lessThanEqual('$createdAt', thisMonth.end),
        ]);
        const newThisMonth = newClientsResponse.total;
        return {
            totalClients,
            newThisMonth,
        };
    }
    catch (error) {
        log(`Error getting clients stats: ${error.message}`);
        throw error;
    }
}
/**
 * Get Users Statistics
 */
async function getUsersStats(databases, log) {
    try {
        const thisWeek = getThisWeekRange();
        // Total Users
        const usersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID);
        const totalUsers = usersResponse.total;
        // New This Week
        const newUsersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [
            Query.greaterThanEqual('$createdAt', thisWeek.start),
            Query.lessThanEqual('$createdAt', thisWeek.end),
        ]);
        const newThisWeek = newUsersResponse.total;
        // Users in Blacklist (isBlocked = true)
        const blockedUsersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.equal('isBlocked', true)]);
        const usersInBlacklist = blockedUsersResponse.total;
        // Avg Points - average of the canonical lifetime counter on user_profiles
        const totalPoints = await sumUserTotalPoints(databases);
        const avgPoints = totalUsers > 0 ? Math.round(totalPoints / totalUsers) : 0;
        return {
            totalUsers,
            avgPoints,
            newThisWeek,
            usersInBlacklist,
        };
    }
    catch (error) {
        log(`Error getting users stats: ${error.message}`);
        throw error;
    }
}
/**
 * Get Notifications Statistics
 */
async function getNotificationsStats(databases, log) {
    try {
        // Total Sent: count documents with status = 'Sent'
        const sentResponse = await databases.listDocuments(DATABASE_ID, NOTIFICATIONS_TABLE_ID, [Query.equal('status', 'Sent')]);
        const totalSent = sentResponse.total;
        // Scheduled: count documents with status = 'Scheduled'
        const scheduledResponse = await databases.listDocuments(DATABASE_ID, NOTIFICATIONS_TABLE_ID, [Query.equal('status', 'Scheduled')]);
        const scheduled = scheduledResponse.total;
        // Avg Open Rate and Click Rate
        // These would typically come from notification tracking fields
        // For now, we'll return placeholder values
        // In production, you'd calculate these from notification metadata
        const avgOpenRate = 65; // Placeholder - calculate from actual data
        const avgClickRate = 48; // Placeholder - calculate from actual data
        return {
            totalSent,
            avgOpenRate,
            avgClickRate,
            scheduled,
        };
    }
    catch (error) {
        log(`Error getting notifications stats: ${error.message}`);
        throw error;
    }
}
/**
 * Get Trivia Statistics
 */
async function getTriviaStats(databases, log) {
    try {
        const now = new Date();
        const nowISO = now.toISOString();
        // Total Quizzes
        const triviaResponse = await databases.listDocuments(DATABASE_ID, TRIVIA_TABLE_ID);
        const totalQuizzes = triviaResponse.total;
        // Scheduled (startDate > now)
        const scheduledResponse = await databases.listDocuments(DATABASE_ID, TRIVIA_TABLE_ID, [Query.greaterThan('startDate', nowISO)]);
        const scheduled = scheduledResponse.total;
        // Active (startDate <= now AND endDate >= now)
        const activeResponse = await databases.listDocuments(DATABASE_ID, TRIVIA_TABLE_ID, [
            Query.lessThanEqual('startDate', nowISO),
            Query.greaterThanEqual('endDate', nowISO),
        ]);
        const active = activeResponse.total;
        // Completed (endDate < now)
        const completedResponse = await databases.listDocuments(DATABASE_ID, TRIVIA_TABLE_ID, [Query.lessThan('endDate', nowISO)]);
        const completed = completedResponse.total;
        return {
            totalQuizzes,
            scheduled,
            active,
            completed,
        };
    }
    catch (error) {
        log(`Error getting trivia stats: ${error.message}`);
        throw error;
    }
}
/**
 * Get Popups list statistics (counts by schedule status), mirroring getTriviaStats.
 */
async function getPopupsStats(databases, log) {
    try {
        const nowISO = new Date().toISOString();
        const [totalResponse, scheduledResponse, activeResponse, completedResponse] = await Promise.all([
            databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID),
            databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
                Query.greaterThan('startDate', nowISO),
            ]),
            databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
                Query.lessThanEqual('startDate', nowISO),
                Query.greaterThanEqual('endDate', nowISO),
            ]),
            databases.listDocuments(DATABASE_ID, POPUPS_TABLE_ID, [
                Query.lessThan('endDate', nowISO),
            ]),
        ]);
        return {
            totalPopups: totalResponse.total,
            scheduled: scheduledResponse.total,
            active: activeResponse.total,
            completed: completedResponse.total,
        };
    }
    catch (error) {
        log(`Error getting popups stats: ${error.message}`);
        throw error;
    }
}
/**
 * Per-popup detail stats aggregated from popup_interactions rows (cursor-paginated).
 * uniqueClickers/clickers21Plus dedupe by user; ctr = uniqueClickers / uniqueUsersShown.
 */
async function getPopupDetailStats(databases, popupId, log) {
    const PAGE_SIZE = 500;
    /** Hard cap on USERS returned to the admin, so a long campaign can't blow up the response. */
    const VIEWER_CAP = 1000;
    const PROFILE_LOOKUP_CHUNK_SIZE = 100;
    const shownUsers = new Set();
    const clickedUsers = new Set();
    const clickers21Plus = new Set();
    /**
     * One entry per USER, not per sighting (SAM-12). A repeat viewer bumps `impressions`
     * rather than adding a row, which is also what lets VIEWER_CAP bound unique users: every
     * user the admin is shown carries an exact count, instead of counts that quietly stop
     * once 1000 raw interactions have been read.
     */
    const byUser = new Map();
    let viewersTruncated = false;
    let totalImpressions = 0;
    let cursor;
    try {
        for (;;) {
            // Newest first, so the VIEWER_CAP below keeps the most RECENT rows.
            // Walking ascending and stopping at the cap would keep the oldest, which
            // is the opposite of what the admin table says it is showing.
            const queries = [
                // `popupId` rather than the `popup` relationship: Appwrite will not index a
                // relationship attribute, so only this form can use idx_popupid_created.
                Query.equal('popupId', popupId),
                Query.orderDesc('$createdAt'),
                Query.limit(PAGE_SIZE),
            ];
            if (cursor) {
                queries.push(Query.cursorAfter(cursor));
            }
            const page = await databases.listDocuments(DATABASE_ID, POPUP_INTERACTIONS_TABLE_ID, queries);
            for (const row of page.documents) {
                totalImpressions++;
                const userRef = row.user;
                const userId = row.userId ?? (typeof userRef === 'string' ? userRef : userRef?.$id);
                if (!userId)
                    continue;
                shownUsers.add(userId);
                if (row.clicked === true) {
                    clickedUsers.add(userId);
                    if (row.is21Plus === true) {
                        clickers21Plus.add(userId);
                    }
                }
                // The unique counts above are campaign-wide and deliberately uncapped; only the
                // per-user LIST below is bounded, so the stat cards stay right on a huge campaign
                // even when the table cannot name everyone.
                let agg = byUser.get(userId);
                if (!agg) {
                    if (byUser.size >= VIEWER_CAP) {
                        viewersTruncated = true;
                        continue;
                    }
                    // Rows arrive newest first, so the row that creates the entry is this user's most
                    // recent: its age gate is the right seed for the one below that never sees a
                    // usable shownAt.
                    agg = {
                        userId,
                        impressions: 0,
                        firstShownAt: null,
                        firstShownAtMs: NaN,
                        lastShownAt: null,
                        lastShownAtMs: NaN,
                        clickedAt: null,
                        clickedAtMs: NaN,
                        dayKeys: new Set(),
                        is21Plus: row.is21Plus === true,
                    };
                    byUser.set(userId, agg);
                }
                agg.impressions++;
                if (row.dayKey)
                    agg.dayKeys.add(row.dayKey);
                // Parsed, never string-compared: see the note on ViewerAggregate. An unparseable
                // timestamp is ignored for ordering rather than being treated as the epoch, which
                // would otherwise make it win every "earliest sighting" comparison.
                const shownAt = row.shownAt ?? null;
                const shownAtMs = shownAt ? Date.parse(shownAt) : NaN;
                if (shownAt && Number.isFinite(shownAtMs)) {
                    if (!Number.isFinite(agg.firstShownAtMs) || shownAtMs < agg.firstShownAtMs) {
                        agg.firstShownAt = shownAt;
                        agg.firstShownAtMs = shownAtMs;
                    }
                    if (!Number.isFinite(agg.lastShownAtMs) || shownAtMs > agg.lastShownAtMs) {
                        agg.lastShownAt = shownAt;
                        agg.lastShownAtMs = shownAtMs;
                        // The age gate is whatever it was at the LATEST sighting: a user who turned 21
                        // mid-campaign should not be reported as under 21 forever.
                        agg.is21Plus = row.is21Plus === true;
                    }
                }
                const clickedAt = row.clickedAt ?? null;
                const clickedAtMs = clickedAt ? Date.parse(clickedAt) : NaN;
                if (clickedAt &&
                    Number.isFinite(clickedAtMs) &&
                    (!Number.isFinite(agg.clickedAtMs) || clickedAtMs > agg.clickedAtMs)) {
                    agg.clickedAt = clickedAt;
                    agg.clickedAtMs = clickedAtMs;
                }
            }
            if (page.documents.length < PAGE_SIZE)
                break;
            cursor = page.documents[page.documents.length - 1].$id;
        }
        const uniqueUsersShown = shownUsers.size;
        const uniqueClickers = clickedUsers.size;
        const ctr = uniqueUsersShown > 0
            ? Math.round((uniqueClickers / uniqueUsersShown) * 10000) / 10000
            : 0;
        // Resolve display names in batches rather than one read per row.
        const profileIds = Array.from(byUser.keys());
        const profileMap = new Map();
        for (let i = 0; i < profileIds.length; i += PROFILE_LOOKUP_CHUNK_SIZE) {
            const chunk = profileIds.slice(i, i + PROFILE_LOOKUP_CHUNK_SIZE);
            try {
                const page = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [
                    Query.equal('$id', chunk),
                    Query.limit(chunk.length),
                ]);
                for (const doc of page.documents) {
                    profileMap.set(doc.$id, {
                        name: [doc.firstname, doc.lastname].filter(Boolean).join(' ').trim(),
                        username: doc.username ?? '',
                    });
                }
            }
            catch (err) {
                // A bad id rejects the whole chunk; the rows still render by id below.
                log(`Popup viewer profile batch failed for ${chunk.length} ids: ${err.message}`);
            }
        }
        const viewers = Array.from(byUser.values())
            .map((r) => {
            const profile = profileMap.get(r.userId);
            return {
                userId: r.userId,
                // A deleted profile still gets a row — falling back to the id beats
                // dropping the impressions from the report entirely.
                name: profile?.name || profile?.username || r.userId,
                username: profile?.username ?? '',
                impressions: r.impressions,
                firstShownAt: r.firstShownAt,
                lastShownAt: r.lastShownAt,
                clickedAt: r.clickedAt,
                // Sorted so the admin's date filter and any eyeballing of the payload read in
                // calendar order rather than the order rows happened to be paged in.
                dayKeys: Array.from(r.dayKeys).sort(),
                is21Plus: r.is21Plus,
            };
        })
            // Most recently seen first, parsed rather than string-compared for the reason above.
            // A user with no usable sighting timestamp sorts last instead of leading the list.
            .sort((a, b) => {
            const aMs = a.lastShownAt ? Date.parse(a.lastShownAt) : NaN;
            const bMs = b.lastShownAt ? Date.parse(b.lastShownAt) : NaN;
            const aMissing = !Number.isFinite(aMs);
            const bMissing = !Number.isFinite(bMs);
            if (aMissing || bMissing)
                return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
            return bMs - aMs;
        });
        return {
            totalImpressions,
            uniqueUsersShown,
            uniqueClickers,
            clickers21Plus: clickers21Plus.size,
            ctr,
            viewers,
            viewersTruncated,
        };
    }
    catch (error) {
        log(`Error getting popup detail stats for ${popupId}: ${error.message}`);
        throw error;
    }
}
// Main function handler
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler({ req, res, log, error }) {
    try {
        // Initialize Appwrite client
        const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
            'https://nyc.cloud.appwrite.io/v1';
        const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID || '691d4a54003b21bf0136';
        // Prioritize custom APPWRITE_API_KEY for full scopes, fallback to function key
        const apiKey = process.env.APPWRITE_API_KEY ||
            process.env.APPWRITE_FUNCTION_KEY ||
            req.headers['x-appwrite-key'] ||
            req.headers['x-appwrite-function-key'] ||
            '';
        // Debug logging to identify which key is being used
        log(`API Key source: ${process.env.APPWRITE_API_KEY ? 'APPWRITE_API_KEY' : process.env.APPWRITE_FUNCTION_KEY ? 'APPWRITE_FUNCTION_KEY' : 'headers or empty'}`);
        log(`API Key present: ${apiKey ? 'yes (length: ' + apiKey.length + ')' : 'no'}`);
        if (!apiKey) {
            error('API key is missing');
            return res.json({
                success: false,
                error: 'Server configuration error: API key missing. Please set APPWRITE_API_KEY environment variable.',
            }, 500);
        }
        const client = new Client()
            .setEndpoint(endpoint)
            .setProject(projectId)
            .setKey(apiKey);
        const databases = new Databases(client);
        // Handle ping endpoint
        if (req.path === '/ping') {
            return res.text('Pong');
        }
        // Handle get statistics endpoint
        if (req.path === '/get-statistics' && req.method === 'POST') {
            log('Processing get-statistics request');
            // Parse and validate request body
            const body = req.body;
            if (!body || !body.page) {
                return res.json({
                    success: false,
                    error: 'page parameter is required. Valid values: dashboard, clients, users, notifications, trivia, popups',
                }, 400);
            }
            const validPages = [
                'dashboard',
                'clients',
                'users',
                'notifications',
                'trivia',
                'popups',
            ];
            if (!validPages.includes(body.page)) {
                return res.json({
                    success: false,
                    error: `Invalid page parameter. Valid values: ${validPages.join(', ')}`,
                }, 400);
            }
            log(`Fetching statistics for page: ${body.page}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let statistics;
            switch (body.page) {
                case 'dashboard':
                    statistics = await getDashboardStats(databases, log);
                    break;
                case 'clients':
                    statistics = await getClientsStats(databases, log);
                    break;
                case 'users':
                    statistics = await getUsersStats(databases, log);
                    break;
                case 'notifications':
                    statistics = await getNotificationsStats(databases, log);
                    break;
                case 'trivia':
                    statistics = await getTriviaStats(databases, log);
                    break;
                case 'popups':
                    statistics = body.popupId
                        ? await getPopupDetailStats(databases, String(body.popupId), log)
                        : await getPopupsStats(databases, log);
                    break;
                default:
                    return res.json({
                        success: false,
                        error: 'Invalid page parameter',
                    }, 400);
            }
            log(`Successfully fetched statistics for ${body.page}`);
            return res.json({
                success: true,
                page: body.page,
                statistics,
            });
        }
        // Handle get user emails endpoint (also returns last login dates)
        if (req.path === '/get-user-emails' && req.method === 'POST') {
            log('Processing get-user-emails request');
            const body = req.body;
            if (!body || !body.authIDs || !Array.isArray(body.authIDs)) {
                return res.json({
                    success: false,
                    error: 'authIDs array is required',
                }, 400);
            }
            const users = new Users(client);
            const emailMap = {};
            const lastLoginMap = {};
            // Fetch in batches via users.list, NOT one users.get per authID.
            //
            // The per-ID loop this replaces was the admin panel's dominant cost: each Auth
            // API call is a separate round trip, so a 25-ID request serialised 25 of them.
            // Measured in production, this endpoint ran at p50 3.6s / p90 12.8s per
            // execution, and a single Users-page search (which needs emails for every
            // profile) fanned out to 27 executions — ~20s of waiting, ~77s when the
            // search was refined. Query.equal('$id', [...]) resolves a whole batch in one
            // round trip instead.
            //
            // It also lost data. This function's timeout is 15s, and 16% of those executions
            // (97 of 596 sampled) hit it and returned a 500; the caller treats a failed
            // execution as "no emails", so those users showed a blank email and last-login
            // and could not be found by an email search.
            //
            // IDs that no longer exist in Auth are simply absent from the response, which
            // matches the old per-ID behaviour of skipping on error.
            for (let i = 0; i < body.authIDs.length; i += AUTH_LOOKUP_CHUNK_SIZE) {
                const chunk = body.authIDs.slice(i, i + AUTH_LOOKUP_CHUNK_SIZE);
                try {
                    const page = await users.list([
                        Query.equal('$id', chunk),
                        Query.limit(chunk.length),
                    ]);
                    for (const user of page.users) {
                        if (user.email) {
                            emailMap[user.$id] = user.email;
                        }
                        // accessedAt is the last time the user accessed the app
                        if (user.accessedAt) {
                            lastLoginMap[user.$id] = user.accessedAt;
                        }
                    }
                }
                catch (err) {
                    // Batch failed (e.g. a malformed ID rejects the whole query) — fall back to
                    // per-ID lookups for this chunk only, so one bad ID can't blank out the rest.
                    log(`Batch lookup failed for ${chunk.length} authIDs, falling back per-ID: ${err.message}`);
                    for (const authID of chunk) {
                        try {
                            const user = await users.get(authID);
                            if (user?.email)
                                emailMap[authID] = user.email;
                            if (user?.accessedAt)
                                lastLoginMap[authID] = user.accessedAt;
                        }
                        catch (innerErr) {
                            log(`Could not fetch user ${authID}: ${innerErr.message}`);
                        }
                    }
                }
            }
            log(`Successfully fetched ${Object.keys(emailMap).length} emails and ${Object.keys(lastLoginMap).length} last login dates`);
            return res.json({
                success: true,
                emails: emailMap,
                lastLogins: lastLoginMap,
            });
        }
        // Handle block user endpoint
        if (req.path === '/block-user' && req.method === 'POST') {
            log('Processing block-user request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({
                    success: false,
                    error: 'userId is required',
                }, 400);
            }
            try {
                const users = new Users(client);
                // Get user profile to find authID
                const userProfile = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId);
                const authID = userProfile.authID;
                if (!authID) {
                    return res.json({
                        success: false,
                        error: 'User does not have an associated auth account',
                    }, 400);
                }
                // Update isBlocked in user_profiles
                await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId, { isBlocked: true });
                // Block user in Appwrite Auth (status false = blocked)
                await users.updateStatus(authID, false);
                // Delete all sessions to force logout
                await users.deleteSessions(authID);
                log(`Successfully blocked user ${body.userId} (authID: ${authID})`);
                return res.json({
                    success: true,
                    message: 'User blocked successfully',
                    userId: body.userId,
                });
            }
            catch (err) {
                log(`Error blocking user: ${err.message}`);
                return res.json({
                    success: false,
                    error: err.message,
                }, 500);
            }
        }
        // Handle unblock user endpoint
        if (req.path === '/unblock-user' && req.method === 'POST') {
            log('Processing unblock-user request');
            const body = req.body;
            if (!body || !body.userId) {
                return res.json({
                    success: false,
                    error: 'userId is required',
                }, 400);
            }
            try {
                const users = new Users(client);
                // Get user profile to find authID
                const userProfile = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId);
                const authID = userProfile.authID;
                if (!authID) {
                    return res.json({
                        success: false,
                        error: 'User does not have an associated auth account',
                    }, 400);
                }
                // Update isBlocked in user_profiles
                await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId, { isBlocked: false });
                // Unblock user in Appwrite Auth (status true = active)
                await users.updateStatus(authID, true);
                log(`Successfully unblocked user ${body.userId} (authID: ${authID})`);
                return res.json({
                    success: true,
                    message: 'User unblocked successfully',
                    userId: body.userId,
                });
            }
            catch (err) {
                log(`Error unblocking user: ${err.message}`);
                return res.json({
                    success: false,
                    error: err.message,
                }, 500);
            }
        }
        // Handle update user tier endpoint
        if (req.path === '/update-user-tier' && req.method === 'POST') {
            log('Processing update-user-tier request');
            const body = req.body;
            if (body.userId) {
                // Update single user
                try {
                    const user = await databases.getDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId);
                    const totalPoints = user.totalPoints || 0;
                    const tier = getTierFromPoints(totalPoints);
                    await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, body.userId, { tierLevel: tier.name });
                    log(`Updated user ${body.userId} to tier ${tier.name} (${totalPoints} points)`);
                    return res.json({
                        success: true,
                        userId: body.userId,
                        totalPoints,
                        tierLevel: tier.name,
                        tierNumber: tier.level,
                    });
                }
                catch (err) {
                    log(`Error updating user tier: ${err.message}`);
                    return res.json({
                        success: false,
                        error: err.message,
                    }, 400);
                }
            }
            else {
                // Update all users
                let updatedCount = 0;
                let offset = 0;
                const limit = 100;
                while (true) {
                    const usersResponse = await databases.listDocuments(DATABASE_ID, USER_PROFILES_TABLE_ID, [Query.limit(limit), Query.offset(offset)]);
                    if (usersResponse.documents.length === 0)
                        break;
                    for (const user of usersResponse.documents) {
                        const totalPoints = user.totalPoints || 0;
                        const tier = getTierFromPoints(totalPoints);
                        const currentTier = user.tierLevel || '';
                        // Only update if tier changed
                        if (currentTier !== tier.name) {
                            await databases.updateDocument(DATABASE_ID, USER_PROFILES_TABLE_ID, user.$id, { tierLevel: tier.name });
                            updatedCount++;
                        }
                    }
                    offset += limit;
                    if (usersResponse.documents.length < limit)
                        break;
                }
                log(`Updated tier for ${updatedCount} users`);
                return res.json({
                    success: true,
                    updatedCount,
                });
            }
        }
        // Default response
        return res.json({
            success: false,
            error: 'Invalid endpoint. Use POST /get-statistics with { "page": "dashboard|clients|users|notifications|trivia|popups" }',
        });
    }
    catch (err) {
        error(`Function error: ${err.message}`);
        console.error('Function error:', err);
        return res.json({
            success: false,
            error: err.message || 'Internal server error',
        }, 500);
    }
}
