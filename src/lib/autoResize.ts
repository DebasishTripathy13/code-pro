/**
 * Lets a modal temporarily stop the window from resizing itself to content.
 *
 * The overlay measures its own content and asks the main process to resize to
 * match. A modal is a fixed-position overlay that does not belong to that
 * measurement, but opening one still perturbs layout (scroll lock, focus
 * rings, animated attributes) enough to change the measured width. The window
 * then resizes, which perturbs layout again - the settings dialog visibly
 * shook between roughly 750px and 850px wide.
 *
 * Suspending while a modal is open fixes it at the source: the window simply
 * keeps whatever size it already had until the modal closes.
 */
let suspendCount = 0

export function suspendAutoResize(): void {
  suspendCount++
}

export function resumeAutoResize(): void {
  suspendCount = Math.max(0, suspendCount - 1)
}

export function isAutoResizeSuspended(): boolean {
  return suspendCount > 0
}
