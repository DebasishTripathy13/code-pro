// AssistantHelper.ts
//
// Real-time meeting/interview assistant: takes continuously captured audio
// (system loopback = the other person, microphone = the user), transcribes it,
// keeps a rolling transcript, and streams answers on demand or automatically
// when the other person asks a question.
//
// Everything here is best-effort. Audio is an *additional* input channel; if a
// provider can't transcribe, or a request fails, the app must keep working via
// the existing screenshot flow without surfacing hard errors.

import fs from "node:fs"
import path from "node:path"
import { app, BrowserWindow } from "electron"
import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import * as axios from "axios"
import { configHelper } from "./ConfigHelper"
import { LiveTranscriber, LiveSource } from "./LiveTranscriber"

export type TranscriptSource = "them" | "you"

export interface TranscriptSegment {
  id: string
  source: TranscriptSource
  text: string
  timestamp: number
}

interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export const ASSISTANT_EVENTS = {
  TRANSCRIPT_UPDATE: "assistant:transcript-update",
  INTERIM: "assistant:interim",
  STREAM_START: "assistant:stream-start",
  STREAM_CHUNK: "assistant:stream-chunk",
  STREAM_DONE: "assistant:stream-done",
  STREAM_ERROR: "assistant:stream-error",
  STATE: "assistant:state"
} as const

// Verified against the live API: the dedicated `gemini-3.5-transcribe` model
// returns an empty result for ordinary speech and has a much tighter quota,
// while the general flash model transcribes reliably. Measured, not assumed.
const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-flash"

// Fail-safe chain for answers. Free-tier quotas are counted per model, so a
// spent quota on one says nothing about the next.
//
// Ordered by measured time-to-answer rather than raw capability: this runs
// mid-conversation, where a fast good answer beats a slow better one. The
// newest models are excluded from the fallbacks because they were measured at
// 59s and 136s under load - fine as a deliberate choice in Settings, wrong as
// an automatic rescue path.
const GEMINI_ANSWER_FALLBACKS = [
  "gemini-3.1-flash-lite", // 0.8s median time-to-first-token
  "gemini-3.5-flash-lite", // 1.2s
  "gemini-3.7-flash" // 2.6s
]

/** Errors where a different model is likely to succeed. */
function isFailoverWorthy(error: any): boolean {
  const status = error?.response?.status ?? error?.status
  return status === 429 || status === 404 || status === 503 || status === 500
}

/**
 * Read the body of a failed streaming request.
 *
 * With responseType "stream" axios hands back an unread IncomingMessage as
 * `error.response.data`, so the provider's actual message never reaches the
 * logs or the user - every failure just says "Request failed with status code
 * 400". Draining it turns that into the real reason.
 */
async function readStreamError(error: any): Promise<string> {
  const data = error?.response?.data
  if (!data || typeof data.on !== "function") {
    return error?.response?.data?.error?.message || error?.message || ""
  }

  try {
    const body: string = await new Promise((resolve) => {
      let raw = ""
      const done = () => resolve(raw)
      data.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8")
        if (raw.length > 8192) done()
      })
      data.on("end", done)
      data.on("error", done)
      setTimeout(done, 3000)
    })
    try {
      return JSON.parse(body)?.error?.message || body.slice(0, 300)
    } catch {
      return body.slice(0, 300)
    }
  } catch {
    return error?.message || ""
  }
}

const MAX_SEGMENTS = 400
const MAX_CONTEXT_CHARS = 6000
const MAX_HISTORY_TURNS = 8

