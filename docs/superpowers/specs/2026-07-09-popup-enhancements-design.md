# Pop-up Enhancements (SAM-5 follow-up) — Design

**Date:** 2026-07-09
**Branch:** `feature/SAM-5/popups` (both repos)
**Status:** design approved (brainstorming); pending spec review → implementation plan

Follow-up to [SAM-5](https://linear.app/bolder-builders/issue/SAM-5) from staging testing. Three
changes spanning the mobile app, the admin panel, and the shared `popups` schema. Builds on
`2026-07-02-popup-ads-design.md`.

## Goals

1. The pop-up modal is dismissed **only** by its close (✕) button — no backdrop tap, no Android back.
2. Add **optional title + description** shown on the pop-up, and redesign the modal to senior-quality,
   matching the app's existing UI (the `TriviaModal` card language).
3. Add a **Preview** feature to the admin: a button in Create/Edit that renders the pop-up as users see it.

## Decisions (locked in brainstorming)

- **Field model:** the existing required `title` becomes **optional and user-facing** (shown on the
  pop-up). Add an **optional `description`**, also shown. There is no separate "internal name" — the
  admin list identifies a pop-up by its title, falling back to the banner image + date range when the
  title is blank.
- **Close behavior:** ✕ is the only dismissal. Android hardware-back does **not** dismiss. The backdrop
  is non-dismissable (already true). Tapping the banner/CTA opens the link and then closes (engaging =
  leaving), per the existing behavior.
- **Modal layout:** **Stacked card** — banner image on top, a white panel below holding, in order,
  title → description → a single "Learn More" button. Matches `TriviaModal` (white card, `Quicksand`,
  indigo→magenta gradient accents, top-right `CloseIcon`).
- **Preview placement:** a **live "Preview" button inside the Create/Edit modal**, rendering the current
  (unsaved) form values.

## Modal behavior — adaptive across all field combinations

Image is required; title, description, and link are each optional (8 combinations). The stacked card
adapts:

- The white text panel renders **only if** title, description, or link is present. With none (image
  only), the card is a bare image with all corners rounded.
- Present fields stack with even spacing (title → description → button); any missing field is omitted
  with no leftover gap.
- The **Learn More** button shows only when a link exists. The banner image is **also** tappable to open
  the link whenever a link exists.
- ✕ always dismisses; tapping the banner or button opens the link, then closes.
- The image keeps its true aspect ratio (never cropped), sized as today (`Image.getSize` → aspect ratio,
  capped at a max height).
- Very long descriptions cap the card height (≈80% of screen) and scroll inside the panel; the image and
  ✕ stay fixed.

## Schema — Appwrite `popups` collection

- `title`: `string(200)` — change **required → optional**. (Existing staging rows already have titles;
  no data migration needed. No prod data exists yet.)
- **Add** `description`: `string(1000)`, optional, not array.
- No other attribute changes. `views` / `clicks` / targeting / schedule unchanged.

**Deploy:** additive `description` is safe; the `title` required→optional flip is an attribute-property
update. Push the `popups` table change to **staging only** (mirrors today's function-deploy discipline —
target staging project `6a0ad92e…`, never prod, never the full committed config's permissions). Prod is
out of scope for this change.

## Backend — Mobile API `getActivePopups`

- Add `description` to the served `ActivePopup` payload (currently `{ $id, title, imageUrl, link }`),
  reading it from the `popups` document; `title` and `description` are both nullable.
- Redeploy the Mobile API function to staging (code-only, `create-deployment`, as done 2026-07-09).
- `/record-popup-click` and all targeting/21+/dedup logic are unchanged.

## Mobile app — `samplefinder-app`

- **`ActivePopup` type** (`src/lib/database/popups.ts`): `title` is already present — keep it as
  `string | null`; **add** `description: string | null`.
- **`PopupImageModal`** redesigned to the stacked card:
  - `ModalBackdrop` + white card (radius ~24, `maxWidth` 400), fade+scale entrance like `TriviaModal`.
  - Banner image on top (rounded top corners; all corners when panel absent), current aspect-ratio +
    broken-image auto-skip retained.
  - Panel: optional title (`Quicksand_700Bold`, `Colors.pinDarkBlue`), optional description
    (`Quicksand_500Medium`), optional "Learn More" gradient pill (indigo→magenta) — rendered per the
    adaptive rules above.
  - `CloseIcon` (top-right) is the sole dismissal; `onRequestClose` becomes a **no-op** so Android back
    can't dismiss; backdrop remains non-dismissable.
  - Long-description height cap + internal scroll.
- Parent wiring in `App.tsx` (queue, priority gate, click recording) is unchanged; it already passes the
  full popup object.

## Admin — `samplefinder-admin`

- **Form fields** (`PopupFormFields`, shared by Create + Edit):
  - Title: relabel to "Title (shown on the pop-up)", make **optional** (placeholder updated; no longer
    "Internal name").
  - **Add** "Description (optional)" as a multi-line textarea, `maxLength` 1000, shown on the pop-up.
  - Update `PopupFormState`, `PopupFormPayload`, `initialPopupFormState`, `buildPopupPayload`, and
    `validatePopupForm` (drop the "title required" check; keep image required, link/URL validation,
    date validation, audience validation). `EditPopupModal` maps `description` from the loaded document.
- **List** (`Popups.tsx`): the Title column shows the title, or a muted "Untitled" when blank (the Image
  and Schedule columns already identify the row). Search still matches title. `PopupDocument` type gains
  `description`.
- **Preview**:
  - New `PreviewPopupModal` component — a **web replica** of the mobile stacked card (same layout,
    hierarchy, adaptive rules, and ✕-only close), styled to look like the phone modal.
  - A "Preview" button in the Create/Edit modal renders it from the **live form state**, using the
    locally-selected image (`imagePreviewUrl`) when a new file is chosen, else the existing
    `popup.imageUrl` (edit). No save required.

## Deployment impact

| Layer | Change | Target |
|---|---|---|
| `popups` schema | title→optional, add `description` | staging (push table) |
| Mobile API fn | return `description` | staging (code-only redeploy) |
| Statistics fn | none | — |
| Admin web | fields + preview + list fallback | staging build / `dev:staging` |
| Mobile app | modal redesign + type | staging Metro (already running) |
| Production | none this pass | — |

## Testing

- **Mobile:** each of the 8 field combinations renders correctly (esp. image-only and image+link);
  ✕ is the only close; Android back is a no-op; tapping banner/button opens link then closes; broken
  image skips; long description scrolls; image-only with no link is not tappable.
- **Admin:** create/edit with any subset of title/description; Preview matches the device rendering;
  list shows the fallback for untitled pop-ups; existing pop-ups (with titles) still edit fine.
- **Cross-project:** create a pop-up in the staging admin → it appears on the device per the design and
  matches the admin Preview.

## Non-goals

- No changes to targeting, scheduling, 21+ gating, dedup, or stats.
- Description is plain text (no rich text / markdown).
- No production deploy in this pass.
