# Pop-up Enhancements (SAM-5 follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional user-facing title + description to pop-ups, redesign the mobile pop-up to an adaptive "stacked card" that only its ✕ button dismisses, and add a live Preview to the admin.

**Architecture:** The `popups` schema gains an optional `description` and its `title` becomes optional. The Mobile API returns both. The mobile `PopupImageModal` is rewritten as a stacked card (image → optional title → optional description → optional gradient "Learn More" CTA) matching the app's `TriviaModal` design language. The admin Create/Edit form gains a Description field, makes Title optional, and adds a `PreviewPopupModal` that renders a web replica of the phone card from the live form.

**Tech Stack:** Appwrite (TablesDB, `nyc.cloud`, project db `69217af50038b9005a61`), Node Appwrite Functions (node-22, TS), Expo/React Native 0.81 + `expo-linear-gradient`, React 19 + Vite + Tailwind (admin).

## Global Constraints

- Branch (both repos): `feature/SAM-5/popups`. Mobile app = `samplefinder-app/`; admin + Appwrite = `samplefinder-admin/`.
- Appwrite SDK: **object-based** function signatures only (never positional).
- Deploy target is **staging only**: project `6a0ad92e0001d5e515ce`, db `69217af50038b9005a61`, Mobile API function `69308117000e7a96bcbb`. **Never touch production** and **never `appwrite push` the committed `appwrite.config.json`** (its `projectId` points at prod). Apply staging schema via targeted CLI/console; deploy functions via `create-deployment`.
- **No server API keys in the mobile client** (session-based only).
- **No test framework** exists. Verification = `npm run typecheck` (app), `npm run build` + `npm run lint` (admin), `npm run build` (functions), plus manual device/admin checks.
- **Backend writes to staging (schema mutations, function deployments) are operator-run** in this environment — the permission classifier blocks agent-initiated backend writes. Each such step is marked **[OPERATOR]** with the exact command for the user to run.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Description max length: **1000** chars. Title max length: **200** chars (unchanged). Description is plain text.

## File Structure

**samplefinder-admin (Appwrite + admin web):**
- `appwrite/appwrite.config.json` — add `description` column to `popups`; set `title` `required: false` (source-of-truth; applied to staging out-of-band).
- `appwrite/functions/Mobile API/src/main.ts` — add `description` to `PopupDocument`, `ActivePopupResponse`, and the `getActivePopups` return.
- `src/lib/services.ts` — add `description` to admin `PopupDocument`.
- `src/pages/Popups/components/CreatePopupModal.tsx` — form state/payload/validation/fields; Title optional + relabel; Description textarea; wire Preview button.
- `src/pages/Popups/components/EditPopupModal.tsx` — map `description`; wire Preview button.
- `src/pages/Popups/components/PreviewPopupModal.tsx` — **new**, web replica of the phone card.
- `src/pages/Popups/components/index.ts` — export `PreviewPopupModal` (if barrel exists; else import directly).
- `src/pages/Popups/Popups.tsx` — "Untitled" fallback in the Title column.

**samplefinder-app (mobile):**
- `src/lib/database/popups.ts` — add `description` to `ActivePopup`.
- `src/components/popup/PopupImageModal.tsx` — rewrite as the adaptive stacked card.

---

### Task 1: Schema — add `description`, make `title` optional

