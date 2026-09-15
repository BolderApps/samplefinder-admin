import { useLayoutEffect, useState, type RefObject } from 'react'

/** Gap between the anchor and the menu — matches the mt-1/mb-1 the callers apply. */
const MENU_GAP = 4

/**
 * The nearest ancestor that clips its overflow, or null when nothing between `el` and
 * the document does.
 *
 * The flip decision has to measure against this rather than the viewport: our dropdowns
 * live inside modal bodies capped at `max-h-[90vh] overflow-y-auto`, whose bottom edge sits
 * ~5vh above the bottom of the window. Measuring against the window alone reports room that
 * the modal does not actually have, so the menu stays pointed down and is cut off anyway.
 */
const clippingAncestor = (el: HTMLElement | null): HTMLElement | null => {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') return node
  }
  return null
}

/**
 * Whether a dropdown anchored under `anchorRef` should open upward instead of downward.
 *
 * Mirrors the rule MultiSelectDropdown established: flip only when the menu does not fit
 * below AND there is more room above. A menu that fits nowhere stays on the roomier side
 * rather than jumping around.
 *
 * Measuring runs in a layout effect with no dependency array — i.e. after every render of
 * the calling component, before paint. That is deliberate: the two things that move the
 * anchor are the caller's own state (selected-user chips wrapping to another line pushes the
 * search box down; typing narrows the list and shortens the menu), and both arrive as
 * renders. Measuring after each one keeps the placement correct without the caller having to
 * enumerate which pieces of its state affect layout, and running before paint means the menu
 * is never briefly drawn on the wrong side.
 *
 * `openUpward` deliberately survives a close so reopening in the same spot does not flash
 * downward first.
 */
export function useDropdownPlacement(
  isOpen: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>
): boolean {
  const [openUpward, setOpenUpward] = useState(false)

  const measure = () => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return

    const anchorRect = anchor.getBoundingClientRect()
    const menuHeight = menu.getBoundingClientRect().height
    const clipRect = clippingAncestor(anchor)?.getBoundingClientRect()

    // The usable band is the clipping ancestor narrowed to what is actually on screen.
    const top = Math.max(0, clipRect?.top ?? 0)
    const bottom = Math.min(window.innerHeight, clipRect?.bottom ?? window.innerHeight)

    const spaceBelow = bottom - anchorRect.bottom
    const spaceAbove = anchorRect.top - top

    setOpenUpward(spaceBelow < menuHeight + MENU_GAP && spaceAbove > spaceBelow)
  }

  useLayoutEffect(() => {
    if (isOpen) measure()
  })

  // Scrolling the modal body or resizing the window moves the anchor without re-rendering
  // the caller, so those need listeners of their own. `true` captures scrolls on the modal
  // body, which do not bubble to the window.
  useLayoutEffect(() => {
    if (!isOpen) return

    const onLayoutChange = () => measure()
    window.addEventListener('resize', onLayoutChange)
    window.addEventListener('scroll', onLayoutChange, true)
    return () => {
      window.removeEventListener('resize', onLayoutChange)
      window.removeEventListener('scroll', onLayoutChange, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure is re-created each render; the listeners only need re-binding when the menu opens or closes
  }, [isOpen])

  return openUpward
}
