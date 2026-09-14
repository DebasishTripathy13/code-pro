import React, { useEffect, useRef, useState } from "react"
import { LANGUAGES, languageName } from "../../lib/languages"

interface LanguageSelectorProps {
  currentLanguage: string
  setLanguage: (language: string) => void
}

/**
 * Language picker drawn entirely inside the app window.
 *
 * This used to be a native <select>. Chromium renders an open <select>'s
 * option list as its own OS-level popup, which does not inherit the window's
 * content protection - so the list stayed visible in a screen share even
 * though the overlay behind it was hidden. Same failure mode as native
 * `title` tooltips. A div-based menu is part of the protected window.
 */
export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  currentLanguage,
  setLanguage
}) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  const choose = async (id: string) => {
    setOpen(false)
    if (id === currentLanguage) return

    try {
      await window.electronAPI.updateConfig({ language: id })
      window.__LANGUAGE__ = id
      setLanguage(id)
    } catch (error) {
      console.error("Error updating language:", error)
    }
  }

  return (
    <div className="mb-3 px-2 space-y-1" ref={containerRef}>
      <div className="flex items-center justify-between text-[13px] font-medium text-white/90">
        <span>Language</span>

        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 bg-black/80 text-white/90 rounded px-2 py-1 text-xs border border-white/10 hover:border-white/25 transition-colors"
          >
            {languageName(currentLanguage)}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`w-3 h-3 text-white/50 transition-transform ${open ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {open && (
            <div
              role="listbox"
              className="absolute right-0 top-full mt-1 z-50 max-h-48 overflow-y-auto rounded-md border border-white/10 bg-black/95 py-1 shadow-lg min-w-[7rem]"
            >
              {LANGUAGES.map((language) => (
                <button
                  key={language.id}
                  type="button"
                  role="option"
                  aria-selected={language.id === currentLanguage}
                  onClick={() => choose(language.id)}
                  className={`block w-full text-left px-3 py-1.5 text-xs transition-colors ${
                    language.id === currentLanguage
                      ? "bg-white/15 text-white"
                      : "text-white/80 hover:bg-white/10"
                  }`}
                >
                  {language.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