**Files:**
- Modify: `samplefinder-admin/appwrite/appwrite.config.json` (the `popups` table's `columns`)

**Interfaces:**
- Produces: a `popups` table (on staging) with a new optional `description` string(1000) and `title` no longer required. All later tasks assume these exist.

- [ ] **Step 1: Edit the committed config (source of truth).** In `appwrite/appwrite.config.json`, find the `popups` table's `columns` array. Change the `title` column's `"required": true` to `"required": false`. Add a new column object next to it:

```json
{
  "key": "description",
  "type": "string",
  "required": false,
  "array": false,
  "size": 1000,
  "default": null
}
```

- [ ] **Step 2: Verify the exact CLI column subcommand names** (v22 kebab names vary).

Run: `appwrite tables-db --help` (fallback: `appwrite databases --help`)
Expected: a `create-string-column` (or `create-string-attribute`) and `update-string-column` (or `update-string-attribute`) subcommand is listed. Use whichever your CLI reports in the next step.

- [ ] **Step 3: [OPERATOR] Apply to staging — add `description`.** (CLI is already pinned to staging + key.)

Run:
```bash
appwrite tables-db create-string-column \
  --database-id 69217af50038b9005a61 --table-id popups \
  --key description --size 1000 --required false
```
Expected: JSON for the new column with `"status":"available"` (may briefly show `processing`).
**Console fallback:** staging console → Databases → `popups` → Columns → Create → String, key `description`, size 1000, **not** required.

- [ ] **Step 4: [OPERATOR] Apply to staging — make `title` optional.**

Run:
```bash
appwrite tables-db update-string-column \
  --database-id 69217af50038b9005a61 --table-id popups \
  --key title --required false --default null
```
Expected: JSON for `title` with `"required":false`.
**Console fallback:** staging console → `popups` → Columns → `title` → edit → uncheck "Required" → update. (If the console/CLI refuses to change `required` in place, the fallback is to add a new optional `title` and migrate — but staging has only test rows, so in-place update should succeed.)

- [ ] **Step 5: Verify staging schema.**

Run:
```bash
appwrite tables-db list-columns --database-id 69217af50038b9005a61 --table-id popups 2>&1 | grep -iE "description|title|required"
```
Expected: `description` present (size 1000, required false) and `title` required false.

- [ ] **Step 6: Commit the config (admin repo).**

```bash
git -C samplefinder-admin add appwrite/appwrite.config.json
git -C samplefinder-admin commit -m "feat(popups): schema — optional description + optional title

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mobile API — return `description`

**Files:**
- Modify: `samplefinder-admin/appwrite/functions/Mobile API/src/main.ts` (`PopupDocument` ~line 129, `ActivePopupResponse` ~line 145, `getActivePopups` return ~line 1454)

**Interfaces:**
- Consumes: `popups.description` (Task 1).
- Produces: `/get-active-popups` responses now include `description: string | null`. The mobile `ActivePopup` (Task 6) relies on this.

- [ ] **Step 1: Add `description` to `PopupDocument`.** In the `interface PopupDocument` block, after the `link?: string | null;` line add:

```ts
  description?: string | null;
```

- [ ] **Step 2: Add `description` to `ActivePopupResponse`.** Change the interface to:

```ts
interface ActivePopupResponse {
  $id: string;
  title: string | null;
  imageUrl: string;
  link: string | null;
  description: string | null;
}
```

- [ ] **Step 3: Return it from `getActivePopups`.** In the final `return eligible.map(...)`, change the mapped object to:

```ts
  return eligible.map((p) => ({
    $id: p.$id,
    title: p.title ?? null,
    imageUrl: p.imageUrl,
    link: p.link ?? null,
    description: p.description ?? null,
  }));
```

- [ ] **Step 4: Build the function.**

Run: `cd "samplefinder-admin/appwrite/functions/Mobile API" && npm run build`
Expected: exit 0; `src/main.js` regenerated (tsc clean).

- [ ] **Step 5: [OPERATOR] Deploy code-only to staging.** From a directory holding a clean copy of the function (no `node_modules`); the repo dir works if an `.appwriteignore` excludes `node_modules`/`dist`, otherwise stage a copy as on 2026-07-09.

Run:
```bash
appwrite functions create-deployment \
  --function-id 69308117000e7a96bcbb \
  --code "<clean Mobile API dir>" \
  --entrypoint src/main.js \
  --commands "npm install && npm run build" \
  --activate true
```
Then poll `appwrite functions get-deployment --function-id 69308117000e7a96bcbb --deployment-id <id>` until `status: ready`.
Expected: new deployment `ready` + `live: true`.

- [ ] **Step 6: Commit (admin repo).**

```bash
git -C samplefinder-admin add "appwrite/functions/Mobile API/src/main.ts" "appwrite/functions/Mobile API/src/main.js"
git -C samplefinder-admin commit -m "feat(popups): Mobile API returns description in get-active-popups

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Admin types — `description` on `PopupDocument`

**Files:**
- Modify: `samplefinder-admin/src/lib/services.ts:1993-2011`

**Interfaces:**
- Produces: admin `PopupDocument.description?: string | null`, consumed by the form (Task 4), list (Task 5), and preview (Task 6).

- [ ] **Step 1: Add the field.** In `export interface PopupDocument extends Models.Document`, after `link?: string | null` add:

```ts
  /** Optional body text shown under the title on the pop-up. */
  description?: string | null
```

- [ ] **Step 2: Typecheck via build.**

Run: `cd samplefinder-admin && npm run build`
Expected: exit 0 (tsc + vite).

- [ ] **Step 3: Commit (admin repo).**

```bash
git -C samplefinder-admin add src/lib/services.ts
git -C samplefinder-admin commit -m "feat(popups): add description to admin PopupDocument type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Admin form — optional title + Description field

**Files:**
- Modify: `samplefinder-admin/src/pages/Popups/components/CreatePopupModal.tsx` (`PopupFormPayload`, `PopupFormState`, `initialPopupFormState`, `validatePopupForm`, `PopupFormFields`, `buildPopupPayload`)
- Modify: `samplefinder-admin/src/pages/Popups/components/EditPopupModal.tsx:41-51` (map `description`)

**Interfaces:**
- Consumes: `PopupDocument.description` (Task 3).
- Produces: `PopupFormState` and `PopupFormPayload` both gain `description: string`; `buildPopupPayload` emits `description` (empty → `null`). Task 6 (Preview) reads `form.title` / `form.description` / `form.link` / image.

- [ ] **Step 1: Add `description` to `PopupFormPayload`.** After `title: string` add `description: string | null`.

- [ ] **Step 2: Add `description` to `PopupFormState`.** After `title: string` add `description: string`.

- [ ] **Step 3: Add to `initialPopupFormState`.** After `title: '',` add `description: '',`.

- [ ] **Step 4: Drop the title-required check in `validatePopupForm`.** Remove the line:

```ts
  if (!form.title.trim()) return 'Please enter a title.'
```
Keep the image-required, link-URL, date, and audience checks unchanged.

- [ ] **Step 5: Emit `description` in `buildPopupPayload`.** Add to the returned object:

```ts
  title: form.title.trim(),
  description: form.description.trim() ? form.description.trim() : null,
```
(the `title` line already exists — leave it; add the `description` line).

- [ ] **Step 6: Relabel Title + add the Description textarea in `PopupFormFields`.** Replace the Title `<div>` block (the one labeled `Title *`) with:

```tsx
      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Title (shown on the pop-up)</label>
        <input
          type="text"
          maxLength={200}
          value={form.title}
          onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          className={inputClass}
          placeholder="e.g. Summer IPA Launch (optional)"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Description (shown on the pop-up)</label>
        <textarea
          maxLength={1000}
          rows={3}
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          className={`${inputClass} resize-y`}
          placeholder="Optional supporting text under the title"
        />
      </div>
```

- [ ] **Step 7: Map `description` in EditPopupModal.** In the `setForm({ ... })` object (EditPopupModal.tsx ~line 41), after `title: popup.title,` add:

```tsx
        title: popup.title ?? '',
        description: (popup.description as string | null | undefined) ?? '',
```
(replace the existing `title: popup.title,` with the null-safe `title: popup.title ?? '',` and add the `description` line).

- [ ] **Step 8: Build + lint.**

Run: `cd samplefinder-admin && npm run build && npm run lint`
Expected: both exit 0.

- [ ] **Step 9: Manual check.** `npm run dev:staging`, open Create Pop-up: Title is optional (can save blank with an image), Description textarea present and persists on Edit.

- [ ] **Step 10: Commit (admin repo).**

```bash
git -C samplefinder-admin add src/pages/Popups/components/CreatePopupModal.tsx src/pages/Popups/components/EditPopupModal.tsx
git -C samplefinder-admin commit -m "feat(popups): optional title + description field in admin form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Admin list — "Untitled" fallback

**Files:**
- Modify: `samplefinder-admin/src/pages/Popups/Popups.tsx:219` (Title cell) and `:97` (search filter)

**Interfaces:**
- Consumes: `PopupDocument.title` (now possibly empty).

- [ ] **Step 1: Fallback in the Title cell.** Replace:

```tsx
<td className="px-4 py-3 font-medium text-gray-900">{popup.title}</td>
```
with:
```tsx
<td className="px-4 py-3 font-medium text-gray-900">
  {popup.title?.trim() ? popup.title : <span className="italic text-gray-400">Untitled</span>}
</td>
```

- [ ] **Step 2: Null-safe search filter.** Replace:

```tsx
return popups.filter((p) => p.title.toLowerCase().includes(q))
```
with:
```tsx
return popups.filter((p) => (p.title ?? '').toLowerCase().includes(q))
```

- [ ] **Step 3: Build + lint.**

Run: `cd samplefinder-admin && npm run build && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit (admin repo).**

```bash
git -C samplefinder-admin add src/pages/Popups/Popups.tsx
git -C samplefinder-admin commit -m "feat(popups): show 'Untitled' in list when title is blank

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Admin Preview — `PreviewPopupModal` + Preview buttons

**Files:**
- Create: `samplefinder-admin/src/pages/Popups/components/PreviewPopupModal.tsx`
- Modify: `samplefinder-admin/src/pages/Popups/components/index.ts` (export it, if a barrel exists)
- Modify: `CreatePopupModal.tsx` + `EditPopupModal.tsx` (add a Preview button that opens it from live form state)

**Interfaces:**
- Consumes: `form.title`, `form.description`, `form.link` (Task 4), and the current image URL (`imagePreviewUrl`).
- Produces: `PreviewPopupModal` with props `{ isOpen: boolean; onClose: () => void; title: string; description: string; link: string; imageUrl: string | null }`.

- [ ] **Step 1: Create `PreviewPopupModal.tsx`** (web replica of the phone stacked card; same adaptive rules):

```tsx
interface PreviewPopupModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  description: string
  link: string
  imageUrl: string | null
}

const PreviewPopupModal = ({ isOpen, onClose, title, description, link, imageUrl }: PreviewPopupModalProps) => {
  if (!isOpen) return null
  const t = title.trim()
  const d = description.trim()
  const hasLink = !!link.trim()
  const hasPanel = !!t || !!d || hasLink

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs font-medium uppercase tracking-wide text-white/70">
          Preview · how it appears in the app
        </span>
        <div className="relative w-[300px] rounded-[20px] bg-white shadow-2xl">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#1D0A74] bg-white text-[#1D0A74] shadow"
          >
            ✕
          </button>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={t || 'Pop-up banner'}
              className={`w-full ${hasPanel ? 'rounded-t-[20px]' : 'rounded-[20px]'} object-contain`}
              style={{ maxHeight: 340 }}
            />
          ) : (
            <div className={`flex h-40 w-full items-center justify-center bg-gray-100 text-sm text-gray-400 ${hasPanel ? 'rounded-t-[20px]' : 'rounded-[20px]'}`}>
              Select a banner image
            </div>
          )}
          {hasPanel && (
            <div className="flex flex-col gap-2.5 px-[18px] pb-[18px] pt-3.5">
              {!!t && <p className="m-0 text-[17px] font-bold text-[#1D0A74]">{t}</p>}
              {!!d && <p className="m-0 max-h-40 overflow-y-auto text-[13px] leading-snug text-[#5b5670]">{d}</p>}
              {hasLink && (
                <span className="block rounded-xl bg-gradient-to-br from-[#3D1578] via-[#1D0A74] to-[#6C0331] py-3 text-center text-sm font-bold text-white">
                  Learn More
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default PreviewPopupModal
```

- [ ] **Step 2: Export from the barrel** (if `src/pages/Popups/components/index.ts` exists). Add:

```ts
export { default as PreviewPopupModal } from './PreviewPopupModal'
```
(If no barrel, skip — import directly where used.)

- [ ] **Step 3: Add a Preview button + state to `CreatePopupModal`.** Import the component; add `const [showPreview, setShowPreview] = useState(false)`. In the footer button row (before Cancel), add:

```tsx
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="mr-auto rounded-lg border border-[#1D0A74] px-4 py-2 text-[#1D0A74] hover:bg-[#1D0A74]/5"
            >
              Preview
            </button>
```
And render before the closing wrapper `</div>`:

```tsx
      <PreviewPopupModal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        title={form.title}
        description={form.description}
        link={form.link}
        imageUrl={imagePreviewUrl}
      />
```

- [ ] **Step 4: Same Preview button + state in `EditPopupModal`** (identical wiring; `imageUrl={imagePreviewUrl}` — which defaults to `popup.imageUrl` in edit).

- [ ] **Step 5: Build + lint.**

Run: `cd samplefinder-admin && npm run build && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Manual check.** `npm run dev:staging` → Create/Edit → Preview: shows the card; toggling title/description/link and swapping the image updates the preview; ✕ / backdrop-click closes the preview.

- [ ] **Step 7: Commit (admin repo).**

```bash
git -C samplefinder-admin add src/pages/Popups/components/
git -C samplefinder-admin commit -m "feat(popups): live Preview modal in admin create/edit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Mobile — `ActivePopup.description` + stacked-card redesign

**Files:**
- Modify: `samplefinder-app/src/lib/database/popups.ts:9-14` (`ActivePopup`)
- Rewrite: `samplefinder-app/src/components/popup/PopupImageModal.tsx`

**Interfaces:**
- Consumes: Mobile API `description` (Task 2). `App.tsx` already passes the whole `popup` and the `onClose`/`onPress` handlers — unchanged.
- Produces: `ActivePopup.description: string | null`.

- [ ] **Step 1: Add `description` to `ActivePopup` and make `title` nullable.** In `popups.ts`, in the `ActivePopup` interface, change `title: string;` to `title: string | null;` and after `link: string | null;` add:

```ts
  description: string | null;
```

(The Mobile API can now return a null title — Task 2 — so the type must allow it; the modal guards with `popup.title?.trim()`.)

- [ ] **Step 2: Rewrite `PopupImageModal.tsx`** with the adaptive stacked card:

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import ModalBackdrop from '@/components/shared/ModalBackdrop';
import CloseIcon from '@/components/shared/CloseIcon';
import { Colors } from '@/constants/Colors';
import type { ActivePopup } from '@/lib/database/popups';

interface PopupImageModalProps {
  visible: boolean;
  popup: ActivePopup;
  onClose: () => void;
  onPress: () => void;
}

const SCREEN = Dimensions.get('window');
const CARD_WIDTH = Math.min(SCREEN.width * 0.85, 400);
const MAX_IMAGE_HEIGHT = SCREEN.height * 0.55;
const MAX_DESC_HEIGHT = SCREEN.height * 0.26;
const DEFAULT_ASPECT_RATIO = 4 / 5;

/**
 * Pop-up banner (SAM-5) — adaptive stacked card. Image on top; an optional
 * white panel below shows title, description, and a "Learn More" button when
 * present. Only the ✕ dismisses (Android back is ignored). Tapping the banner
 * or button opens the link (handled by the parent) and then closes. A broken
 * image URL closes the modal instead of showing an empty card.
 */
export const PopupImageModal = ({ visible, popup, onClose, onPress }: PopupImageModalProps) => {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const closedRef = useRef(false);

  const closeOnce = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  // Reset the one-shot close guard when a different popup is shown.
  useEffect(() => {
    closedRef.current = false;
    setIsLoading(true);
    setLoadFailed(false);
  }, [popup.$id]);

  useEffect(() => {
    let mounted = true;
    Image.getSize(
      popup.imageUrl,
      (width, height) => {
        if (mounted && width > 0 && height > 0) setAspectRatio(width / height);
      },
      () => {
        if (mounted) setLoadFailed(true);
      }
    );
    return () => {
      mounted = false;
    };
  }, [popup.imageUrl]);

  useEffect(() => {
    if (visible && loadFailed) closeOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, loadFailed]);

  if (loadFailed) return null;

  const title = popup.title?.trim() ?? '';
  const description = popup.description?.trim() ?? '';
  const hasLink = !!popup.link;
  const hasTitle = title.length > 0;
  const hasDescription = description.length > 0;
  const hasPanel = hasTitle || hasDescription || hasLink;

  const imageHeight = Math.min(CARD_WIDTH / aspectRatio, MAX_IMAGE_HEIGHT);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        /* ✕-only: swallow Android hardware-back so it can't dismiss the ad. */
      }}
    >
      <ModalBackdrop containerStyle={styles.backdrop}>
        <View style={styles.card}>
          <Pressable
            accessibilityRole={hasLink ? 'link' : 'image'}
            accessibilityLabel={title || 'Promotion'}
            onPress={hasLink ? onPress : undefined}
            disabled={!hasLink}
          >
            <Image
              source={{ uri: popup.imageUrl }}
              style={[
                styles.image,
                { width: CARD_WIDTH, height: imageHeight },
                hasPanel ? styles.imageTopRadius : styles.imageAllRadius,
              ]}
              resizeMode="contain"
              onLoadEnd={() => setIsLoading(false)}
              onError={() => setLoadFailed(true)}
            />
            {isLoading && (
              <View style={styles.loadingOverlay} pointerEvents="none">
                <ActivityIndicator size="large" color={Colors.white} />
              </View>
            )}
          </Pressable>

          {hasPanel && (
            <View style={styles.panel}>
              {hasTitle && <Text style={styles.title}>{title}</Text>}
              {hasDescription && (
                <ScrollView
                  style={{ maxHeight: MAX_DESC_HEIGHT }}
                  showsVerticalScrollIndicator={false}
                  bounces={false}
                >
                  <Text style={styles.description}>{description}</Text>
                </ScrollView>
              )}
              {hasLink && (
                <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Learn more">
                  <LinearGradient
                    colors={['#3D1578', '#1D0A74', '#6C0331']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.cta}
                  >
                    <Text style={styles.ctaText}>Learn More</Text>
                  </LinearGradient>
                </Pressable>
              )}
            </View>
          )}

          <Pressable
            style={styles.closeButton}
            onPress={closeOnce}
            accessibilityRole="button"
            accessibilityLabel="Close pop-up"
            hitSlop={12}
          >
            <CloseIcon size={22} color={Colors.blueColorMode} />
          </Pressable>
        </View>
      </ModalBackdrop>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    width: CARD_WIDTH,
    maxHeight: SCREEN.height * 0.85,
    backgroundColor: Colors.white,
    borderRadius: 20,
  },
  image: { backgroundColor: 'rgba(0, 0, 0, 0.06)' },
  imageTopRadius: { borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  imageAllRadius: { borderRadius: 20 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 18, gap: 10 },
  title: { fontFamily: 'Quicksand_700Bold', fontSize: 18, color: Colors.blueColorMode },
  description: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 14,
    lineHeight: 20,
    color: Colors.grayText,
  },
  cta: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontFamily: 'Quicksand_600SemiBold', fontSize: 15, color: Colors.white },
  closeButton: {
    position: 'absolute',
    top: -12,
    right: -12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
});
```

- [ ] **Step 3: Typecheck.**

Run: `cd samplefinder-app && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Manual device verification** (staging Metro already running; reload the app). With the staging admin, create pop-ups covering the cases and confirm each renders per the spec:
  - image only (bare rounded image, ✕ only, not tappable)
  - image + link (Learn More button; image tappable)
  - image + title / + description / + title+description
  - image + title + description + link (full)
  - ✕ is the only dismiss; Android back does nothing; tapping banner/button opens link then closes; a broken image URL auto-skips; a very long description scrolls inside the card.

