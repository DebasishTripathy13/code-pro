import { globalShortcut, app } from "electron"
import { IShortcutsHelperDeps } from "./main"
import { configHelper } from "./ConfigHelper"

export class ShortcutsHelper {
  private deps: IShortcutsHelperDeps
  private failedShortcuts: string[] = []

  constructor(deps: IShortcutsHelperDeps) {
    this.deps = deps
  }

  private adjustOpacity(delta: number): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    
    let currentOpacity = mainWindow.getOpacity();
    let newOpacity = Math.max(0.1, Math.min(1.0, currentOpacity + delta));
    console.log(`Adjusting opacity from ${currentOpacity} to ${newOpacity}`);
    
    mainWindow.setOpacity(newOpacity);
    
    // Save the opacity setting to config without re-initializing the client
    try {
      const config = configHelper.loadConfig();
      config.opacity = newOpacity;
      configHelper.saveConfig(config);
    } catch (error) {
      console.error('Error saving opacity to config:', error);
    }
    
    // If we're making the window visible, also make sure it's shown and interaction is enabled
    if (newOpacity > 0.1 && !this.deps.isVisible()) {
      this.deps.toggleMainWindow();
    }
  }

  /**
   * Registers a global shortcut and reports it when the OS refuses.
   *
   * `globalShortcut.register` returns false when another application already
   * owns the accelerator - most often a second copy of this app still running
   * in the background. Ignoring that return value is why a stale instance
   * makes every hotkey appear dead with no explanation anywhere.
   */
  private register(accelerator: string, handler: () => void): void {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) {
        this.failedShortcuts.push(accelerator)
        console.warn(
          `Could not register ${accelerator} - another application (often a second copy of this app) already owns it.`
        )
      }
    } catch (error) {
      this.failedShortcuts.push(accelerator)
      console.warn(`Error registering ${accelerator}:`, error)
    }
  }

  /** Tell the user once, rather than leaving them with silent dead keys. */
  private reportFailedShortcuts(): void {
    if (this.failedShortcuts.length === 0) return

    const mainWindow = this.deps.getMainWindow()
    const list = this.failedShortcuts.join(", ")
    console.warn(`Shortcuts unavailable: ${list}`)

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("shortcuts-unavailable", this.failedShortcuts)
    }
  }

  public registerGlobalShortcuts(): void {
    this.failedShortcuts = []
    this.register("CommandOrControl+H", async () => {
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        console.log("Taking screenshot...")
        try {
          const screenshotPath = await this.deps.takeScreenshot()
          const preview = await this.deps.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          console.error("Error capturing screenshot:", error)
        }
      }
    })

    this.register("CommandOrControl+Enter", async () => {
      await this.deps.processingHelper?.processScreenshots()
    })

    // Answer whatever the other person just said - no typing, no screenshot.
    this.register("CommandOrControl+Shift+Enter", async () => {
      const assistant = this.deps.getAssistantHelper()
      if (!assistant) return
      try {
        await assistant.answerLatest()
      } catch (error) {
        console.error("Error answering latest:", error)
      }
    })

    // Same, but also looks at what's currently on screen.
    this.register("CommandOrControl+Shift+S", async () => {
      const assistant = this.deps.getAssistantHelper()
      if (!assistant) return
      try {
        const screen = await this.deps.captureScreenBase64()
        await assistant.answerLatest(screen || undefined)
      } catch (error) {
        console.error("Error answering with screen context:", error)
      }
    })

    // Open the ask-anything box in the overlay.
    this.register("CommandOrControl+Shift+Space", () => {
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow) return
      if (!this.deps.isVisible()) this.deps.toggleMainWindow()
      // Without this the input receives DOM focus inside a window the OS has
      // not focused, so keystrokes go to whatever is behind the overlay.
      this.deps.focusWindow()
      mainWindow.webContents.send("assistant:focus-ask")
    })

    // Stop a running answer mid-stream.
    this.register("CommandOrControl+Shift+X", () => {
      this.deps.getAssistantHelper()?.stop()
    })

    // Let clicks fall through the overlay to the app behind it.
    this.register("CommandOrControl+Shift+C", () => {
      this.deps.toggleClickThrough()
    })

    this.register("CommandOrControl+R", () => {
      console.log(
        "Command + R pressed. Canceling requests and resetting queues..."
      )

      // Cancel ongoing API requests
      this.deps.processingHelper?.cancelOngoingRequests()

      // Clear both screenshot queues
      this.deps.clearQueues()

      console.log("Cleared queues.")

      // Update the view state to 'queue'
      this.deps.setView("queue")

      // Reset is what people press when the overlay has "disappeared", so it
      // also brings the window back on screen. Moving up repeatedly and then
      // switching to the shorter queue view could otherwise leave it parked
      // entirely above the top edge with no way to recover it.
      this.deps.recenterWindow()

      // Notify renderer process to switch view to 'queue'
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }
    })

    // New shortcuts for moving the window
    this.register("CommandOrControl+Left", () => {
      console.log("Command/Ctrl + Left pressed. Moving window left.")
      this.deps.moveWindowLeft()
    })

    this.register("CommandOrControl+Right", () => {
      console.log("Command/Ctrl + Right pressed. Moving window right.")
      this.deps.moveWindowRight()
    })

    this.register("CommandOrControl+Down", () => {
      console.log("Command/Ctrl + down pressed. Moving window down.")
      this.deps.moveWindowDown()
    })

    this.register("CommandOrControl+Up", () => {
      console.log("Command/Ctrl + Up pressed. Moving window Up.")
      this.deps.moveWindowUp()
    })

    this.register("CommandOrControl+B", () => {
      console.log("Command/Ctrl + B pressed. Toggling window visibility.")
      this.deps.toggleMainWindow()
    })

    this.register("CommandOrControl+Q", () => {
      console.log("Command/Ctrl + Q pressed. Quitting application.")
      app.quit()
    })

    // Adjust opacity shortcuts
    this.register("CommandOrControl+[", () => {
      console.log("Command/Ctrl + [ pressed. Decreasing opacity.")
      this.adjustOpacity(-0.1)
    })

    this.register("CommandOrControl+]", () => {
      console.log("Command/Ctrl + ] pressed. Increasing opacity.")
      this.adjustOpacity(0.1)
    })
    
    // Zoom controls
    this.register("CommandOrControl+-", () => {
      console.log("Command/Ctrl + - pressed. Zooming out.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom - 0.5)
      }
    })
    
    this.register("CommandOrControl+0", () => {
      console.log("Command/Ctrl + 0 pressed. Resetting zoom.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        mainWindow.webContents.setZoomLevel(0)
      }
    })
    
    this.register("CommandOrControl+=", () => {
      console.log("Command/Ctrl + = pressed. Zooming in.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom + 0.5)
      }
    })
    
    // Delete last screenshot shortcut
    this.register("CommandOrControl+L", () => {
      console.log("Command/Ctrl + L pressed. Deleting last screenshot.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        // Send an event to the renderer to delete the last screenshot
        mainWindow.webContents.send("delete-last-screenshot")
      }
    })
    
    this.reportFailedShortcuts()

    // Unregister shortcuts when quitting
    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}
