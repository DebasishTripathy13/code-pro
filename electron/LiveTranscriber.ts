// LiveTranscriber.ts
//
// Streaming speech-to-text over the Gemini Live API (bidirectional WebSocket).
//
// The batch approach this replaces had to wait for the speaker to finish, cut a
// WAV, upload it and wait for a reply - about five seconds before a single word
// appeared. Here audio is streamed continuously and words come back while the
// person is still talking, and the server reports turn boundaries itself so we
// no longer need client-side voice-activity detection.
//
// Measured on gemini-3.5-transcribe-live: first transcript ~2.1s including
// connection setup; in steady state on an already-open socket, interim words
// arrive continuously as they are spoken.

import WebSocket from "ws"

const LIVE_MODEL = "gemini-3.5-transcribe-live"
const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

// Reconnect backoff, so a dropped network doesn't spin the CPU.
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000

export type LiveSource = "them" | "you"

/** The subset of the Live API's server messages this client acts on. */
interface LiveServerMessage {
  setupComplete?: Record<string, unknown>
  voiceActivity?: { type?: string; audioOffset?: string }
  serverContent?: {
    interimInputTranscription?: { text?: string }
    inputTranscription?: { text?: string }
    turnComplete?: boolean
  }
}

export interface LiveTranscriberCallbacks {
  /** Partial text for the current utterance - replaces the previous interim. */
  onInterim: (source: LiveSource, text: string) => void
  /** Finalised text - append to the transcript. */
  onFinal: (source: LiveSource, text: string) => void
  /** The speaker stopped talking; a good moment to answer. */
  onTurnEnd: (source: LiveSource) => void
}

/**
 * One persistent Live-API socket per audio source. Audio frames are pushed in
 * as raw 16 kHz mono PCM16; transcripts come back out through the callbacks.
 */
class LiveSocket {
  private readonly source: LiveSource
  private readonly apiKey: string
  private readonly callbacks: LiveTranscriberCallbacks

  private ws: WebSocket | null = null
  private ready = false
  private closed = false
  private reconnectDelay = RECONNECT_BASE_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** Frames that arrived before the socket finished its handshake. */
  private pending: string[] = []
  private static readonly MAX_PENDING = 40 // ~4s of audio

  constructor(source: LiveSource, apiKey: string, callbacks: LiveTranscriberCallbacks) {
    this.source = source
    this.apiKey = apiKey
    this.callbacks = callbacks
  }

  connect(): void {
    if (this.closed || this.ws) return

    try {
      const ws = new WebSocket(`${LIVE_URL}?key=${this.apiKey}`)
      this.ws = ws

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${LIVE_MODEL}`,
              generationConfig: { responseModalities: ["TEXT"] },
              // Ask the server to transcribe what we send it. Without this the
              // model would answer the audio rather than transcribe it.
              inputAudioTranscription: {}
            }
          })
        )
      })

      ws.on("message", (data: WebSocket.RawData) => this.handleMessage(data))

      ws.on("error", (err: Error) => {
        console.warn(`Live transcriber (${this.source}) error:`, err.message)
      })

      ws.on("close", () => {
        this.ready = false
        this.ws = null
        if (!this.closed) this.scheduleReconnect()
      })
    } catch (err) {
      console.warn(`Live transcriber (${this.source}) could not connect:`, err)
      this.scheduleReconnect()
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: LiveServerMessage
    try {
      message = JSON.parse(data.toString()) as LiveServerMessage
    } catch {
      return
    }

    if (message.setupComplete) {
      this.ready = true
      this.reconnectDelay = RECONNECT_BASE_MS
      // Flush anything captured during the handshake so no speech is lost.
      const queued = this.pending
      this.pending = []
      queued.forEach((frame) => this.sendFrame(frame))
      return
    }

    const content = message.serverContent
    if (!content) return

    const interim = content.interimInputTranscription?.text
    if (interim) this.callbacks.onInterim(this.source, interim)

    const final = content.inputTranscription?.text
    if (final) this.callbacks.onFinal(this.source, final)

    // Either an explicit end-of-speech signal or the end of a model turn means
    // the speaker has stopped - the moment an answer is most useful.
    const activityEnd = message.voiceActivity?.type === "ACTIVITY_END"
    if (activityEnd || content.turnComplete) {
      this.callbacks.onTurnEnd(this.source)
    }
  }

  /** Push one frame of base64-encoded PCM16 @ 16 kHz mono. */
  push(base64Pcm: string): void {
    if (this.closed) return

    if (!this.ready) {
      // Buffer a short window; drop the oldest rather than grow without bound.
      this.pending.push(base64Pcm)
      if (this.pending.length > LiveSocket.MAX_PENDING) this.pending.shift()
      if (!this.ws) this.connect()
      return
    }

    this.sendFrame(base64Pcm)
  }

  private sendFrame(base64Pcm: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" }
          }
        })
      )
    } catch (err) {
      console.warn(`Live transcriber (${this.source}) send failed:`, err)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  close(): void {
    this.closed = true
    this.ready = false
    this.pending = []
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
  }
}

/**
 * Owns one streaming socket per source. Lazily connects on the first frame so
 * no socket is opened for a source the user never captures.
 */
export class LiveTranscriber {
  private sockets = new Map<LiveSource, LiveSocket>()
  private apiKey: string
  private callbacks: LiveTranscriberCallbacks

  constructor(apiKey: string, callbacks: LiveTranscriberCallbacks) {
    this.apiKey = apiKey
    this.callbacks = callbacks
  }

  pushFrame(source: LiveSource, base64Pcm: string): void {
    let socket = this.sockets.get(source)
    if (!socket) {
      socket = new LiveSocket(source, this.apiKey, this.callbacks)
      this.sockets.set(source, socket)
      socket.connect()
    }
    socket.push(base64Pcm)
  }

  close(): void {
    this.sockets.forEach((socket) => socket.close())
    this.sockets.clear()
  }
}
