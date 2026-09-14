/**
 * Continuous, silent speech capture for the live assistant.
 *
 * Two independent sources are captured so the transcript knows who spoke:
 *   - "them": system/loopback audio, i.e. the interviewer on the call
 *   - "you":  the microphone
 *
 * Two output modes, chosen by what the configured provider supports:
 *
 *  - "stream" (Gemini): every frame is forwarded as raw PCM16 to a live
 *    transcription socket, so words come back while the person is still
 *    speaking and the server handles turn detection.
 *  - "batch" (OpenAI/Anthropic): a local voice-activity detector buffers
 *    until the speaker pauses, then emits one 16 kHz mono WAV. Slower, but
 *    it works anywhere - webm/opus is not portable across providers.
 */

const SAMPLE_RATE = 16000
const FRAME_SIZE = 4096

// Tuning
const SILENCE_RMS = 0.008 // below this a frame counts as silence
const SILENCE_HANG_MS = 700 // pause length that ends a segment
const MIN_SPEECH_MS = 500 // ignore coughs/clicks shorter than this
const MAX_SEGMENT_MS = 14000 // force a flush so long answers still stream in
const PREROLL_MS = 300 // audio kept before speech starts, so no clipped words

export type CaptureSource = "them" | "you"

export interface SegmentPayload {
  base64: string
  mimeType: string
  source: CaptureSource
  durationMs: number
}

/**
 * How audio leaves the renderer.
 *  - "stream": every frame is forwarded immediately as raw PCM to a live
 *    transcription socket. Words come back while the person is still speaking.
 *  - "batch": frames are buffered locally until the speaker pauses, then sent
 *    as one WAV. Slower, but works on providers with no streaming endpoint.
 */
export type CaptureMode = "stream" | "batch"

export interface CaptureHandlers {
  /** Called for every frame in "stream" mode with base64 PCM16 @16 kHz. */
  onFrame?: (source: CaptureSource, base64Pcm: string) => void
  /** Called per utterance in "batch" mode. */
  onSegment?: (segment: SegmentPayload) => void
}

/**
 * Wraps one MediaStream: buffers PCM, detects speech, emits WAV segments.
 */
class SourceRecorder {
  private readonly source: CaptureSource
  private readonly mode: CaptureMode
  private readonly handlers: CaptureHandlers

  private context: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private input: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null

  private speech: Float32Array[] = []
  private preroll: Float32Array[] = []
  private prerollFrames: number
  private speechSamples = 0
  private silenceMs = 0
  private isSpeaking = false

  constructor(source: CaptureSource, mode: CaptureMode, handlers: CaptureHandlers) {
    this.source = source
    this.mode = mode
    this.handlers = handlers
    this.prerollFrames = Math.max(1, Math.ceil((PREROLL_MS / 1000) * SAMPLE_RATE / FRAME_SIZE))
  }

  attach(stream: MediaStream): void {
    this.stream = stream

    // Asking for 16 kHz directly lets the browser resample for us, so we
    // never have to write a downsampler.
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.input = this.context.createMediaStreamSource(stream)

    // ScriptProcessorNode is deprecated in favour of AudioWorklet, but a
    // worklet needs a separately loaded module file; inside a packaged
    // Electron app this is the reliable option and the CPU cost at 16 kHz
    // mono is negligible.
    this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1)
    this.processor.onaudioprocess = (event) => this.handleFrame(event.inputBuffer.getChannelData(0))

