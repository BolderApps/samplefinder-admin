import { client, storage, appwriteConfig, ID } from './appwrite'

export interface UploadedImage {
  fileId: string
  fileUrl: string
}

/** The URL stored on documents and rendered by <img>. Requires a session, like every read. */
const fileViewUrl = (bucketId: string, fileId: string): string =>
  `${appwriteConfig.endpoint}/storage/buckets/${bucketId}/files/${fileId}/view?project=${appwriteConfig.projectId}`

/** Upload an image to the shared files bucket and return its id + view URL. */
export const uploadImageToStorage = async (file: File): Promise<UploadedImage> => {
  if (!appwriteConfig.storage.bucketId) {
    throw new Error('Storage bucket ID is not configured')
  }
  const result = await storage.createFile({
    bucketId: appwriteConfig.storage.bucketId,
    fileId: ID.unique(),
    file,
  })
  return { fileId: result.$id, fileUrl: fileViewUrl(appwriteConfig.storage.bucketId, result.$id) }
}

/**
 * Read a stored image back as a File, so a caller can re-upload it as an independent copy
 * (used when duplicating a document that owns an image).
 *
 * Two separate things make the obvious `fetch(popup.imageUrl)` fail, and both are handled here.
 *
 * 1. Bucket files are not publicly readable — an anonymous GET returns 401 — and `fetch` sends
 *    no credentials cross-origin. So the read goes through `client.call`, which attaches the
 *    session exactly as it does for every other request, including the localStorage cookie
 *    fallback used when a browser blocks third-party cookies. (`call` is positional; it is the
 *    only byte-level read the Web SDK exposes.)
 * 2. The cache-busting param below. Do not remove it — see the comment at the call site.
 */
export const downloadStorageImageAsFile = async (fileId: string): Promise<File> => {
  const bucketId = appwriteConfig.storage.bucketId
  if (!bucketId) throw new Error('Storage bucket ID is not configured')
  if (!fileId) throw new Error('No storage file to copy')

  // Metadata first, so the copy keeps the original's name and MIME type; rebuilt from the
  // current config rather than the document's stored URL, which may point at another env.
  const meta = await storage.getFile({ bucketId, fileId })

  // Read through a URL no <img> will ever request. Banners render as <img src={imageUrl}>, and
  // an <img> stores an *opaque* (no-CORS) response in the browser cache. Appwrite serves file
  // views with `Cache-Control: private, max-age=45000` and no `Vary: Origin`, so a later
  // credentialed fetch of that same URL is handed the cached opaque entry, finds no
  // `Access-Control-Allow-Origin` on it, and dies with a bare `TypeError: Failed to fetch`
  // without ever reaching the network. A unique param sidesteps that cache entry entirely.
  const url = new URL(fileViewUrl(bucketId, fileId))
  url.searchParams.set('imageCopyNonce', String(Date.now()))

  let bytes: ArrayBuffer
  try {
    bytes = await client.call('GET', url, {}, {}, 'arrayBuffer')
  } catch (error) {
    // fetch() collapses every network-level refusal — offline, blocked by an extension, CORS —
    // into a detail-free TypeError. Say which layer failed instead of passing "Failed to fetch"
    // up to a user-facing message.
    if (error instanceof TypeError) {
      throw new Error('the browser blocked the request to storage')
    }
    throw error
  }
  const type = meta.mimeType || 'image/jpeg'
  return new File([bytes], meta.name || `${fileId}.${(type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`, { type })
}

/** Best-effort delete; storage orphans must never block a save/delete flow. */
export const deleteStorageFile = async (fileId: string): Promise<void> => {
  if (!appwriteConfig.storage.bucketId || !fileId) return
  try {
    await storage.deleteFile({ bucketId: appwriteConfig.storage.bucketId, fileId })
  } catch (error) {
    console.warn('Failed to delete storage file:', fileId, error)
  }
}