const SYSTEM_PROMPT = `You are an invisible real-time assistant helping the user during a live conversation (job interview, meeting, or sales call). They are being looked at right now and cannot pause. Everything you write is something they have to read at a glance and say out loud in their own voice.

Format:
- First sentence IS the answer, phrased so it can be spoken verbatim. No preamble, no restating the question, no "Great question".
- Then at most 4 short bullets carrying the specifics: numbers, names, trade-offs, a concrete example.
- Front-load the words that matter. They are reading the first few words while still talking.

Substance:
- Be concrete. Never say "it depends" without immediately saying what it depends on.
- Prefer a real number, version, or name over a hedge. If you are unsure, give the most likely answer and mark it with "roughly" or "I think" - that is what a human would say, and it is honest.
- If they'd be asked "why" straight after, pre-empt it in one bullet.
- Match the vocabulary already used in the transcript - their stack, their domain, their words.
- If the question is ambiguous, answer the most likely reading. Do not ask a clarifying question; they cannot relay it.

Behavioural questions:
- Give a first-person answer with a specific situation, what they did, and the outcome. Keep it to a few sentences, not a full STAR essay.

Code:
- Complete and runnable, minimal comments, then one line on complexity.
- Follow it with one sentence they can say about how it works - the reasoning is what gets marked, not the syntax.

Using the conversation so far:
- You are given the live transcript and your own earlier answers. Treat them as one continuous session, not isolated questions.
- Follow-ups are usually elliptical: "explain that again", "simpler", "what about duplicates", "why not a heap", "and the complexity?". Resolve them against your previous answer - never ask what they are referring to.
- "Simpler" / "shorter" means rewrite the SAME answer more plainly, not answer a different question.
- Do not repeat what you already said. Add the new part and say only what changed.
- If the interviewer has already been told something in the transcript, do not contradict it. Build on what the user has committed to, even if you would have chosen differently.
- Use names, numbers and technologies that already appeared in the transcript rather than generic placeholders.

Never mention being an AI, never describe what you are about to do, never apologise, never pad.`

export class AssistantHelper {
  private getMainWindow: () => BrowserWindow | null

  private openaiClient: OpenAI | null = null
  private anthropicClient: Anthropic | null = null
  private geminiApiKey: string | null = null

  private segments: TranscriptSegment[] = []
  private history: ChatTurn[] = []
  private abortController: AbortController | null = null
  private isStreaming = false

  private liveTranscriber: LiveTranscriber | null = null
  private liveApiKey: string | null = null

