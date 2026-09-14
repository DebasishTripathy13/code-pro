/**
 * Copy text to the system clipboard.
 *
 * In production the renderer is loaded from file://, which Chromium does not
 * treat as a secure context - so `navigator.clipboard` is undefined there and
 * every copy threw a TypeError that nothing caught. The main process has no
 * such restriction, so that is the primary path; the browser API is only a
 * fallback for the dev server.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  try {
    const result = await window.electronAPI?.writeClipboard(text)
    if (result?.success) return true
  } catch (err) {
    console.warn("Clipboard via main process failed:", err)
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (err) {
    console.warn("Clipboard via navigator failed:", err)
  }

  return false
}
