// ipcHandlers.ts

import { ipcMain, shell, dialog, clipboard } from "electron"
import { randomBytes } from "crypto"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  // Configuration handlers
  ipcMain.handle("get-config", () => {
    return configHelper.loadConfig();
  })

  ipcMain.handle("update-config", (_event, updates) => {
    return configHelper.updateConfig(updates);
  })

  ipcMain.handle("check-api-key", () => {
    return configHelper.hasApiKey();
  })
  
  ipcMain.handle("validate-api-key", async (_event, apiKey) => {
    // First check the format
    if (!configHelper.isValidApiKeyFormat(apiKey)) {
      return { 
        valid: false, 
        error: "Invalid API key format. OpenAI API keys start with 'sk-'" 
      };
    }
    
    // Then test the API key with OpenAI
    const result = await configHelper.testApiKey(apiKey);
    return result;
  })

  // Credits handlers
  ipcMain.handle("set-initial-credits", async (_event, credits: number) => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      // Set the credits in a way that ensures atomicity
      await mainWindow.webContents.executeJavaScript(
        `window.__CREDITS__ = ${credits}`
      )
      mainWindow.webContents.send("credits-updated", credits)
    } catch (error) {
      console.error("Error setting initial credits:", error)
      throw error
    }
  })

  ipcMain.handle("decrement-credits", async () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      const currentCredits = await mainWindow.webContents.executeJavaScript(
        "window.__CREDITS__"
      )
      if (currentCredits > 0) {
        const newCredits = currentCredits - 1
        await mainWindow.webContents.executeJavaScript(
          `window.__CREDITS__ = ${newCredits}`
        )
        mainWindow.webContents.send("credits-updated", newCredits)
      }
    } catch (error) {
      console.error("Error decrementing credits:", error)
    }
  })

  // Screenshot queue handlers
  ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue()
  })

  ipcMain.handle("get-extra-screenshot-queue", () => {
    return deps.getExtraScreenshotQueue()
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (event, path: string) => {
    return deps.getImagePreview(path)
  })

  // Screenshot processing handlers
  ipcMain.handle("process-screenshots", async () => {
    // Check for API key before processing
    if (!configHelper.hasApiKey()) {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      }
      return;
    }
    
    await deps.processingHelper?.processScreenshots()
  })

  // Voice input handlers
  ipcMain.handle("update-voice-transcript", (_event, transcript: string) => {
    deps.setVoiceTranscript(typeof transcript === "string" ? transcript : "")
    return { success: true }
  })

  // Background audio capture sends short speech segments here. `source` is
  // "them" for system/loopback audio (the interviewer) and "you" for the mic.
  // Best-effort: failures are returned but never surfaced as hard errors,
  // since capture runs silently and must not disturb the user.
  ipcMain.handle(
    "assistant:transcribe-chunk",
    async (
      _event,
      data: { base64: string; mimeType: string; source: "them" | "you" }
    ) => {
      try {
        if (!data?.base64) return { success: false, error: "No audio data" };
        const assistant = deps.getAssistantHelper();
        if (!assistant) return { success: false, error: "Assistant not ready" };
        return await assistant.transcribeChunk(
          data.base64,
          data.mimeType || "audio/wav",
          data.source === "you" ? "you" : "them"
        );
      } catch (error) {
        console.error("Error handling assistant:transcribe-chunk:", error);
        return { success: false, error: "Failed to transcribe audio" };
      }
    }
  )

  // Streaming path: raw PCM frames go straight into the live transcription
  // socket. Uses `on` rather than `handle` because frames arrive ~4x/second
  // per source and none of them need a reply.
  ipcMain.on(
    "assistant:audio-frame",
    (_event, data: { pcm: string; source: "them" | "you" }) => {
      if (!data?.pcm) return
      deps.getAssistantHelper()?.pushAudioFrame(
        data.source === "you" ? "you" : "them",
        data.pcm
      )
    }
  )

  ipcMain.handle("assistant:supports-live", () => {
    return { supported: deps.getAssistantHelper()?.supportsLiveStreaming() ?? false }
  })

  ipcMain.handle("assistant:stop-live", () => {
    deps.getAssistantHelper()?.stopLiveCapture()
    return { success: true }
  })

  ipcMain.handle("assistant:get-transcript", () => {
    return deps.getAssistantHelper()?.getTranscript() || []
  })

  ipcMain.handle("assistant:clear-transcript", () => {
    deps.getAssistantHelper()?.clearTranscript()
    return { success: true }
  })

  ipcMain.handle("assistant:stop", () => {
    deps.getAssistantHelper()?.stop()
    return { success: true }
  })

  // Ask anything. Optionally attaches a fresh screen grab so the answer can
  // account for whatever is on screen (a shared doc, an IDE, a spreadsheet).
  ipcMain.handle(
    "assistant:ask",
    async (_event, data: { question: string; includeScreen?: boolean }) => {
      try {
        const assistant = deps.getAssistantHelper();
        if (!assistant) return { success: false, error: "Assistant not ready" };
        if (!data?.question?.trim()) {
          return { success: false, error: "Empty question" };
        }

        const screenshotBase64 = data.includeScreen
          ? (await deps.captureScreenBase64()) || undefined
          : undefined;

        return await assistant.ask(data.question.trim(), { screenshotBase64 });
      } catch (error) {
        console.error("Error handling assistant:ask:", error);
        return { success: false, error: "Failed to ask the assistant" };
      }
    }
  )

  // Answer whatever the other person just said, with no typing at all.
  ipcMain.handle(
    "assistant:answer-latest",
    async (_event, data?: { includeScreen?: boolean }) => {
      try {
        const assistant = deps.getAssistantHelper();
        if (!assistant) return { success: false, error: "Assistant not ready" };

        const screenshotBase64 = data?.includeScreen
          ? (await deps.captureScreenBase64()) || undefined
          : undefined;

        return await assistant.answerLatest(screenshotBase64);
      } catch (error) {
        console.error("Error handling assistant:answer-latest:", error);
        return { success: false, error: "Failed to generate an answer" };
      }
    }
  )

  ipcMain.handle("recenter-window", () => {
    deps.recenterWindow()
    return { success: true }
  })

  // The overlay is shown with showInactive() so it never steals focus. Typing
  // into the ask box therefore has to request focus explicitly, and give it
  // back afterwards.
  ipcMain.handle("focus-window", () => {
    deps.focusWindow()
    return { success: true }
  })

  ipcMain.handle("blur-window", () => {
    deps.blurWindow()
    return { success: true }
  })

  // Copy via the main process. In production the renderer is loaded from
  // file://, which is not a secure context, so navigator.clipboard is
  // undefined there and every copy silently threw.
  ipcMain.handle("write-clipboard", (_event, text: string) => {
    try {
      clipboard.writeText(typeof text === "string" ? text : "")
      return { success: true }
    } catch (error) {
      console.error("Failed to write to clipboard:", error)
      return { success: false, error: "Could not copy to clipboard" }
    }
  })

  // Overlay click-through so the window never intercepts a click during a call
  ipcMain.handle("set-click-through", (_event, enabled: boolean) => {
    return { success: true, enabled: deps.setClickThrough(Boolean(enabled)) }
  })

  ipcMain.handle("toggle-click-through", () => {
    return { success: true, enabled: deps.toggleClickThrough() }
  })

  // Window dimension handlers
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        deps.setWindowDimensions(width, height)
      }
    }
  )

  ipcMain.handle(
    "set-window-dimensions",
    (event, width: number, height: number) => {
      deps.setWindowDimensions(width, height)
    }
  )

  // Screenshot management handlers
  ipcMain.handle("get-screenshots", async () => {
    try {
      let previews = []
      const currentView = deps.getView()

      if (currentView === "queue") {
        const queue = deps.getScreenshotQueue()
        previews = await Promise.all(
          queue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      } else {
        const extraQueue = deps.getExtraScreenshotQueue()
        previews = await Promise.all(
          extraQueue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      }

      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  // Screenshot trigger handlers
  ipcMain.handle("trigger-screenshot", async () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      try {
        const screenshotPath = await deps.takeScreenshot()
        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        return { success: true }
      } catch (error) {
        console.error("Error triggering screenshot:", error)
        return { error: "Failed to trigger screenshot" }
      }
    }
    return { error: "No main window available" }
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await deps.takeScreenshot()
      const preview = await deps.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      return { error: "Failed to take screenshot" }
    }
  })

  // Auth-related handlers removed

  ipcMain.handle("open-external-url", (event, url: string) => {
    shell.openExternal(url)
  })
  
  // Open external URL handler
  ipcMain.handle("openLink", (event, url: string) => {
    try {
      console.log(`Opening external URL: ${url}`);
      shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error);
      return { success: false, error: `Failed to open URL: ${error}` };
    }
  })

  // Settings portal handler
  ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send("show-settings-dialog");
      return { success: true };
    }
    return { success: false, error: "Main window not available" };
  })

  // Window management handlers
  ipcMain.handle("toggle-window", () => {
    try {
      deps.toggleMainWindow()
      return { success: true }
    } catch (error) {
      console.error("Error toggling window:", error)
      return { error: "Failed to toggle window" }
    }
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues()
      return { success: true }
    } catch (error) {
      console.error("Error resetting queues:", error)
      return { error: "Failed to reset queues" }
    }
  })

  // Process screenshot handlers
  ipcMain.handle("trigger-process-screenshots", async () => {
    try {
      // Check for API key before processing
      if (!configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return { success: false, error: "API key required" };
      }
      
      await deps.processingHelper?.processScreenshots()
      return { success: true }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      return { error: "Failed to process screenshots" }
    }
  })

  // Reset handlers
  ipcMain.handle("trigger-reset", () => {
    try {
      // First cancel any ongoing requests
      deps.processingHelper?.cancelOngoingRequests()

      // Clear all queues immediately
      deps.clearQueues()

      // Reset view to queue
      deps.setView("queue")

      // Get main window and send reset events
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Send reset events in sequence
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }

      return { success: true }
    } catch (error) {
      console.error("Error triggering reset:", error)
      return { error: "Failed to trigger reset" }
    }
  })

  // Window movement handlers
  ipcMain.handle("trigger-move-left", () => {
    try {
      deps.moveWindowLeft()
      return { success: true }
    } catch (error) {
      console.error("Error moving window left:", error)
      return { error: "Failed to move window left" }
    }
  })

  ipcMain.handle("trigger-move-right", () => {
    try {
      deps.moveWindowRight()
      return { success: true }
    } catch (error) {
      console.error("Error moving window right:", error)
      return { error: "Failed to move window right" }
    }
  })

  ipcMain.handle("trigger-move-up", () => {
    try {
      deps.moveWindowUp()
      return { success: true }
    } catch (error) {
      console.error("Error moving window up:", error)
      return { error: "Failed to move window up" }
    }
  })

  ipcMain.handle("trigger-move-down", () => {
    try {
      deps.moveWindowDown()
      return { success: true }
    } catch (error) {
      console.error("Error moving window down:", error)
      return { error: "Failed to move window down" }
    }
  })
  
  // Delete last screenshot handler
  ipcMain.handle("delete-last-screenshot", async () => {
    try {
      const queue = deps.getView() === "queue" 
        ? deps.getScreenshotQueue() 
        : deps.getExtraScreenshotQueue()
      
      if (queue.length === 0) {
        return { success: false, error: "No screenshots to delete" }
      }
      
      // Get the last screenshot in the queue
      const lastScreenshot = queue[queue.length - 1]
      
      // Delete it
      const result = await deps.deleteScreenshot(lastScreenshot)
      
      // Notify the renderer about the change
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-deleted", { path: lastScreenshot })
      }
      
      return result
    } catch (error) {
      console.error("Error deleting last screenshot:", error)
      return { success: false, error: "Failed to delete last screenshot" }
    }
  })
}
