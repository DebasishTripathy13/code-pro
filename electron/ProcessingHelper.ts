// ProcessingHelper.ts
import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { app, BrowserWindow, dialog } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import Anthropic from '@anthropic-ai/sdk';

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }>;
}
export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()
    
    // Initialize AI client based on config
    this.initializeAIClient();
    
    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      this.initializeAIClient();
    });
  }
  
  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      
      if (config.apiProvider === "openai") {
        if (config.apiKey) {
          this.openaiClient = new OpenAI({ 
            apiKey: config.apiKey,
            timeout: 60000, // 60 second timeout
            maxRetries: 2   // Retry up to 2 times
          });
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.log("OpenAI client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else if (config.apiProvider === "gemini"){
        // Gemini client initialization
        this.openaiClient = null;
        this.anthropicClient = null;
        if (config.apiKey) {
          this.geminiApiKey = config.apiKey;
          console.log("Gemini API key set successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Gemini client not initialized");
        }
      } else if (config.apiProvider === "anthropic") {
        // Reset other clients
        this.openaiClient = null;
        this.geminiApiKey = null;
        if (config.apiKey) {
          this.anthropicClient = new Anthropic({
            apiKey: config.apiKey,
            timeout: 60000,
            maxRetries: 2
          });
          console.log("Anthropic client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Anthropic client not initialized");
        }
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;
    }
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      
      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  /**
   * Models to fall back to, in order, when the chosen one can't serve the
   * request. Free-tier keys have a *per-model* daily request cap, so a spent
   * quota on one model says nothing about the others - falling back keeps the
   * app working instead of dead until midnight.
   *
   * Verified available on the live API; ordered strongest-first.
   */
  /**
   * How long to wait for the first token before abandoning a model. Measured
   * free-tier first-token times ranged from 1s to 46s for identical requests,
   * so a generous-but-finite cap turns a stall into a retry.
   */
  private static readonly FIRST_TOKEN_TIMEOUT_MS = 20000

  // Ordered by measured median time-to-first-token (3 streaming runs each),
  // strongest-but-still-quick first. gemini-2.5-flash was dropped: it came in
  // at 11.1s, four times slower than anything else here, and 2.5-pro and
  // 2.5-flash-lite are retired outright.
  private static readonly GEMINI_FALLBACKS = [
    "gemini-3.7-flash", // 2.6s
    "gemini-3.5-flash", // 3.4s
    "gemini-3.5-flash-lite", // 1.2s
    "gemini-3.1-flash-lite" // 0.8s - last resort, always fast
  ]

  private geminiModelChain(preferred: string | undefined): string[] {
    const chain = [preferred, ...ProcessingHelper.GEMINI_FALLBACKS].filter(
      (model): model is string => Boolean(model)
    )
    return Array.from(new Set(chain))
  }

  /** Errors where trying a different model is likely to succeed. */
  private isFailoverWorthy(error: any): boolean {
    const status = error?.response?.status ?? error?.status
    // 429 spent quota / rate limit, 404 retired model, 5xx provider trouble.
    return status === 429 || status === 404 || status === 503 || status === 500
  }

  /**
   * POST to Gemini, walking the fallback chain when a model is out of quota,
   * retired, or overloaded. Throws the last error if every model fails.
   */
  private async callGeminiWithFallback(
    preferredModel: string | undefined,
    body: unknown,
    signal: AbortSignal,
    label: string
  ): Promise<{ data: any; model: string }> {
    const models = this.geminiModelChain(preferredModel)
    let lastError: any

    for (const model of models) {
      try {
        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiApiKey}`,
          body,
          { signal }
        )

        if (model !== models[0]) {
          console.log(`[${label}] fell back to ${model} (${models[0]} unavailable)`)
          this.notifyStatus(`Using ${model} - your preferred model was unavailable`)
        }
        return { data: response.data, model }
      } catch (error: any) {
        // Never burn the chain on a user cancellation.
        if (axios.isCancel(error)) throw error

        lastError = error
        if (!this.isFailoverWorthy(error)) throw error

        const status = error?.response?.status
        console.warn(`[${label}] ${model} failed with ${status}; trying next model`)
      }
    }

    throw lastError
  }

  /**
   * Streaming counterpart to callGeminiWithFallback.
   *
   * The solve path used to wait for the whole response before rendering
   * anything - about 14s of blank screen (5s extraction + 9s solution) with
   * no sign of life. Streaming lets the code appear as it is written, which
   * is the difference between "frozen" and "working".
   */
  private async streamGeminiWithFallback(
    preferredModel: string | undefined,
    body: Record<string, unknown>,
    signal: AbortSignal,
    onChunk: (delta: string) => void,
    label: string
  ): Promise<{ text: string; model: string }> {
    const models = this.geminiModelChain(preferredModel)
    let lastError: any

    for (const model of models) {
      try {
        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.geminiApiKey}`,
          body,
          { responseType: "stream", signal }
        )

        if (model !== models[0]) {
          console.log(`[${label}] fell back to ${model} (${models[0]} unavailable)`)
          this.notifyStatus(`Using ${model} - your preferred model was unavailable`)
        }

        const text = await new Promise<string>((resolve, reject) => {
          const stream = response.data as NodeJS.ReadableStream
          let buffer = ""
          let full = ""

          // Free-tier latency is wildly inconsistent - the same request has
          // been measured returning in 1s and in 46s. Rather than sit through
          // a stall, give up on a model that has produced nothing yet and let
          // the fallback chain try the next one. Once tokens are flowing we
          // stop policing it, since a long answer is legitimately slow.
          let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            watchdog = null
            const stalled: any = new Error(
              `${model} produced no output within ${ProcessingHelper.FIRST_TOKEN_TIMEOUT_MS / 1000}s`
            )
            stalled.response = { status: 503 } // treat as retryable
            ;(stream as any).destroy?.()
            reject(stalled)
          }, ProcessingHelper.FIRST_TOKEN_TIMEOUT_MS)

          const clearWatchdog = () => {
            if (watchdog) {
              clearTimeout(watchdog)
              watchdog = null
            }
          }

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
                const parts = json?.candidates?.[0]?.content?.parts
                const delta = Array.isArray(parts)
                  ? parts.map((p: any) => p?.text).filter(Boolean).join("")
                  : ""
                if (delta) {
                  clearWatchdog()
                  full += delta
                  onChunk(delta)
                }
              } catch {
                // Partial JSON spanning a chunk boundary - safe to skip.
              }
            }
          })

          stream.on("end", () => {
            clearWatchdog()
            resolve(full)
          })
          stream.on("error", (err: Error) => {
            clearWatchdog()
            reject(err)
          })
        })

        if (!text.trim()) throw new Error("Gemini returned an empty response.")
        return { text, model }
      } catch (error: any) {
        if (axios.isCancel(error)) throw error
        lastError = error
        if (!this.isFailoverWorthy(error)) throw error
        console.warn(
          `[${label}] ${model} failed with ${error?.response?.status}; trying next model`
        )
      }
    }

    throw lastError
  }

  /**
   * Split a solution response into its labelled sections.
   *
   * This replaces a set of overlapping per-section regexes, each of which had
   * to know every heading that might follow it. That coupling caused real
   * bugs twice: space complexity silently failed to parse when it ended the
   * response, and adding an edge-cases section made the thoughts regex
   * swallow it. Finding the headings once and slicing between them means a
   * new section can be added without touching the others.
   */
  private static readonly SECTION_HEADINGS = [
    "code",
    "thoughts",
    "walkthrough",
    "edge cases",
    "time complexity",
    "space complexity"
  ]

  private splitSections(text: string): Record<string, string> {
    const pattern = new RegExp(
      `^\\s*(?:#{1,4}\\s*)?(?:\\*\\*)?(${ProcessingHelper.SECTION_HEADINGS.join("|")})(?:\\*\\*)?\\s*:?\\s*$|^\\s*(?:\\*\\*)?(${ProcessingHelper.SECTION_HEADINGS.join(
        "|"
      )})(?:\\*\\*)?\\s*:\\s*(.*)$`,
      "i"
    )

    const sections: Record<string, string> = {}
    let current: string | null = null
    const buffer: string[] = []

    const flush = () => {
      if (current) sections[current] = (sections[current] || "") + buffer.join("\n")
      buffer.length = 0
    }

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(pattern)
      if (match) {
        flush()
        const heading = (match[1] || match[2] || "").toLowerCase()
        current = heading
        const inline = match[3]
        if (inline && inline.trim()) buffer.push(inline.trim())
        continue
      }
      if (current) buffer.push(line)
    }
    flush()

    return sections
  }

  /** Bullet/numbered lines from a section, falling back to plain lines. */
  private sectionToLines(section: string | undefined): string[] {
    if (!section) return []
    return section
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((line) => line && !/^```/.test(line))
  }

  /** Non-fatal progress note for the renderer. */
  private notifyStatus(message: string): void {
    const mainWindow = this.deps.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("processing-status", { message, progress: 50 })
    }
  }

  /**
   * Pulls the text out of a Gemini response, failing with a message that says
   * what actually went wrong. The naive `candidates[0].content.parts[0].text`
   * throws a bare TypeError whenever the model returns no parts - which it
   * does on MAX_TOKENS (thinking models can spend the whole budget before
   * emitting a token) and on safety blocks.
   */
  private extractGeminiText(responseData: any): string {
    const candidate = responseData?.candidates?.[0]

    if (!candidate) {
      const blockReason = responseData?.promptFeedback?.blockReason
      throw new Error(
        blockReason
          ? `Gemini blocked the request (${blockReason}).`
          : "Gemini returned an empty response."
      )
    }

    const parts = candidate.content?.parts
    const text = Array.isArray(parts)
      ? parts.map((part: any) => part?.text).filter(Boolean).join("")
      : ""

    if (text) return text

    if (candidate.finishReason === "MAX_TOKENS") {
      throw new Error(
        "The model hit its output limit before returning an answer. Try a shorter problem, or pick a different model in Settings."
      )
    }
    if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") {
      throw new Error("Gemini refused to answer this content.")
    }

    throw new Error(
      `Gemini returned no usable text (finishReason: ${candidate.finishReason || "unknown"}).`
    )
  }

  /**
   * Turns a provider error into something the user can act on. The previous
   * blanket "check your API key" sent people chasing the wrong problem when
   * the real cause was a spent daily quota or a retired model.
   */
  private describeApiError(error: any, provider: string): string {
    const status = error?.response?.status ?? error?.status
    const apiMessage =
      error?.response?.data?.error?.message || error?.error?.message || error?.message || ""

    if (status === 429) {
      return `${provider} rate limit or quota reached. Free-tier keys have a daily request cap per model - wait for it to reset, switch model in Settings, or enable billing.`
    }
    // Google reports an invalid key as 400 INVALID_ARGUMENT rather than 401,
    // so match on the message too - otherwise a dead key reads as a generic
    // malformed-request error and sends the user looking in the wrong place.
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(apiMessage)) {
      return `${provider} rejected the API key - it may have been revoked or regenerated. Enter a new one in Settings.`
    }
    if (status === 404) {
      return `The selected ${provider} model is unavailable (it may have been retired). Pick another model in Settings.`
    }
    if (status === 400) {
      return `${provider} rejected the request${apiMessage ? `: ${apiMessage}` : "."}`
    }
    if (status >= 500) {
      return `${provider} is having server problems. Try again shortly.`
    }
    return apiMessage || `${provider} request failed.`
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if (config.apiProvider === "openai" && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error("OpenAI client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      this.initializeAIClient();
      
      if (!this.geminiApiKey) {
        console.error("Gemini API key not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "anthropic" && !this.anthropicClient) {
      // Add check for Anthropic client
      this.initializeAIClient();
      
      if (!this.anthropicClient) {
        console.error("Anthropic client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)
      
      // Check if the queue is empty. With no screenshots there is nothing to
      // extract a coding problem from - the live assistant (Ctrl+Shift+Enter)
      // handles "answer what was just said" instead.
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        const result = await this.processScreenshotsHelper(validScreenshots, signal)

        if (!result.success) {
          console.log("Processing failed:", result.error)
          if (result.error?.includes("API Key") || result.error?.includes("OpenAI") || result.error?.includes("Gemini")) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)
      
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];
        
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )
        
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();

      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      const imageDataList = screenshots.map(screenshot => screenshot.data);

      // Fold in what was actually said in the room/call. The interviewer often
      // states constraints out loud that never appear on screen.
      const voiceTranscript = this.deps.getVoiceTranscript().trim();
      const voiceContextPrompt = voiceTranscript
        ? `\n\nLive conversation transcript (Them = interviewer, Me = candidate). Use it to fill in requirements, constraints or clarifications the screenshots don't show:\n${voiceTranscript}`
        : "";

      // Shared extraction rules. The screenshots are of a real screen mid
      // interview, so they are partial, cropped and full of UI chrome - the
      // model has to be told what to ignore and what to infer.
      const EXTRACTION_RULES = `
Return ONLY a JSON object with exactly these keys: problem_statement, constraints, example_input, example_output.

- problem_statement: the full task in prose. Include every requirement, the return type, and any rule stated in words (ordering, in-place, no extra space, 4-directional, etc). Do not summarise it into one line and do not copy the title alone.
- constraints: input sizes and value ranges exactly as written (e.g. "1 <= n <= 10^5, -10^4 <= nums[i] <= 10^4"). If none are shown, say "Not specified".
- example_input / example_output: the FIRST worked example, copied verbatim in the site's own notation. If none is shown, write "Not specified" - never invent one.

Reading the screenshots:
- They are cropped screenshots of a live screen. Ignore browser chrome, tabs, sidebars, timers, difficulty badges, like counts, editor gutters and any starter-code panel.
- Multiple screenshots are consecutive parts of ONE problem - stitch them together rather than treating them as separate problems.
- If text is cut off mid-sentence, reconstruct the obvious continuation instead of dropping it.
- If a function signature or class stub is visible, append it verbatim to problem_statement - the solution must match that exact signature.
- Preserve 0-indexed vs 1-indexed wording exactly; it changes the answer.

Output the raw JSON only. No markdown fence, no commentary.`;

      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing problem from screenshots...",
          progress: 20
        });
      }

      let problemInfo;
      
      if (config.apiProvider === "openai") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        // Use OpenAI for processing
        const messages = [
          {
            role: "system" as const, 
            content: "You read screenshots of a coding problem taken during a live interview and turn them into structured JSON. You are precise and never invent details that are not visible."
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `Extract the coding problem from these screenshots. The solution will be written in ${language}.
${EXTRACTION_RULES}${voiceContextPrompt}`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to OpenAI Vision API
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const responseText = extractionResponse.choices[0].message.content;
          // Handle when OpenAI might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error parsing OpenAI response:", error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else if (config.apiProvider === "gemini")  {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: `You read screenshots of a coding problem taken during a live interview and turn them into structured JSON. You are precise and never invent details that are not visible.

Extract the coding problem from these screenshots. The solution will be written in ${language}.
${EXTRACTION_RULES}${voiceContextPrompt}`
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await this.callGeminiWithFallback(
            config.extractionModel,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                // Thinking models spend part of this budget before emitting any text
                // (measured: ~1500 thought tokens on a trivial problem), and running
                // out yields a response with no parts at all. Headroom is free -
                // it is a cap, not an allocation.
                maxOutputTokens: 16000
              }
            },
            signal,
            "extraction"
          );

          const responseData = response.data as GeminiResponse;

          const responseText = this.extractGeminiText(responseData);
          
          // Handle when Gemini might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: this.describeApiError(error, "Gemini")
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `Extract the coding problem from these screenshots. The solution will be written in ${language}.
${EXTRACTION_RULES}${voiceContextPrompt}`
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const,
                    data: data
                  }
                }))
              ]
            }
          ];

          const response = await this.anthropicClient.messages.create({
            model: config.extractionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          const responseText = (response.content[0] as { type: 'text', text: string }).text;
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error: any) {
          console.error("Error using Anthropic API:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to process with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });
          
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions"
          );
        }
      }

      return { success: false, error: "Failed to process screenshots" };
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return { 
        success: false, 
        error: error.message || "Failed to process screenshots. Please try again." 
      };
    }
  }

  private async generateSolutionsHelper(signal: AbortSignal) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60
        });
      }

      // Create prompt for solution generation
      const promptText = `
Generate a detailed solution for the following coding problem:

PROBLEM STATEMENT:
${problemInfo.problem_statement}

CONSTRAINTS:
${problemInfo.constraints || "No specific constraints provided."}

EXAMPLE INPUT:
${problemInfo.example_input || "No example input provided."}

EXAMPLE OUTPUT:
${problemInfo.example_output || "No example output provided."}

LANGUAGE: ${language}

Respond in exactly this format:

Code:
\`\`\`${language}
<the solution>
\`\`\`

Thoughts:
- <first-person line>
- <first-person line>
- <first-person line>
- <first-person line>

Walkthrough:
- <step>
- <step>
- <step>

Edge cases:
- <edge case>
- <edge case>
- <edge case>

Time complexity: O(X) - one sentence saying why.
Space complexity: O(X) - one sentence saying why.

Emit all six sections, in that order, with those exact headings. Do not merge, rename, reorder or omit any of them.

RULES FOR COMPLEXITY - it must describe the code you just wrote:
- Derive it by reading your own solution back, not by recalling what this problem's optimal answer usually is. If your code is O(n log n), say O(n log n) even when an O(n) solution exists.
- Use the variables the problem actually has. A grid is O(rows * cols), not O(n). A graph is O(V + E). Two inputs are O(n + m). Only use O(n) when there is a single sequence of length n.
- Space is the extra space your code allocates. Count the recursion stack if you recurse - a DFS over a grid is O(rows * cols) in the worst case. Do not count the input itself.
- One sentence, naming the thing responsible ("each cell is visited once", "the recursion stack can reach every cell"). No padding.

RULES FOR THE CODE - this has to look like a strong candidate typed it in an interview, not like generated output:
- If the problem statement contains a function or class signature, use it EXACTLY - same name, same parameters, same order, same return type. Do not rename it, do not wrap it in a different class, do not change the parameter names. Submitting against a changed signature fails the test harness.
- Write idiomatic ${language}, not translated-from-another-language code. Use the constructs a ${language} developer would actually reach for here.
- Handle the stated constraints. If n can be 10^5, do not ship an O(n^2) solution without saying why it is acceptable.
- Do not hide the thing being tested behind a library call. If one call collapses the whole problem - \`Counter.most_common(k)\`, \`sorted(...)[:k]\`, \`itertools\` doing the combinatorics, a built-in that IS the algorithm - write the real approach instead (the heap, the bucket sort, the two pointers). Interviewers ask this question to watch you build that, and a one-liner reads as dodging it.
- Library calls for genuinely incidental work are fine and expected: building a frequency map, sorting when sorting is not the point, basic string handling. The test is whether the call replaces the core insight or just the boilerplate around it.
- Keep it short. Shortest correct, readable version. No wrapper classes, helpers or abstraction the problem didn't ask for.
- Barely comment it. A human writing under time pressure adds a comment only where the logic is genuinely non-obvious - maybe one or two in a whole solution, often none. Never annotate the obvious ("# loop through the array", "# mark as visited", "# return the answer").
- No dead code. Every statement must affect the result. Never leave a bare expression, an unused variable, a stray literal on its own line, or leftover debugging.
- Use idiomatic ${language} and normal short names a person would actually type.
- No docstrings, no type-annotation ceremony beyond what the signature needs, no "Example usage" block, no test harness.
- It must actually run and be correct on the edge cases.

RULES FOR THOUGHTS - a derivation the user can say out loud, one step leading to the next:
- First person, plain spoken, contractions fine. This is what the user literally says to the interviewer.
- Build the solution up in order. Each line should follow from the one before, ending at the method the code uses:
  1. What you notice about the problem, and what that makes it ("Looking at this, each group of connected 1s is its own blob, so this is really connected components on a grid.")
  2. The naive idea first, and what it costs ("The obvious thing is to scan and count, but I'd recount the same cell many times.")
  3. The realisation that fixes it ("So I need to mark cells as I use them - if I sink each cell when I visit it, nothing gets counted twice.")
  4. The concrete method that falls out ("That's just flood fill from every unvisited land cell, DFS, taking the max area.")
- Do not jump straight to the answer. The interviewer is buying the reasoning, not the name of the algorithm.
- 4 to 6 lines. No headings, no bold, no restating the problem back.

RULES FOR WALKTHROUGH - teach it the way a good explainer video does, tracing a real example:
- Invent a small concrete input if the problem didn't give one (a 4x5 grid, an array of 6 numbers) and state it explicitly at the start. Then actually run your code on it.
- Narrate the trace with real values and real state changes: "I hit the 1 at (0,0), area becomes 1, I look left - water, I look down - another 1, so area is 2, and I zero out each one as I pass it."
- Say WHY each implementation detail exists, at the moment it comes up. These are the things an interviewer asks about, and skipping them is what makes an answer sound memorised:
  * why you mutate/mark ("if I don't zero it, when the neighbour looks back at me it counts me again")
  * why a "+1" or an offset is there ("the +1 is the cell I'm standing on; the recursive calls only cover the neighbours")
  * why the base case returns what it returns
  * why the loop bound or comparison is < and not <=
- Spoken, first person, contractions fine. Plain words over jargon: "sink it", "the cell I'm standing on", "count it twice".
- 6 to 10 lines. Each line one concrete step or one "why".

EVERY LOAD-BEARING CHOICE MUST BE JUSTIFIED - this is the part interviewers actually probe:
- For each non-obvious thing your code uses, say in one line WHY it is there and what breaks without it. Cover whichever of these you used:
  * the data structure - why a heap and not a sorted list, why a set and not a list, why a deque and not an array
  * any sentinel, dummy head, visited marker, seen-set or in-place mutation - what goes wrong if it is removed
  * a non-obvious initial value: why 0 vs -infinity vs the first element, why \`default=0\`
  * any offset or comparison that looks arbitrary: a \`+1\`, a \`-1\`, \`<\` vs \`<=\`, \`left < right\` vs \`left <= right\`
  * a modulo, a bit trick, or an overflow guard - why it is needed at all
  * the traversal order, if reversing it would break correctness
- Phrase it as cause and effect, not as a label: "I use a set because checking membership in a list would make this O(n^2)" beats "uses a set for efficiency".
- If something genuinely is obvious, skip it. This is for the choices a reviewer would stop and ask about.

THE FOLLOW-UP THE INTERVIEWER WILL ASK - fold this into the sections above, do not add a new one:
- They will ask "can you do better?" or "why not <other approach>?". Your Thoughts must already answer it: name the approach you rejected and the specific reason (the sort costs O(n log n); the hash map trades O(n) space for O(1) lookups; BFS needs a queue where DFS rides the call stack).
- If your solution is already optimal for the stated constraints, say so explicitly in one line so the user can defend it rather than start second-guessing.
- If there is a genuinely better approach you did not take because it is far harder to write under time pressure, say that plainly. That is a strong interview answer, not a weak one.

RULES FOR EDGE CASES - always include this section, never skip it:
- 2 to 4 lines, each naming a concrete input and what the code does with it.
- Prefer the ones that actually break naive solutions here: empty or null input, a single element, everything the same, all-empty vs all-full, one row or one column, negatives, duplicates, integer overflow, the recursion depth on a large input, and any off-by-one at the boundary.
- Say what happens, not just the name: "Empty grid - the loop never runs and it returns 0" beats "handles empty input".
- Only list cases that are real for THIS problem. Do not pad it.
- Never quote a specific runtime limit you are not certain of - recursion depth caps, integer widths, default stack sizes. Say "deep recursion could overflow the stack here" rather than naming a number. A confidently wrong number is worse than no number, because the user will repeat it out loud.
`;

      let responseContent;
      
      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        // Send to OpenAI API
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-4o",
          messages: [
            { role: "system", content: "You help a candidate during a live coding interview. Write the shortest correct solution a strong human would type, with almost no comments, and explain it the way a person talks - not the way documentation reads. Follow the requested output format exactly." },
            { role: "user", content: promptText }
          ],
          max_tokens: 4000,
          temperature: 0.2
        });

        responseContent = solutionResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini")  {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You help a candidate during a live coding interview. Write the shortest correct solution a strong human would type, with almost no comments, and explain it the way a person talks - not the way documentation reads. Follow the requested output format exactly.\n\n${promptText}`
                }
              ]
            }
          ];

          // Streamed so the answer appears as it is written. Generation takes
          // ~9s; rendering only at the end made the app look hung.
          const mainWindowForStream = this.deps.getMainWindow()
          const streamed = await this.streamGeminiWithFallback(
            config.solutionModel,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                // Thinking models spend part of this budget before emitting any text
                // (measured: ~1500 thought tokens on a trivial problem), and running
                // out yields a response with no parts at all. Headroom is free -
                // it is a cap, not an allocation.
                maxOutputTokens: 16000
              }
            },
            signal,
            (delta) => {
              if (mainWindowForStream && !mainWindowForStream.isDestroyed()) {
                mainWindowForStream.webContents.send("solution-chunk", delta)
              }
            },
            "solution"
          );

          responseContent = streamed.text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: this.describeApiError(error, "Gemini")
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `You help a candidate during a live coding interview. Write the shortest correct solution a strong human would type, with almost no comments, and explain it the way a person talks - not the way documentation reads. Follow the requested output format exactly.\n\n${promptText}`
                }
              ]
            }
          ];

          // Send to Anthropic API
          const response = await this.anthropicClient.messages.create({
            model: config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for solution:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to generate solution with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      // Split once into labelled sections, then read each one.
      const sections = this.splitSections(responseContent);

      const codeMatch = responseContent.match(/```(?:\w+)?\s*([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : (sections["code"] || responseContent).trim();

      const thoughts = this.sectionToLines(sections["thoughts"]);
      const walkthrough = this.sectionToLines(sections["walkthrough"]);
      const edgeCases = this.sectionToLines(sections["edge cases"]);

      // Neutral placeholders. These previously described a hashmap/array
      // solution, so any problem whose complexity failed to parse - a graph
      // traversal, say - was labelled with confident nonsense.
      const readComplexity = (raw: string | undefined): string => {
        const value = (raw || "").trim();
        if (!value) return "Not reported by the model.";

        const notation = value.match(/O\([^)]+\)/i);
        // Prose with no Big-O is reported as-is; inventing a notation would
        // present a guess as if the model had stated it.
        if (!notation) return value;
        if (value.includes("-") || value.includes("because")) return value;
        return `${notation[0]} - ${value.replace(notation[0], "").trim()}`.trim();
      };

      const timeComplexity = readComplexity(sections["time complexity"]);
      const spaceComplexity = readComplexity(sections["space complexity"]);

      const formattedResponse = {
        code: code,
        thoughts: thoughts.length > 0 ? thoughts : ["Solution approach based on efficiency and readability"],
        edge_cases: edgeCases,
        walkthrough: walkthrough,
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity
      };

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      let debugContent;
      
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        const messages = [
          {
            role: "system" as const, 
            content: `You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

Your response MUST follow this exact structure with these section headers (use ### for headers):
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).`
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `I'm mid-interview solving this problem in ${language}: "${problemInfo.problem_statement}"

The screenshots show my current code and whatever the run produced - an error, a failing case, or wrong output. Find what's actually wrong, the way a strong engineer would looking over my shoulder.

Use these exact section headers:
### Issues Identified
- Lead with what actually breaks it. Name the line or expression, quote the specific token (\`i <= n\`, the missing \`return\`), say what it does now vs what it should do. If a failing input is visible, trace the value through the bad line. If nothing is truly broken, say so instead of inventing a bug.

### Specific Improvements and Corrections
- The corrected lines as code. Change only what's wrong.

### Optimizations
- Only real wins, with complexity before and after. If it's already optimal, say that.

### Explanation of Changes Needed
Two or three sentences I can say out loud: why it failed, why the fix works. First person, plain words.

### Key Points
- The one-line takeaway, plus what the interviewer will probably ask next.

Use markdown code blocks tagged \`\`\`${language} for code.`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback...",
            progress: 60
          });
        }

        const debugResponse = await this.openaiClient.chat.completions.create({
          model: config.debuggingModel || "gpt-4o",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });
        
        debugContent = debugResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini")  {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm mid-interview solving this problem in ${language}: "${problemInfo.problem_statement}"

The screenshots show my current code and whatever the run produced - an error, a failing case, or wrong output. Find what's actually wrong and tell me how to fix it, the way a strong engineer would while looking over my shoulder.

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- Lead with the one that actually breaks it. Name the line or expression, say what it does now, and what it should do.
- Quote the specific token where it goes wrong (\`i <= n\`, \`grid[r][c]\`, the missing \`return\`), not a vague area.
- If a failing input is visible, trace it: what value reaches the bad line and what comes out.
- If nothing is actually broken and it's only style or speed, say so plainly rather than inventing a bug.

### Specific Improvements and Corrections
- The corrected lines, as code. Change only what's wrong - don't rewrite working code into your own preferred style.

### Optimizations
- Only real wins, with the complexity before and after. If it's already optimal, say that instead of padding.

### Explanation of Changes Needed
Two or three sentences a person can actually say out loud: why it failed, why the fix works. First person, plain words, no lecture.

### Key Points
- The one-line takeaway, plus anything the interviewer is likely to ask next.

Use markdown code blocks with the language tag (e.g. \`\`\`${language}) for any code.
`;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await this.callGeminiWithFallback(
            config.debuggingModel,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                // Thinking models spend part of this budget before emitting any text
                // (measured: ~1500 thought tokens on a trivial problem), and running
                // out yields a response with no parts at all. Headroom is free -
                // it is a cap, not an allocation.
                maxOutputTokens: 16000
              }
            },
            signal,
            "debug"
          );

          const responseData = response.data as GeminiResponse;

          debugContent = this.extractGeminiText(responseData);
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: this.describeApiError(error, "Gemini")
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution.

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification.
`;

          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: debugPrompt
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const, 
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Claude...",
              progress: 60
            });
          }

          const response = await this.anthropicClient.messages.create({
            model: config.debuggingModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });
          
          debugContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for debugging:", error);
          
          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }
          
          return {
            success: false,
            error: "Failed to process debug request with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;
      
      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## Issues Identified')
          .replace(/code improvements|improvements|suggested changes/i, '## Code Improvements')
          .replace(/optimizations|performance improvements/i, '## Optimizations')
          .replace(/explanation|detailed analysis/i, '## Explanation');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode"
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  public cancelOngoingRequests(): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }
}
