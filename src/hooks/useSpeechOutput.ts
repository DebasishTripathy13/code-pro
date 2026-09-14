import { useCallback, useEffect, useState } from "react"

/**
 * Reads text aloud via the browser's built-in SpeechSynthesis API - no API
 * key or network round-trip required, works fully offline with system voices.
 */
export function useSpeechOutput() {
  const [isSpeaking, setIsSpeaking] = useState(false)

  const isSupported = typeof window !== "undefined" && "speechSynthesis" in window

  const stop = useCallback(() => {
    if (!isSupported) return
    window.speechSynthesis.cancel()
    setIsSpeaking(false)
  }, [isSupported])

  const speak = useCallback(
    (text: string) => {
      if (!isSupported || !text) return
      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1
      utterance.pitch = 1
      utterance.onstart = () => setIsSpeaking(true)
      utterance.onend = () => setIsSpeaking(false)
      utterance.onerror = () => setIsSpeaking(false)

      window.speechSynthesis.speak(utterance)
    },
    [isSupported]
  )

  const toggle = useCallback(
    (text: string) => {
      if (isSpeaking) {
        stop()
      } else {
        speak(text)
      }
    },
    [isSpeaking, speak, stop]
  )

  useEffect(() => {
    return () => {
      if (isSupported) window.speechSynthesis.cancel()
    }
  }, [isSupported])

  return { isSpeaking, speak, stop, toggle, isSupported }
}
