import { useCallback, useEffect, useRef, useState } from "react"
import { startLiveCapture, LiveCaptureStatus } from "../lib/audioCapture"
import type { TranscriptSegment } from "../types/electron"

export interface AssistantState {
  listening: boolean
  captureStatus: LiveCaptureStatus
  transcript: TranscriptSegment[]
  interim: { them: string; you: string }
  question: string | null
  answer: string
  isStreaming: boolean
  error: string | null
}

/**
 * Owns the live assistant: microphone + system audio capture, the running
 * transcript, and the streaming answer. Capture is started automatically so
 * there is nothing to press before or during a call.
 */
export function useAssistant(autoStart: boolean) {
  const [listening, setListening] = useState(false)
  const [captureStatus, setCaptureStatus] = useState<LiveCaptureStatus>({
    micActive: false,
    systemActive: false
  })
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  // Words for the utterance currently in progress, per speaker. Replaced (not
  // appended) on each update, and cleared when the utterance is finalised.
  const [interim, setInterim] = useState<{ them: string; you: string }>({
    them: "",
    you: ""
  })
  const [question, setQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stopCaptureRef = useRef<(() => void) | null>(null)
  const startingRef = useRef(false)

  const startListening = useCallback(async () => {
    if (stopCaptureRef.current || startingRef.current) return
    startingRef.current = true

    try {
      // Streaming transcription where the provider supports it, batched WAV
      // uploads everywhere else.
      let mode: "stream" | "batch" = "batch"
      try {
        const result = await window.electronAPI.supportsLiveTranscription()
        if (result?.supported) mode = "stream"
      } catch {
        /* keep batch */
      }

      const { stop, status } = await startLiveCapture(mode, {
        onFrame: (source, pcm) => {
          window.electronAPI.sendAudioFrame(pcm, source)
        },
        onSegment: (segment) => {
          // Fire and forget - a failed chunk must never break capture.
          window.electronAPI
            .transcribeChunk(segment.base64, segment.mimeType, segment.source)
            .catch((err) => console.warn("Chunk transcription failed:", err))
        }
      })

      stopCaptureRef.current = stop
      setCaptureStatus(status)
      setListening(status.micActive || status.systemActive)
    } catch (err) {
      console.warn("Could not start listening:", err)
      setListening(false)
    } finally {
      startingRef.current = false
    }
  }, [])

  const stopListening = useCallback(() => {
    stopCaptureRef.current?.()
    stopCaptureRef.current = null
    void window.electronAPI.stopLiveTranscription().catch(() => {})
    setListening(false)
    setInterim({ them: "", you: "" })
    setCaptureStatus({ micActive: false, systemActive: false })
  }, [])

  const toggleListening = useCallback(() => {
    if (stopCaptureRef.current) {
      stopListening()
    } else {
      void startListening()
    }
  }, [startListening, stopListening])

  useEffect(() => {
    if (autoStart) void startListening()
    return () => {
      stopCaptureRef.current?.()
      stopCaptureRef.current = null
    }
  }, [autoStart, startListening])

  // Transcript + streaming events from the main process
  useEffect(() => {
    void window.electronAPI.getTranscript().then((segments) => {
      if (Array.isArray(segments)) setTranscript(segments)
    })

    const cleanups = [
      window.electronAPI.onTranscriptUpdate((segments) => {
        setTranscript(Array.isArray(segments) ? [...segments] : [])
      }),
      window.electronAPI.onInterimTranscript(({ source, text }) => {
        setInterim((prev) => ({ ...prev, [source]: text }))
      }),
      window.electronAPI.onAssistantStreamStart(({ question: q }) => {
        setQuestion(q)
        setAnswer("")
        setError(null)
        setIsStreaming(true)
      }),
      window.electronAPI.onAssistantStreamChunk((delta) => {
        setAnswer((prev) => prev + delta)
      }),
      window.electronAPI.onAssistantStreamDone(() => {
        setIsStreaming(false)
      }),
      window.electronAPI.onAssistantStreamError((message) => {
        setIsStreaming(false)
        setError(message)
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [])

  const ask = useCallback(async (text: string, includeScreen = false) => {
    if (!text.trim()) return
    setError(null)
    await window.electronAPI.askAssistant(text.trim(), includeScreen)
  }, [])

  const answerLatest = useCallback(async (includeScreen = false) => {
    setError(null)
    const result = await window.electronAPI.answerLatest(includeScreen)
    if (result && !result.success && result.error) setError(result.error)
  }, [])

  const stopStreaming = useCallback(async () => {
    await window.electronAPI.stopAssistant()
    setIsStreaming(false)
  }, [])

  const clearTranscript = useCallback(async () => {
    await window.electronAPI.clearTranscript()
    setTranscript([])
    setInterim({ them: "", you: "" })
    setAnswer("")
    setQuestion(null)
    setError(null)
  }, [])

  const state: AssistantState = {
    listening,
    captureStatus,
    transcript,
    interim,
    question,
    answer,
    isStreaming,
    error
  }

  return {
    ...state,
    ask,
    answerLatest,
    stopStreaming,
    clearTranscript,
    startListening,
    stopListening,
    toggleListening
  }
}