  // Not every Gemini model accepts `thinkingConfig` - the lite and transcribe
  // models reject it outright with a 400. We learn which ones at runtime so
  // the failed round-trip is paid at most once per model per session.
  private modelsRejectingThinkingConfig = new Set<string>()

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow
    this.initializeClients()
    configHelper.on("config-updated", () => {
      this.initializeClients()
      // Provider or key changed - drop the live socket so it reconnects with
      // the new credentials on the next frame.
      this.closeLiveTranscriber()
    })
  }

  // ------------------------------------------------------- streaming capture

  /** True when the configured provider supports the streaming speech socket. */
  public supportsLiveStreaming(): boolean {
    return configHelper.loadConfig().apiProvider === "gemini"
  }

  private closeLiveTranscriber(): void {
    this.liveTranscriber?.close()
    this.liveTranscriber = null
    this.liveApiKey = null
  }

  /**
   * Feed one frame of raw PCM16 @16 kHz mono from the renderer into the live
   * transcription socket. Returns false when live streaming isn't available,
   * so the renderer can fall back to batched WAV segments.
   */
  public pushAudioFrame(source: LiveSource, base64Pcm: string): boolean {
    const config = configHelper.loadConfig()
    if (config.apiProvider !== "gemini" || !config.apiKey) return false

    if (!this.liveTranscriber || this.liveApiKey !== config.apiKey) {
      this.closeLiveTranscriber()
      this.liveApiKey = config.apiKey
      this.liveTranscriber = new LiveTranscriber(config.apiKey, {
        onInterim: (src, text) => {
          this.emit(ASSISTANT_EVENTS.INTERIM, { source: src, text })
        },
        onFinal: (src, text) => {
          this.addSegment(src, text)
        },
        onTurnEnd: (src) => {
          this.emit(ASSISTANT_EVENTS.INTERIM, { source: src, text: "" })
        }
      })
    }

    this.liveTranscriber.pushFrame(source, base64Pcm)
    return true
  }

  public stopLiveCapture(): void {
    this.closeLiveTranscriber()
  }

  private initializeClients(): void {
    try {
      const config = configHelper.loadConfig()
      this.openaiClient = null
      this.anthropicClient = null
      this.geminiApiKey = null

      if (!config.apiKey) return

      if (config.apiProvider === "openai") {
        this.openaiClient = new OpenAI({ apiKey: config.apiKey, timeout: 60000, maxRetries: 1 })
      } else if (config.apiProvider === "gemini") {
        this.geminiApiKey = config.apiKey
      } else if (config.apiProvider === "anthropic") {
        this.anthropicClient = new Anthropic({ apiKey: config.apiKey, timeout: 60000, maxRetries: 1 })
      }
    } catch (error) {
      console.error("AssistantHelper: failed to initialize clients", error)
    }
  }

  private emit(channel: string, payload?: unknown): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }

  // ---------------------------------------------------------------- transcript

  public getTranscript(): TranscriptSegment[] {
    return this.segments
  }

  public clearTranscript(): void {
    this.segments = []
    this.history = []
    this.emit(ASSISTANT_EVENTS.TRANSCRIPT_UPDATE, this.segments)
  }

  private addSegment(source: TranscriptSource, text: string): void {
    const clean = text.trim()
    if (!clean) return

    const last = this.segments[this.segments.length - 1]
    // Merge consecutive fragments from the same speaker inside a short window
    // so the panel reads as sentences rather than 5-second slivers.
    if (last && last.source === source && Date.now() - last.timestamp < 6000) {
      last.text = `${last.text} ${clean}`.trim()
      last.timestamp = Date.now()
    } else {
      this.segments.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        text: clean,
        timestamp: Date.now()
      })
    }

    // Metadata only - never write transcript content to stdout/log files.
    // What's said on a call must not end up in a log the user forgets about.
    console.log(
      `[transcript] ${source} +${clean.length} chars` +
        (process.env.IC_DEBUG_TRANSCRIPT === "1" ? ` :: ${clean}` : "")
    )

    if (this.segments.length > MAX_SEGMENTS) {
      this.segments = this.segments.slice(-MAX_SEGMENTS)
    }

    this.emit(ASSISTANT_EVENTS.TRANSCRIPT_UPDATE, this.segments)
  }

  /** Transcript rendered for prompting, newest-last, bounded in size. */
  private transcriptContext(): string {
    const lines = this.segments.map(
      (s) => `${s.source === "them" ? "Them" : "Me"}: ${s.text}`
    )
    let text = lines.join("\n")
    if (text.length > MAX_CONTEXT_CHARS) {
      text = text.slice(text.length - MAX_CONTEXT_CHARS)
    }
    return text
  }

  /** The most recent thing the other person said - what we should answer. */
  private lastQuestionFromThem(): string | null {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].source === "them" && this.segments[i].text.trim()) {
        return this.segments[i].text.trim()
      }
    }
    return null
  }

  // ------------------------------------------------------------ transcription

  public async transcribeChunk(
    base64Data: string,
    mimeType: string,
    source: TranscriptSource
  ): Promise<{ success: boolean; text?: string; error?: string }> {
    if (!base64Data) return { success: false, error: "No audio data" }

    const config = configHelper.loadConfig()
    try {
      let text = ""

      if (config.apiProvider === "openai") {
        text = await this.transcribeWithWhisper(base64Data, mimeType)
      } else if (config.apiProvider === "gemini") {
        text = await this.transcribeWithGemini(base64Data, mimeType)
      } else {
        // Anthropic has no speech-to-text endpoint.
        return { success: false, error: "unsupported-provider" }
      }

      const cleaned = this.cleanTranscription(text)
      if (cleaned) this.addSegment(source, cleaned)
      return { success: true, text: cleaned }
    } catch (error: any) {
      console.warn("Transcription failed:", error?.message || error)
      return { success: false, error: error?.message || "Transcription failed" }
    }
  }

  /** Whisper/Gemini both hallucinate stock phrases on silence - drop those. */
  private cleanTranscription(text: string): string {
    const cleaned = (text || "").trim()
    if (!cleaned) return ""

    const noise = [
      "you",
      "thank you.",
      "thanks for watching!",
      "thank you for watching.",
      "subscribe",
      ".",
      "[silence]",
      "(silence)",
      "[music]",
      "[blank_audio]"
    ]
    if (noise.includes(cleaned.toLowerCase())) return ""
    if (cleaned.length < 2) return ""
    return cleaned
  }

  private async transcribeWithWhisper(base64Data: string, mimeType: string): Promise<string> {
    if (!this.openaiClient) {
      this.initializeClients()
      if (!this.openaiClient) throw new Error("OpenAI client not configured")
    }

    const tempPath = this.writeTempAudio(base64Data, mimeType)
    try {
      const result = await this.openaiClient.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: "whisper-1",
        // Nudges Whisper toward technical vocabulary instead of phonetic guesses.
        // Whisper uses this as a vocabulary hint, so name the terms it
        // otherwise mangles into everyday words.
        prompt:
          "Technical job interview. Terms: algorithm, array, hash map, binary search, recursion, DFS, BFS, big O, O(n log n), time complexity, space complexity, API, async, latency, throughput, database, index, cache, Kubernetes, TypeScript, Python."
      })
      return result?.text || ""
    } finally {
      fs.unlink(tempPath, () => {})
    }
  }

  private async transcribeWithGemini(base64Data: string, mimeType: string): Promise<string> {
    if (!this.geminiApiKey) throw new Error("Gemini API key not configured")

    const contents = [
      {
        role: "user",
        parts: [
          {
            text: "Transcribe this audio verbatim. Return ONLY the spoken words - no commentary, no speaker labels, no quotes, no timestamps. This is a technical interview, so prefer engineering terms over phonetically similar everyday words (\"array\" not \"a ray\", \"async\" not \"a sink\", \"O of n\" not \"oh of an\"). If there is no intelligible speech, return an empty response rather than guessing."
          },
          { inlineData: { mimeType: this.geminiAudioMime(mimeType), data: base64Data } }
        ]
      }
    ]

    const response = await axios.default.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent?key=${this.geminiApiKey}`,
      {
        contents,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1000,
          // A verbatim transcript needs no deliberation, and thinking tokens
          // would otherwise eat the output budget and add seconds of latency.
          thinkingConfig: { thinkingBudget: 0 }
        }
      },
      { timeout: 30000 }
    )

    const data: any = response.data
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
  }

  private geminiAudioMime(mimeType: string): string {
    // Gemini accepts wav/mp3/ogg/flac/aac/aiff. We record WAV specifically so
    // the same chunk works for every provider.
    if (mimeType.includes("wav")) return "audio/wav"
    if (mimeType.includes("ogg")) return "audio/ogg"
    if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "audio/mp3"
    return "audio/wav"
  }

  private writeTempAudio(base64Data: string, mimeType: string): string {
    const ext = mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp3") || mimeType.includes("mpeg")
      ? "mp3"
      : "webm"
    const tempPath = path.join(
      app.getPath("temp"),
      `assistant-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    )
    fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"))
    return tempPath
  }

  // ------------------------------------------------------------------ answers

  public stop(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.isStreaming) {
      this.isStreaming = false
      this.emit(ASSISTANT_EVENTS.STREAM_DONE, { aborted: true })
    }
  }

  /** Answer whatever the other person most recently said. */
  public async answerLatest(screenshotBase64?: string): Promise<{ success: boolean; error?: string }> {
    const question = this.lastQuestionFromThem()
    if (!question) {
      return { success: false, error: "Nothing has been heard yet" }
    }
    return this.ask(question, { screenshotBase64, isAuto: true })
  }

  /**
   * Ask anything. Transcript so far is always supplied as context, plus an
   * optional screenshot of what's on screen, plus recent chat history so
   * follow-ups like "explain that differently" work.
   */
  public async ask(
    question: string,
    opts: { screenshotBase64?: string; isAuto?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> {
    const config = configHelper.loadConfig()
    if (!config.apiKey) {
      this.emit(ASSISTANT_EVENTS.STREAM_ERROR, "No API key configured. Open settings to add one.")
      return { success: false, error: "No API key configured" }
    }

    this.stop()
    this.abortController = new AbortController()
    this.isStreaming = true

    const transcript = this.transcriptContext()
    const userPrompt = this.buildUserPrompt(question, transcript, opts.isAuto)

    this.emit(ASSISTANT_EVENTS.STREAM_START, {
      question,
      isAuto: Boolean(opts.isAuto)
    })

    let answer = ""
    const onChunk = (delta: string) => {
      if (!delta) return
      answer += delta
      this.emit(ASSISTANT_EVENTS.STREAM_CHUNK, delta)
    }

    try {
      if (config.apiProvider === "openai") {
        await this.streamOpenAI(userPrompt, opts.screenshotBase64, onChunk)
      } else if (config.apiProvider === "gemini") {
        await this.streamGemini(userPrompt, opts.screenshotBase64, onChunk)
      } else {
        await this.streamAnthropic(userPrompt, opts.screenshotBase64, onChunk)
      }

      this.history.push({ role: "user", content: question })
      this.history.push({ role: "assistant", content: answer })
      if (this.history.length > MAX_HISTORY_TURNS * 2) {
        this.history = this.history.slice(-MAX_HISTORY_TURNS * 2)
      }

      this.isStreaming = false
      this.abortController = null
      this.emit(ASSISTANT_EVENTS.STREAM_DONE, { answer })
      return { success: true }
    } catch (error: any) {
      this.isStreaming = false
      this.abortController = null

      if (error?.name === "AbortError" || axios.isCancel?.(error)) {
        this.emit(ASSISTANT_EVENTS.STREAM_DONE, { aborted: true })
        return { success: true }
      }

      const message = this.friendlyError(error)
      console.error("Assistant streaming failed:", error)
      this.emit(ASSISTANT_EVENTS.STREAM_ERROR, message)
      return { success: false, error: message }
    }
  }

  private friendlyError(error: any): string {
    const status = error?.status || error?.response?.status
    const apiMessage =
      error?.__reason ||
      error?.response?.data?.error?.message ||
      error?.error?.message ||
      error?.message ||
      ""

    // Google returns 400 INVALID_ARGUMENT for a revoked key, not 401.
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(apiMessage)) {
      return "API key rejected - it may have been revoked or regenerated. Enter a new one in Settings."
    }
    if (status === 429) return "Rate limited by the provider. Wait a moment and try again."
    if (status === 500 || status === 503) return "The provider is having issues. Try again."
    return error?.message || "Request failed"
  }

  private buildUserPrompt(question: string, transcript: string, isAuto?: boolean): string {
    const parts: string[] = []

    if (transcript) {
      parts.push(`Live conversation so far (Them = the other person, Me = the user):\n${transcript}`)
    }

    if (isAuto) {
      parts.push(
        `The other person just said: "${question}"

Give the user what to say back, right now. If that was a question, answer it. If it was a statement, give the reply that moves the conversation forward. If it needs no response, say so in three words rather than inventing something to say.`
      )
    } else {
      parts.push(
        `The user typed this to you privately - the other person cannot see it: ${question}

Answer it directly. If it reads like a question the interviewer just asked, give them words to say back; if it reads like a request for information, just give the information.`
      )
    }

    return parts.join("\n\n")
  }

  // ------------------------------------------------------- provider streaming

  private async streamOpenAI(
    prompt: string,
    screenshotBase64: string | undefined,
    onChunk: (delta: string) => void
  ): Promise<void> {
    if (!this.openaiClient) {
      this.initializeClients()
      if (!this.openaiClient) throw new Error("OpenAI client not configured")
    }

    const config = configHelper.loadConfig()
    const userContent: any[] = [{ type: "text", text: prompt }]
    if (screenshotBase64) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${screenshotBase64}` }
      })
    }

    const stream = await this.openaiClient.chat.completions.create(
      {
        model: config.solutionModel || "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...this.history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: "user", content: userContent }
        ] as any,
        max_tokens: 4000,
        temperature: 0.3,
        stream: true
      },
      { signal: this.abortController?.signal }
    )

    for await (const part of stream) {
      onChunk(part.choices?.[0]?.delta?.content || "")
    }
  }

  private async streamAnthropic(
    prompt: string,
    screenshotBase64: string | undefined,
    onChunk: (delta: string) => void
  ): Promise<void> {
    if (!this.anthropicClient) {
      this.initializeClients()
      if (!this.anthropicClient) throw new Error("Anthropic client not configured")
    }

    const config = configHelper.loadConfig()
    const content: any[] = [{ type: "text", text: prompt }]
    if (screenshotBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshotBase64 }
      })
    }

    const stream = await this.anthropicClient.messages.create(
      {
        model: config.solutionModel || "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [
          ...this.history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: "user" as const, content }
        ] as any,
        stream: true
      },
      { signal: this.abortController?.signal }
    )

    for await (const event of stream as any) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        onChunk(event.delta.text || "")
      }
    }
  }

  private async streamGemini(
    prompt: string,
    screenshotBase64: string | undefined,
    onChunk: (delta: string) => void
  ): Promise<void> {
    if (!this.geminiApiKey) {
      this.initializeClients()
      if (!this.geminiApiKey) throw new Error("Gemini API key not configured")
    }

    const config = configHelper.loadConfig()
    const model = config.solutionModel || "gemini-3.5-flash"

    const parts: any[] = [{ text: prompt }]
    if (screenshotBase64) {
      parts.push({ inlineData: { mimeType: "image/png", data: screenshotBase64 } })
    }

    const contents = [
      ...this.history.map((turn) => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.content }]
      })),
      { role: "user", parts }
    ]

    const requestBody = (withThinkingConfig: boolean) => ({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: {
        temperature: 0.3,
        // Generous cap: thinking tokens (when enabled) and long code answers
        // both draw from this budget, and hitting it truncates mid-sentence.
        maxOutputTokens: 4000,
        // thinkingConfig is OFF by default here. Disabling thinking did cut
        // time-to-first-token on gemini-3.5-flash (~6.5s to ~4.0s), but the
        // lite models reject the field outright with a 400 and that broke the
        // chat box entirely. Measured server-side variance (1s to 46s for an
        // identical request) dwarfs the saving, so correctness wins; the
        // retry below still handles it if it is ever turned back on.
        ...(withThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    })

    const send = (targetModel: string, withThinkingConfig: boolean) =>
      axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${this.geminiApiKey}`,
        requestBody(withThinkingConfig),
        { responseType: "stream", signal: this.abortController?.signal as any }
      )

    // Fail-safe: walk a chain of models so a spent per-model quota, a retired
    // model or an overloaded one doesn't leave the user with no answer.
    const chain = Array.from(new Set([model, ...GEMINI_ANSWER_FALLBACKS]))
    let response
    let lastError: any

    for (const candidate of chain) {
      // Never send thinkingConfig on the first attempt - see requestBody.
      const skipThinkingConfig = true
      try {
        response = await send(candidate, !skipThinkingConfig)
      } catch (error: any) {
        // Lite/transcribe models answer "Request contains an invalid argument"
        // when handed a thinkingConfig. Retry once without it before giving up
        // on this model.
        const status = error?.response?.status ?? error?.status
        const reason = await readStreamError(error)
        console.warn(`Assistant: ${candidate} failed (${status}): ${reason}`)
        error.__reason = reason

        if (!skipThinkingConfig && status === 400) {
          this.modelsRejectingThinkingConfig.add(candidate)
          try {
            response = await send(candidate, false)
          } catch (retryError: any) {
            lastError = retryError
            if (!isFailoverWorthy(retryError)) throw retryError
            continue
          }
        } else {
          lastError = error
          if (!isFailoverWorthy(error)) throw error
          console.warn(
            `Assistant: ${candidate} unavailable (${error?.response?.status}); trying next model`
          )
          continue
        }
      }

      if (candidate !== chain[0]) {
        console.log(`Assistant fell back to ${candidate}`)
      }
      break
    }

    if (!response) throw lastError

    await new Promise<void>((resolve, reject) => {
      const stream = response.data as NodeJS.ReadableStream
      let buffer = ""

      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === "[DONE]") continue
          try {
            const json = JSON.parse(payload)
            const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
            if (text) onChunk(text)
          } catch {
            // Partial JSON across chunk boundaries - safe to skip.
          }
        }
      })

      stream.on("end", () => resolve())
      stream.on("error", (err: Error) => reject(err))
    })
  }
}
