import React from "react"

interface HintProps {
  /** Text shown on hover. */
  label: string
  children: React.ReactNode
  /** Which side of the trigger to place the bubble on. */
  side?: "top" | "bottom"
}

/**
 * Hover hint rendered *inside* the app window.
 *
 * The native `title` attribute must never be used in this app: Chromium draws
 * those tooltips in their own top-level OS window, which does not inherit the
 * main window's content protection. The overlay itself stays hidden from a
 * screen share, but the tooltip floats over it fully visible to everyone on
 * the call - which is exactly the thing this app exists to avoid.
 *
 * A plain positioned div is part of the protected window, so it is excluded
 * from capture along with everything else.
 */
export const Hint: React.FC<HintProps> = ({ label, children, side = "bottom" }) => (
  <span className="relative inline-flex group">
    {children}
    <span
      role="tooltip"
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${
        side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
      } z-50 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] leading-none text-white/90 border border-white/10 opacity-0 transition-opacity duration-100 group-hover:opacity-100`}
    >
      {label}
    </span>
  </span>
)

export default Hint
