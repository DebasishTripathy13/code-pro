// file: src/components/SubscribedApp.tsx
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import Queue from "../_pages/Queue"
import Solutions from "../_pages/Solutions"
import { useToast } from "../contexts/toast"
import AssistantPanel from "../components/Assistant/AssistantPanel"
import { isAutoResizeSuspended } from "../lib/autoResize"

interface SubscribedAppProps {
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
}

const SubscribedApp: React.FC<SubscribedAppProps> = ({
  credits,
  currentLanguage,
  setLanguage
}) => {
  const queryClient = useQueryClient()
  const [view, setView] = useState<"queue" | "solutions" | "debug">("queue")
  const containerRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()
  const [canTranscribe, setCanTranscribe] = useState(false)

  // Speech-to-text needs a provider that can transcribe audio. OpenAI
  // (Whisper) and Gemini both can; Anthropic has no audio endpoint, so on
  // that provider the overlay stays screenshot-only rather than opening a
  // mic it can't use.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .getConfig()
      .then((config: any) => {
        const provider = config?.apiProvider
        if (!cancelled) setCanTranscribe(provider === "openai" || provider === "gemini")
      })
      .catch(() => {
        if (!cancelled) setCanTranscribe(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Let's ensure we reset queries etc. if some electron signals happen
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
      queryClient.invalidateQueries({
        queryKey: ["screenshots"]
      })
      queryClient.invalidateQueries({
        queryKey: ["problem_statement"]
      })
      queryClient.invalidateQueries({
        queryKey: ["solution"]
      })
      queryClient.invalidateQueries({
        queryKey: ["new_solution"]
      })
      setView("queue")
    })

    return () => {
      cleanup()
    }
  }, [])

  // Dynamically update the window size
  useEffect(() => {
    if (!containerRef.current) return

    // Remember what we last asked for. Resizing the window changes the layout,
    // which re-triggers the observers, which asks for another resize - opening
    // a modal (scroll-lock padding) starts that loop and the window visibly
    // shakes. Only forward a genuine change.
    let lastWidth = 0
    let lastHeight = 0
    let frame = 0

    const measureAndSend = () => {
      if (!containerRef.current) return
      // A modal is a fixed overlay that should not drive window size.
      if (isAutoResizeSuspended()) return

      const height = containerRef.current.scrollHeight || 600
      const width = containerRef.current.scrollWidth || 800

      if (Math.abs(width - lastWidth) < 4 && Math.abs(height - lastHeight) < 4) {
        return
      }
      lastWidth = width
      lastHeight = height
      window.electronAPI?.updateContentDimensions({ width, height })
    }

    // Coalesce bursts of mutations into one measurement per frame. Radix
    // animates by rewriting attributes, so the raw callback fires dozens of
    // times for a single dialog opening.
    const updateDimensions = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measureAndSend()
      })
    }

    // Force initial dimension update immediately
    updateDimensions()

    // Set a fallback timer to ensure dimensions are set even if content isn't fully loaded
    const fallbackTimer = setTimeout(() => {
      window.electronAPI?.updateContentDimensions({ width: 800, height: 600 })
    }, 500)

    const resizeObserver = new ResizeObserver(updateDimensions)
    resizeObserver.observe(containerRef.current)

    // Watch structure and text, but NOT attributes: animation libraries rewrite
    // style/data-state attributes continuously, which turned this into a
    // permanent resize loop.
    const mutationObserver = new MutationObserver(updateDimensions)
    mutationObserver.observe(containerRef.current, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: true
    })

    // Do another update after a delay to catch any late-loading content
    const delayedUpdate = setTimeout(updateDimensions, 1000)

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(fallbackTimer)
      clearTimeout(delayedUpdate)
    }
  }, [view])

  // Listen for events that might switch views or show errors
  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStart(() => {
        setView("solutions")
      }),
      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.setQueryData(["problem_statement"], null)
      }),
      window.electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          queryClient.invalidateQueries({
            queryKey: ["problem_statement"]
          })
          queryClient.setQueryData(["problem_statement"], data)
        }
      }),
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Error", error, "error")
      })
    ]
    return () => cleanupFunctions.forEach((fn) => fn())
  }, [view])

  return (
    <div ref={containerRef} className="min-h-0">
      {/* Live assistant - always mounted so listening survives view changes */}
      <div className="px-4 pt-3">
        <AssistantPanel autoStart={canTranscribe} />
      </div>

      {view === "queue" ? (
        <Queue
          setView={setView}
          credits={credits}
          currentLanguage={currentLanguage}
          setLanguage={setLanguage}
        />
      ) : view === "solutions" ? (
        <Solutions
          setView={setView}
          credits={credits}
          currentLanguage={currentLanguage}
          setLanguage={setLanguage}
        />
      ) : null}
    </div>
  )
}

export default SubscribedApp