- [ ] **Step 5: Commit (app repo).**

```bash
git -C samplefinder-app add src/lib/database/popups.ts src/components/popup/PopupImageModal.tsx
git -C samplefinder-app commit -m "feat(popups): stacked-card modal with title/description, close-only-via-X (SAM-5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: End-to-end staging verification

**Files:** none (verification only).

- [ ] **Step 1: Gates.** `cd samplefinder-app && npm run typecheck` → 0; `cd samplefinder-admin && npm run build && npm run lint` → 0.
- [ ] **Step 2: Backend live.** Confirm Mobile API deployment `live:true` and (via a device fetch) `/get-active-popups` returns `description`. Confirm staging `popups` has `description` + optional `title` (Task 1 Step 5).
- [ ] **Step 3: Admin ↔ device parity.** For 3 representative pop-ups (image-only; image+title+link; image+title+description+link), verify the admin **Preview** matches what renders on the device.
- [ ] **Step 4: Regressions.** Existing pop-ups (with titles) still edit/serve; stats page still loads; list shows "Untitled" only for blank titles.
- [ ] **Step 5: Review gate.** Run `/app-check` (app) and `/pr-check` (admin) per the workspace gates before merge.

---

## Self-Review

**Spec coverage:** Goal 1 (✕-only close) → Task 7 (`onRequestClose` no-op, no backdrop press). Goal 2 (optional title+description, redesign) → Tasks 1,2,3,4,7. Goal 3 (admin Preview) → Task 6. Schema → Task 1. Backend → Task 2. Admin fields/list → Tasks 4,5. Deploy discipline → Tasks 1,2 [OPERATOR] steps. Testing → Task 8. All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The only intentional variability is Task 1 Step 2 / Task 2 Step 5 (CLI subcommand-name / clean-dir), which include explicit verify steps and console fallbacks — not placeholders.

**Type consistency:** `description` is `string | null` in the backend `ActivePopupResponse` and mobile `ActivePopup`; `string` in admin `PopupFormState`, `string | null` in `PopupFormPayload` and admin `PopupDocument`; the form→payload conversion trims and maps `'' → null`. `title` is null-safe everywhere it's now optional (`?? ''` in forms/preview, `?? null` in backend return). `PreviewPopupModal` prop names match the values passed from Create/Edit.
