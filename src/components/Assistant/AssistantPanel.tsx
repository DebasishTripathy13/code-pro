import React, { useEffect, useRef, useState } from "react"
import { useAssistant } from "../../hooks/useAssistant"
import { useSpeechOutput } from "../../hooks/useSpeechOutput"
import { COMMAND_KEY } from "../../utils/platform"
import AnswerRenderer from "./AnswerRenderer"
import { copyText } from "../../lib/clipboard"
import { Hint } from "../shared/Hint"

interface AssistantPanelProps {
  /** Start listening as soon as the panel mounts. */
  autoStart?: boolean
}

/**
 * The live assistant overlay: it listens to the call, shows a running
 * transcript of both sides, and streams an answer either automatically
 * (Ctrl+Shift+Enter) or from a typed question - all without the user ever
 * having to speak to it.
 */
export const AssistantPanel: React.FC<AssistantPanelProps> = ({ autoStart = true }) => {
  const {
    listening,
    captureStatus,
    transcript,
    interim,
    question,
    answer,
    isStreaming,
    error,
    ask,
    answerLatest,
    stopStreaming,
    clearTranscript,
    toggleListening
  } = useAssistant(autoStart)

  const { isSpeaking, toggle: toggleReadAloud, isSupported: canSpeak } = useSpeechOutput()

  const [input, setInput] = useState("")
  const [showTranscript, setShowTranscript] = useState(true)
  const [clickThrough, setClickThrough] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)

  // Ctrl+Shift+Space from the global shortcut focuses the ask box.
  useEffect(() => {
    const cleanups = [
      window.electronAPI.onFocusAsk(() => {
        setShowTranscript(true)
        // The main process has already focused the window by this point;
        // this just puts the caret in the box.
        inputRef.current?.focus()
      }),
      window.electronAPI.onClickThroughChanged((enabled) => setClickThrough(enabled))
    ]
    return () => cleanups.forEach((fn) => fn())
  }, [])

  // Keep both scrollers pinned to the newest content.
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [transcript, interim])

  useEffect(() => {
    if (answerRef.current) {
      answerRef.current.scrollTop = answerRef.current.scrollHeight
    }
  }, [answer])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    setInput("")
    // Shift-held submit also sends the current screen.
    await ask(text, false)
  }

  const statusLabel = !listening
    ? "Not listening"
    : captureStatus.systemActive && captureStatus.micActive
    ? "Listening · call + mic"
    : captureStatus.systemActive
    ? "Listening · call audio"
    : "Listening · mic only"

  return (
    <div className="w-[560px] max-w-[92vw] text-white">
      <div className="rounded-lg bg-black/70 backdrop-blur-md border border-white/10 shadow-lg overflow-hidden">
        {/* Status bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
          <button
            onClick={toggleListening}
            className="flex items-center gap-1.5 text-[11px] text-white/80 hover:text-white transition-colors"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                listening ? "bg-red-500 animate-pulse" : "bg-white/30"
              }`}
            />
            {statusLabel}
          </button>

          <div className="flex-1" />

          <Hint label={`Answer what they just said · ${COMMAND_KEY}+Shift+Enter`}>
            <button
              onClick={() => answerLatest(false)}
              disabled={isStreaming}
              className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors"
            >
              Answer now
            </button>
          </Hint>
          <Hint label={`Answer using what's on screen · ${COMMAND_KEY}+Shift+S`}>
            <button
              onClick={() => answerLatest(true)}
              disabled={isStreaming}
              className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors"
            >
              + Screen
            </button>
          </Hint>
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
          >
            {showTranscript ? "Hide" : "Show"}
          </button>
          <Hint label={`Let clicks pass through the overlay · ${COMMAND_KEY}+Shift+C`}>
            <button
              onClick={async () => {
                const result = await window.electronAPI.toggleClickThrough()
                setClickThrough(Boolean(result?.enabled))
              }}
              className={`text-[10px] px-1.5 py-1 rounded transition-colors ${
                clickThrough ? "bg-blue-500/40 hover:bg-blue-500/50" : "bg-white/10 hover:bg-white/20"
              }`}
            >
              {clickThrough ? "Click-through on" : "Click-through"}
            </button>
          </Hint>
        </div>

        {showTranscript && (
          <>
            {/* Live transcript */}
            <div
              ref={transcriptRef}
              className="max-h-28 overflow-y-auto px-3 py-2 space-y-1 border-b border-white/10"
            >
              {transcript.length === 0 && !interim.them && !interim.you ? (
                <p className="text-[11px] text-white/40">
                  {listening
                    ? "Waiting for speech… everything said on the call appears here."
                    : "Listening is off."}
                </p>
              ) : (
                <>
                  {transcript.slice(-40).map((segment) => (
                    <div key={segment.id} className="flex items-start gap-2">
                      <span
                        className={`text-[9px] uppercase tracking-wide mt-[3px] shrink-0 ${
                          segment.source === "them" ? "text-amber-400/90" : "text-blue-400/90"
                        }`}
                      >
                        {segment.source === "them" ? "Them" : "You"}
                      </span>
                      <span className="text-[11px] leading-[1.45] text-white/85">
                        {segment.text}
                      </span>
                    </div>
                  ))}

                  {/* Words for the utterance still in progress, dimmed until final */}
                  {(["them", "you"] as const).map((source) =>
                    interim[source] ? (
                      <div key={`interim-${source}`} className="flex items-start gap-2">
                        <span
                          className={`text-[9px] uppercase tracking-wide mt-[3px] shrink-0 ${
                            source === "them" ? "text-amber-400/50" : "text-blue-400/50"
                          }`}
                        >
                          {source === "them" ? "Them" : "You"}
                        </span>
                        <span className="text-[11px] leading-[1.45] text-white/45 italic">
                          {interim[source]}
                        </span>
                      </div>
                    ) : null
                  )}
                </>
              )}
            </div>

          </>
        )}

        {/* Answer */}
        {(question || answer || isStreaming || error) && (
          <div className="px-3 py-2 border-b border-white/10">
            {question && (
              <p className="text-[10px] text-white/45 mb-1.5 truncate">Re: {question}</p>
            )}

            {error ? (
              <p className="text-[11px] text-red-300">{error}</p>
            ) : (
              <div ref={answerRef} className="max-h-64 overflow-y-auto pr-1">
                <AnswerRenderer text={answer} />
                {isStreaming && !answer && (
                  <p className="text-[11px] text-white/50 animate-pulse">Thinking…</p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 mt-2">
              {isStreaming ? (
                <button
                  onClick={stopStreaming}
                  className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                  Stop
                </button>
              ) : (
                answer &&
                canSpeak && (
                  <button
                    onClick={() => toggleReadAloud(answer)}
                    className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    {isSpeaking ? "Stop reading" : "Read aloud"}
                  </button>
                )
              )}
              {answer && !isStreaming && (
                <button
                  onClick={() => { void copyText(answer) }}
                  className="text-[10px] px-1.5 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                  Copy
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={clearTranscript}
                className="text-[10px] text-white/40 hover:text-white/70 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Ask box */}
        <form onSubmit={handleSubmit} className="flex items-center gap-2 px-3 py-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            // The overlay is shown without focus so it never interrupts the
            // call, which also means clicking the box alone may not give it
            // keyboard focus - ask the main process for it explicitly.
            onMouseDown={() => {
              void window.electronAPI.focusWindow()
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setInput("")
                inputRef.current?.blur()
                void window.electronAPI.blurWindow()
              }
            }}
            placeholder={`Ask anything…  (${COMMAND_KEY}+Shift+Space)`}
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[12px] text-white placeholder:text-white/35 outline-none focus:border-white/25"
          />
          <button
            type="button"
            onClick={() => {
              const text = input.trim()
              if (!text) return
              setInput("")
              void ask(text, true)
            }}
            className="text-[10px] px-1.5 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
          >
            + Screen
          </button>
          <button
            type="submit"
            className="text-[10px] px-2 py-1.5 rounded bg-blue-500/70 hover:bg-blue-500/90 transition-colors"
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  )
}

export default AssistantPanel