    this.input.connect(this.processor)
    // Route to a muted gain node: the processor only ticks while connected to
    // a destination, but we must never play the captured audio back (that
    // would echo the call into the call).
    const mute = this.context.createGain()
    mute.gain.value = 0
    this.processor.connect(mute)
    mute.connect(this.context.destination)
  }

  private handleFrame(frame: Float32Array): void {
    const copy = new Float32Array(frame)

    // Streaming mode: ship every frame straight out. The server does its own
    // voice-activity detection and turn segmentation, so none of the local
    // buffering below applies.
    if (this.mode === "stream") {
      try {
        this.handlers.onFrame?.(this.source, encodePcm16Base64(copy))
      } catch (err) {
        console.warn(`Failed to forward ${this.source} audio frame:`, err)
      }
      return
    }

    const rms = computeRms(copy)
    const frameMs = (copy.length / SAMPLE_RATE) * 1000

    if (rms >= SILENCE_RMS) {
      if (!this.isSpeaking) {
        // Speech just started - prepend the pre-roll so the first syllable
        // isn't cut off.
        this.isSpeaking = true
        this.speech = [...this.preroll]
        this.speechSamples = this.preroll.reduce((n, f) => n + f.length, 0)
        this.preroll = []
      }
      this.speech.push(copy)
      this.speechSamples += copy.length
      this.silenceMs = 0
    } else if (this.isSpeaking) {
      // Keep trailing silence inside the segment - it helps the model know
      // the sentence ended.
      this.speech.push(copy)
      this.speechSamples += copy.length
      this.silenceMs += frameMs
    } else {
      this.preroll.push(copy)
      if (this.preroll.length > this.prerollFrames) this.preroll.shift()
    }

    const segmentMs = (this.speechSamples / SAMPLE_RATE) * 1000
    if (this.isSpeaking && (this.silenceMs >= SILENCE_HANG_MS || segmentMs >= MAX_SEGMENT_MS)) {
      this.flush()
    }
  }

  private flush(): void {
    const frames = this.speech
    const totalSamples = this.speechSamples
    const durationMs = (totalSamples / SAMPLE_RATE) * 1000

    this.speech = []
    this.speechSamples = 0
    this.silenceMs = 0
    this.isSpeaking = false

    // Ignore blips that are almost certainly not speech.
    const speechMs = durationMs - SILENCE_HANG_MS
    if (speechMs < MIN_SPEECH_MS || totalSamples === 0) return

    try {
      const pcm = concatFloat32(frames, totalSamples)
      const wav = encodeWav(pcm, SAMPLE_RATE)
      this.handlers.onSegment?.({
        base64: arrayBufferToBase64(wav),
        mimeType: "audio/wav",
        source: this.source,
        durationMs
      })
    } catch (err) {
      console.warn(`Failed to encode ${this.source} audio segment:`, err)
    }
  }

  stop(): void {
    try {
      this.processor?.disconnect()
      this.input?.disconnect()
    } catch {
      /* already torn down */
    }
    if (this.processor) this.processor.onaudioprocess = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.context?.close().catch(() => {})

    this.processor = null
    this.input = null
    this.context = null
    this.stream = null
    this.speech = []
    this.preroll = []
  }
}

export interface LiveCaptureStatus {
  micActive: boolean
  systemActive: boolean
}

/**
 * Starts capture of both sources. Either one may fail (no mic, loopback
 * unsupported on Linux, permission refused) - whatever is available is used.
 * Returns a stop function plus what actually came up.
 */
export async function startLiveCapture(
  mode: CaptureMode,
  handlers: CaptureHandlers
): Promise<{ stop: () => void; status: LiveCaptureStatus }> {
  const recorders: SourceRecorder[] = []
  const status: LiveCaptureStatus = { micActive: false, systemActive: false }

  // System audio (the other person). The main process answers the
  // display-media request programmatically, so no picker dialog appears.
  try {
    const systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    })
    // We only ever wanted the audio - drop the video track immediately so no
    // frames are encoded and no recording indicator lingers longer than needed.
    systemStream.getVideoTracks().forEach((track) => track.stop())

    if (systemStream.getAudioTracks().length > 0) {
      const recorder = new SourceRecorder("them", mode, handlers)
      recorder.attach(new MediaStream(systemStream.getAudioTracks()))
      recorders.push(recorder)
      status.systemActive = true
    }
  } catch (err) {
    console.warn("System audio capture unavailable:", err)
  }

  // Microphone (the user). Echo cancellation keeps the speaker output from
  // being transcribed twice.
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const recorder = new SourceRecorder("you", mode, handlers)
    recorder.attach(micStream)
    recorders.push(recorder)
    status.micActive = true
  } catch (err) {
    console.warn("Microphone capture unavailable:", err)
  }

  return {
    stop: () => recorders.forEach((r) => r.stop()),
    status
  }
}

// ------------------------------------------------------------------ helpers

/** Float32 [-1,1] -> base64 of little-endian PCM16, what the Live API expects. */
function encodePcm16Base64(samples: Float32Array): string {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return arrayBufferToBase64(buffer)
}

function computeRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concatFloat32(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/** 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, "data")
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }

  return buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const CHUNK = 0x8000 // avoid blowing the argument limit on large buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
