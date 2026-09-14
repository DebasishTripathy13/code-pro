import { app, BrowserWindow, screen, shell, ipcMain, session, desktopCapturer } from "electron"
import path from "path"
import fs from "fs"
import { initializeIpcHandlers } from "./ipcHandlers"
import { ProcessingHelper } from "./ProcessingHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { AssistantHelper } from "./AssistantHelper"
import { initAutoUpdater } from "./autoUpdater"
import { configHelper } from "./ConfigHelper"
import * as dotenv from "dotenv"

// Constants
const isDev = process.env.NODE_ENV === "development"

// Application State
const state = {
  // Window management properties
  mainWindow: null as BrowserWindow | null,
  isWindowVisible: false,
  windowPosition: null as { x: number; y: number } | null,
  windowSize: null as { width: number; height: number } | null,
  screenWidth: 0,
  screenHeight: 0,
  step: 0,
  currentX: 0,
  currentY: 0,

  // Application helpers
  screenshotHelper: null as ScreenshotHelper | null,
  shortcutsHelper: null as ShortcutsHelper | null,
  processingHelper: null as ProcessingHelper | null,
  assistantHelper: null as AssistantHelper | null,

  // Overlay behaviour
  isClickThrough: false,

  // View and state management
  view: "queue" as "queue" | "solutions" | "debug",
  problemInfo: null as any,
  hasDebugged: false,
  voiceTranscript: "" as string,

  // Processing events
  PROCESSING_EVENTS: {
    UNAUTHORIZED: "processing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    OUT_OF_CREDITS: "out-of-credits",
    API_KEY_INVALID: "api-key-invalid",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const
}

// Add interfaces for helper classes
export interface IProcessingHelperDeps {
  getScreenshotHelper: () => ScreenshotHelper | null
  getMainWindow: () => BrowserWindow | null
  getView: () => "queue" | "solutions" | "debug"
  setView: (view: "queue" | "solutions" | "debug") => void
  getProblemInfo: () => any
  setProblemInfo: (info: any) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  clearQueues: () => void
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  setHasDebugged: (value: boolean) => void
  getHasDebugged: () => boolean
  getVoiceTranscript: () => string
  setVoiceTranscript: (transcript: string) => void
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
}

export interface IShortcutsHelperDeps {
  getMainWindow: () => BrowserWindow | null
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  getAssistantHelper: () => AssistantHelper | null
  captureScreenBase64: () => Promise<string | null>
  toggleClickThrough: () => boolean
  recenterWindow: () => void
  focusWindow: () => void
  blurWindow: () => void
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  isVisible: () => boolean
  toggleMainWindow: () => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
}

export interface IIpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  setWindowDimensions: (width: number, height: number) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  PROCESSING_EVENTS: typeof state.PROCESSING_EVENTS
  takeScreenshot: () => Promise<string>
  getView: () => "queue" | "solutions" | "debug"
  toggleMainWindow: () => void
  clearQueues: () => void
  setView: (view: "queue" | "solutions" | "debug") => void
  setVoiceTranscript: (transcript: string) => void
  getAssistantHelper: () => AssistantHelper | null
  captureScreenBase64: () => Promise<string | null>
  setClickThrough: (enabled: boolean) => boolean
  toggleClickThrough: () => boolean
  recenterWindow: () => void
  focusWindow: () => void
  blurWindow: () => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
}

// Initialize helpers
function initializeHelpers() {
  state.screenshotHelper = new ScreenshotHelper(state.view)
  state.assistantHelper = new AssistantHelper(getMainWindow)
  state.processingHelper = new ProcessingHelper({
    getScreenshotHelper,
    getMainWindow,
    getView,
    setView,
    getProblemInfo,
    setProblemInfo,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    clearQueues,
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    setHasDebugged,
    getHasDebugged,
    getVoiceTranscript,
    setVoiceTranscript,
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IProcessingHelperDeps)
  state.shortcutsHelper = new ShortcutsHelper({
    getMainWindow,
    takeScreenshot,
    getImagePreview,
    processingHelper: state.processingHelper,
    getAssistantHelper,
    captureScreenBase64,
    toggleClickThrough,
    recenterWindow,
    focusWindow,
    blurWindow,
    clearQueues,
    setView,
    isVisible: () => state.isWindowVisible,
    toggleMainWindow,
    moveWindowLeft: () =>
      moveWindowHorizontal((x) =>
        Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
      ),
    moveWindowRight: () =>
      moveWindowHorizontal((x) =>
        Math.min(
          state.screenWidth - (state.windowSize?.width || 0) / 2,
          x + state.step
        )
      ),
    moveWindowUp: () => moveWindowVertical((y) => y - state.step),
    moveWindowDown: () => moveWindowVertical((y) => y + state.step)
  } as IShortcutsHelperDeps)
}

// Auth callback handler

// Register the code-pro protocol
if (process.platform === "darwin") {
  app.setAsDefaultProtocolClient("code-pro")
} else {
  app.setAsDefaultProtocolClient("code-pro", process.execPath, [
    path.resolve(process.argv[1] || "")
  ])
}

// Handle the protocol. In this case, we choose to show an Error Box.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("code-pro", process.execPath, [
    path.resolve(process.argv[1])
  ])
}

// Force Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", (event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window.
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore()
      state.mainWindow.focus()

      // Protocol handler removed - no longer using auth callbacks
    }
  })
}

// Auth callback removed as we no longer use Supabase authentication

// Window management functions
async function createWindow(): Promise<void> {
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize
  state.screenWidth = workArea.width
  state.screenHeight = workArea.height
  state.step = 60
  state.currentY = 50

  const windowSettings: Electron.BrowserWindowConstructorOptions = {
    width: 800,
    height: 600,
    minWidth: 750,
    minHeight: 550,
    x: state.currentX,
    y: 50,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path.join(__dirname, "../dist-electron/preload.js")
        : path.join(__dirname, "preload.js"),
      scrollBounce: true
    },
    show: true,
    frame: false,
    // NOTE: do not set `resizable: false` here. Windows stops enforcing
    // minWidth/minHeight on a non-resizable window, so the content-driven
    // setWindowDimensions call shrinks the overlay to the raw measured size
    // (observed: 333x79 instead of 750x550).
    transparent: true,
    fullscreenable: false,
    hasShadow: false,
    opacity: 1.0,  // Start with full opacity
    backgroundColor: "#00000000",
    focusable: true,
    skipTaskbar: true,
    type: "panel",
    paintWhenInitiallyHidden: true,
    titleBarStyle: "hidden",
    enableLargerThanScreen: true,
    movable: true
  }

  state.mainWindow = new BrowserWindow(windowSettings)

  // Add more detailed logging for window events
  state.mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window finished loading")
  })
  state.mainWindow.webContents.on(
    "did-fail-load",
    async (event, errorCode, errorDescription) => {
      console.error("Window failed to load:", errorCode, errorDescription)
      if (isDev) {
        // In development, retry loading after a short delay
        console.log("Retrying to load development server...")
        setTimeout(() => {
          state.mainWindow?.loadURL("http://localhost:54321").catch((error) => {
            console.error("Failed to load dev server on retry:", error)
          })
        }, 1000)
      }
    }
  )

  if (isDev) {
    // In development, load from the dev server
    console.log("Loading from development server: http://localhost:54321")
    state.mainWindow.loadURL("http://localhost:54321").catch((error) => {
      console.error("Failed to load dev server, falling back to local file:", error)
      // Fallback to local file if dev server is not available
      const indexPath = path.join(__dirname, "../dist/index.html")
      console.log("Falling back to:", indexPath)
      if (fs.existsSync(indexPath)) {
        state.mainWindow.loadFile(indexPath)
      } else {
        console.error("Could not find index.html in dist folder")
      }
    })
  } else {
    // In production, load from the built files
    const indexPath = path.join(__dirname, "../dist/index.html")
    console.log("Loading production build:", indexPath)
    
    if (fs.existsSync(indexPath)) {
      state.mainWindow.loadFile(indexPath)
    } else {
      console.error("Could not find index.html in dist folder")
    }
  }

  // Configure window behavior
  state.mainWindow.webContents.setZoomFactor(1)
  if (isDev) {
    state.mainWindow.webContents.openDevTools()
  }
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("Attempting to open URL:", url)
    try {
      const parsedURL = new URL(url);
      const hostname = parsedURL.hostname;
      const allowedHosts = ["google.com", "supabase.co"];
      if (allowedHosts.includes(hostname) || hostname.endsWith(".google.com") || hostname.endsWith(".supabase.co")) {
        shell.openExternal(url);
        return { action: "deny" }; // Do not open this URL in a new Electron window
      }
    } catch (error) {
      console.error("Invalid URL %d in setWindowOpenHandler: %d" , url , error);
      return { action: "deny" }; // Deny access as URL string is malformed or invalid
    }
    return { action: "allow" };
  })

  // Enhanced screen capture resistance
  state.mainWindow.setContentProtection(true)

  state.mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })
  state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1)

  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    // Prevent window from being captured in screenshots
    state.mainWindow.setHiddenInMissionControl(true)
    state.mainWindow.setWindowButtonVisibility(false)
    state.mainWindow.setBackgroundColor("#00000000")

    // Prevent window from being included in window switcher
    state.mainWindow.setSkipTaskbar(true)

    // Disable window shadow
    state.mainWindow.setHasShadow(false)
  }

  // Prevent the window from being captured by screen recording
  state.mainWindow.webContents.setBackgroundThrottling(false)
  state.mainWindow.webContents.setFrameRate(60)

  // Set up window listeners
  state.mainWindow.on("move", handleWindowMove)
  state.mainWindow.on("resize", handleWindowResize)
  state.mainWindow.on("closed", handleWindowClosed)

  // Initialize window state
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.windowSize = { width: bounds.width, height: bounds.height }
  state.currentX = bounds.x
  state.currentY = bounds.y
  state.isWindowVisible = true
  
  // Set opacity based on user preferences or hide initially
  // Ensure the window is visible for the first launch or if opacity > 0.1
  const savedOpacity = configHelper.getOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  
  // Always make sure window is shown first
  state.mainWindow.showInactive(); // Use showInactive for consistency
  
  if (savedOpacity <= 0.1) {
    console.log('Initial opacity too low, setting to 0 and hiding window');
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  } else {
    console.log(`Setting initial opacity to ${savedOpacity}`);
    state.mainWindow.setOpacity(savedOpacity);
    state.isWindowVisible = true;
  }
}

function handleWindowMove(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.currentX = bounds.x
  state.currentY = bounds.y
}

function handleWindowResize(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowSize = { width: bounds.width, height: bounds.height }
}

function handleWindowClosed(): void {
  state.mainWindow = null
  state.isWindowVisible = false
  state.windowPosition = null
  state.windowSize = null
}

// Window visibility functions
function hideMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds();
    state.windowPosition = { x: bounds.x, y: bounds.y };
    state.windowSize = { width: bounds.width, height: bounds.height };
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
    console.log('Window hidden, opacity set to 0');
  }
}

function showMainWindow(): void {
  if (!state.mainWindow?.isDestroyed()) {
    if (state.windowPosition && state.windowSize) {
      state.mainWindow.setBounds({
        ...state.windowPosition,
        ...state.windowSize
      });
    }
    // Re-showing the window must not silently cancel click-through mode -
    // the overlay would start eating clicks again while the UI still reports
    // click-through as enabled.
    state.mainWindow.setIgnoreMouseEvents(state.isClickThrough, { forward: true });
    state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    });
    state.mainWindow.setContentProtection(true);
    state.mainWindow.setOpacity(0); // Set opacity to 0 before showing
    state.mainWindow.showInactive(); // Use showInactive instead of show+focus
    state.mainWindow.setOpacity(1); // Then set opacity to 1 after showing
    state.isWindowVisible = true;
    console.log('Window shown with showInactive(), opacity set to 1');
  }
}

function toggleMainWindow(): void {
  console.log(`Toggling window. Current state: ${state.isWindowVisible ? 'visible' : 'hidden'}`);
  if (state.isWindowVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

// Window movement functions
function moveWindowHorizontal(updateFn: (x: number) => number): void {
  if (!state.mainWindow) return
  state.currentX = updateFn(state.currentX)
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY)
  )
}

function moveWindowVertical(updateFn: (y: number) => number): void {
  if (!state.mainWindow) return

  // Allow the window to sit up to 2/3 off screen in either direction.
  const height = state.windowSize?.height || 0
  const maxUpLimit = (-height * 2) / 3
  const maxDownLimit = state.screenHeight + (height * 2) / 3

  // Clamp rather than reject.
  //
  // This used to be `if (newY >= maxUpLimit && newY <= maxDownLimit)`, which
  // froze the window whenever currentY was already outside the range - and it
  // gets there on its own, because the limits are derived from the window
  // height and the window shrinks when the view changes. A window parked at
  // -430 while the height dropped 1761 -> 550 (limit -366) could move neither
  // up nor down: both candidates were out of range, so every keypress was
  // silently discarded and the window was stranded off-screen for good.
  const newY = Math.min(Math.max(updateFn(state.currentY), maxUpLimit), maxDownLimit)

  if (Math.round(newY) === Math.round(state.currentY)) return

  state.currentY = newY
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY)
  )
}

// Window dimension functions
/** Keep at least this much of the window on screen so it stays reachable. */
const MIN_VISIBLE_PX = 120

/** Must match the BrowserWindow minWidth/minHeight. */
const MIN_WINDOW_WIDTH = 750
const MIN_WINDOW_HEIGHT = 550

/**
 * Clamp a position so some of the window always remains on screen. Without
 * this a window that is moved up and then *shrinks* (the reset view is much
 * shorter than the solutions view) ends up entirely above the top edge, with
 * no way to get it back.
 */
function clampToScreen(y: number, windowHeight: number): number {
  const highest = -(Math.max(0, windowHeight - MIN_VISIBLE_PX))
  const lowest = state.screenHeight - MIN_VISIBLE_PX
  return Math.min(Math.max(y, highest), lowest)
}

function setWindowDimensions(width: number, height: number): void {
  if (!state.mainWindow?.isDestroyed()) {
    const [currentX, currentY] = state.mainWindow.getPosition()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const maxWidth = Math.floor(workArea.width * 0.5)

    // Bound the window at both ends, rather than relying on the OS to honour
    // the BrowserWindow min sizes - it stops doing that under some window
    // flags, and the overlay then collapses to the raw content size.
    const clampedHeight = Math.min(
      Math.max(Math.ceil(height), MIN_WINDOW_HEIGHT),
      workArea.height
    )
    const clampedWidth = Math.min(
      Math.max(width + 32, MIN_WINDOW_WIDTH),
      maxWidth
    )
    const clampedY = clampToScreen(currentY, clampedHeight)

    // Only pull the window left when it would actually hang off the right
    // edge. Recomputing x from the width on every update made the window
    // slide left and right by however much the measured width wobbled.
    const maxX = workArea.width - clampedWidth
    const nextX = currentX > maxX ? Math.max(0, maxX) : currentX

    // Ignore updates that change nothing meaningful.
    //
    // The renderer measures its own content and asks for a resize; resizing
    // changes the layout, which triggers another measurement. Opening a modal
    // adds scroll-lock padding and kicks that loop off, so the window
    // oscillates between two nearly-identical sizes indefinitely. A couple of
    // pixels of hysteresis stops it dead.
    const [w, h] = state.mainWindow.getSize()
    const RESIZE_EPSILON = 4
    if (
      Math.abs(w - clampedWidth) <= RESIZE_EPSILON &&
      Math.abs(h - clampedHeight) <= RESIZE_EPSILON &&
      nextX === currentX &&
      clampedY === currentY
    ) {
      return
    }

    state.mainWindow.setBounds({
      x: nextX,
      y: clampedY,
      width: clampedWidth,
      height: clampedHeight
    })
    state.currentX = nextX
    state.currentY = clampedY
  }
}

/**
 * Put the window back somewhere visible. This is the escape hatch for a
 * window that has been moved off-screen - bound to the reset shortcut, which
 * is what people reach for when the overlay "disappears".
 */
function recenterWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return

  const workArea = screen.getPrimaryDisplay().workAreaSize
  const [width, height] = state.mainWindow.getSize()
  const x = Math.max(0, Math.floor((workArea.width - width) / 2))
  const y = 50

  state.currentX = x
  state.currentY = y
  state.mainWindow.setPosition(x, y)
  console.log("Window recentered to", { x, y })
}

// Environment setup
function loadEnvVariables() {
  if (isDev) {
    console.log("Loading env variables from:", path.join(process.cwd(), ".env"))
    dotenv.config({ path: path.join(process.cwd(), ".env") })
  } else {
    console.log(
      "Loading env variables from:",
      path.join(process.resourcesPath, ".env")
    )
    dotenv.config({ path: path.join(process.resourcesPath, ".env") })
  }
  console.log("Environment variables loaded for open-source version")
}

// Initialize application
// Let the renderer capture system (loopback) audio and the microphone with
// no OS picker dialog and no permission prompt - both would be visible to
// anyone the user is screen-sharing with, which defeats the point of the
// invisible overlay. Failures here are non-fatal: audio capture is best
// effort and the app must keep working screenshot-only if it's unavailable.
function setupSilentMediaCapture(): void {
  try {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (sources.length === 0) {
            callback({})
            return
          }
          // 'loopback' captures whatever is playing through the speakers
          // (e.g. the interviewer's voice over a call) - Windows/macOS only.
          callback({ video: sources[0], audio: "loopback" })
        })
        .catch((err) => {
          console.error("Silent display-media capture failed:", err)
          callback({})
        })
    })

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === "media") {
        callback(true)
        return
      }
      callback(false)
    })
  } catch (err) {
    console.error("Failed to set up silent media capture:", err)
  }
}

/**
 * The app used to store its data under "interview-coder-v1". Carry the saved
 * settings (API key, model choice, language) across to the new folder so a
 * rename doesn't silently look like a factory reset to existing users.
 */
function migrateLegacyUserData(newPath: string): void {
  try {
    const legacyPath = path.join(app.getPath('appData'), 'interview-coder-v1')
    const legacyConfig = path.join(legacyPath, 'config.json')
    const newConfig = path.join(newPath, 'config.json')

    if (!fs.existsSync(legacyConfig)) return

    // ConfigHelper is a module-level singleton, so by the time this runs it has
    // already written a default config. Treat a config with no API key as "not
    // yet set up" and migrate over it - but never clobber real settings.
    if (fs.existsSync(newConfig)) {
      try {
        const existing = JSON.parse(fs.readFileSync(newConfig, 'utf8'))
        if (existing?.apiKey) return
      } catch {
        // Unreadable config - replacing it with the legacy one is an upgrade.
      }
    }

    const legacy = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'))
    if (!legacy?.apiKey) return

    if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true })
    fs.writeFileSync(newConfig, JSON.stringify(legacy, null, 2))
    console.log('Migrated settings from the previous app data folder.')
  } catch (err) {
    // A failed migration just means the user re-enters their key - never fatal.
    console.warn('Could not migrate previous settings:', err)
  }
}

async function initializeApp() {
  try {
    // Derive the data folder from the app's own name. ConfigHelper is a
    // module-level singleton that resolves userData at import time - before
    // this runs - so hardcoding a different folder here would split settings
    // across two locations.
    const appDataPath = path.join(app.getPath('appData'), app.getName())
    migrateLegacyUserData(appDataPath)
    const sessionPath = path.join(appDataPath, 'session')
    const tempPath = path.join(appDataPath, 'temp')
    const cachePath = path.join(appDataPath, 'cache')
    
    // Create directories if they don't exist
    for (const dir of [appDataPath, sessionPath, tempPath, cachePath]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    
    app.setPath('userData', appDataPath)
    app.setPath('sessionData', sessionPath)      
    app.setPath('temp', tempPath)
    app.setPath('cache', cachePath)
      
    loadEnvVariables()
    setupSilentMediaCapture()

    // Ensure a configuration file exists
    if (!configHelper.hasApiKey()) {
      console.log("No API key found in configuration. User will need to set up.")
    }
    
    initializeHelpers()
    initializeIpcHandlers({
      getMainWindow,
      setWindowDimensions,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      getView,
      toggleMainWindow,
      clearQueues,
      setView,
      setVoiceTranscript,
      getAssistantHelper,
      captureScreenBase64,
      setClickThrough,
      toggleClickThrough,
      recenterWindow,
      focusWindow,
      blurWindow,
      moveWindowLeft: () =>
        moveWindowHorizontal((x) =>
          Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
        ),
      moveWindowRight: () =>
        moveWindowHorizontal((x) =>
          Math.min(
            state.screenWidth - (state.windowSize?.width || 0) / 2,
            x + state.step
          )
        ),
      moveWindowUp: () => moveWindowVertical((y) => y - state.step),
      moveWindowDown: () => moveWindowVertical((y) => y + state.step)
    })
    await createWindow()
    state.shortcutsHelper?.registerGlobalShortcuts()

    // Initialize auto-updater regardless of environment
    initAutoUpdater()
    console.log(
      "Auto-updater initialized in",
      isDev ? "development" : "production",
      "mode"
    )
  } catch (error) {
    console.error("Failed to initialize application:", error)
    app.quit()
  }
}

// Auth callback handling removed - no longer needed
app.on("open-url", (event, url) => {
  console.log("open-url event received:", url)
  event.preventDefault()
})

// Handle second instance (removed auth callback handling)
app.on("second-instance", (event, commandLine) => {
  console.log("second-instance event received:", commandLine)
  
  // Focus or create the main window
  if (!state.mainWindow) {
    createWindow()
  } else {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
  }
})

// Prevent multiple instances of the app
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
      state.mainWindow = null
    }
  })
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// State getter/setter functions
function getMainWindow(): BrowserWindow | null {
  return state.mainWindow
}

function getView(): "queue" | "solutions" | "debug" {
  return state.view
}

function setView(view: "queue" | "solutions" | "debug"): void {
  state.view = view
  state.screenshotHelper?.setView(view)
}

function getScreenshotHelper(): ScreenshotHelper | null {
  return state.screenshotHelper
}

function getProblemInfo(): any {
  return state.problemInfo
}

function setProblemInfo(problemInfo: any): void {
  state.problemInfo = problemInfo
}

function getAssistantHelper(): AssistantHelper | null {
  return state.assistantHelper
}

/**
 * Click-through mode: the overlay stays visible to the user but every mouse
 * event passes to whatever is behind it, so it can sit on top of a call
 * window without ever stealing a click.
 */
function setClickThrough(enabled: boolean): boolean {
  state.isClickThrough = enabled
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.setIgnoreMouseEvents(enabled, { forward: true })
    state.mainWindow.webContents.send("click-through-changed", enabled)
  }
  return state.isClickThrough
}

function toggleClickThrough(): boolean {
  return setClickThrough(!state.isClickThrough)
}

/**
 * Give the overlay real keyboard focus.
 *
 * The window is always shown with showInactive() so it never steals focus
 * from the call or the editor - which is right by default, but it also means
 * the ask box could never be typed into: focusing the input in the DOM does
 * nothing when the OS hasn't focused the window. Typing has to ask for focus
 * explicitly.
 */
function focusWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return

  // Click-through makes the window unfocusable, so lift it for as long as
  // the user is typing; the renderer restores it afterwards.
  if (state.isClickThrough) setClickThrough(false)

  state.mainWindow.setFocusable(true)
  state.mainWindow.focus()
}

/** Hand focus back so keystrokes return to whatever was underneath. */
function blurWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return
  state.mainWindow.blur()
}

/** Screen grab for the assistant that never enters the screenshot queue. */
async function captureScreenBase64(): Promise<string | null> {
  if (!state.screenshotHelper) return null
  try {
    return await state.screenshotHelper.captureScreenBase64(
      () => hideMainWindow(),
      () => showMainWindow()
    )
  } catch (error) {
    console.warn("captureScreenBase64 failed:", error)
    return null
  }
}

/**
 * Spoken context for the coding flow. The live assistant transcript is the
 * single source of truth; `state.voiceTranscript` remains as a manual override.
 */
function getVoiceTranscript(): string {
  const live = (state.assistantHelper?.getTranscript() || [])
    .map((s) => `${s.source === "them" ? "Them" : "Me"}: ${s.text}`)
    .join("\n")

  const combined = [state.voiceTranscript, live].filter(Boolean).join("\n")
  const MAX = 4000
  return combined.length > MAX ? combined.slice(combined.length - MAX) : combined
}

function setVoiceTranscript(transcript: string): void {
  state.voiceTranscript = transcript
}

function getScreenshotQueue(): string[] {
  return state.screenshotHelper?.getScreenshotQueue() || []
}

function getExtraScreenshotQueue(): string[] {
  return state.screenshotHelper?.getExtraScreenshotQueue() || []
}

function clearQueues(): void {
  state.screenshotHelper?.clearQueues()
  state.problemInfo = null
  state.voiceTranscript = ""

  // Reset also has to wipe the live assistant. Without this the transcript
  // and the chat history from the previous question survived, so a "start
  // fresh" still answered against whatever was said before it.
  state.assistantHelper?.stop()
  state.assistantHelper?.clearTranscript()

  setView("queue")
}

async function takeScreenshot(): Promise<string> {
  if (!state.mainWindow) throw new Error("No main window available")
  return (
    state.screenshotHelper?.takeScreenshot(
      () => hideMainWindow(),
      () => showMainWindow()
    ) || ""
  )
}

async function getImagePreview(filepath: string): Promise<string> {
  return state.screenshotHelper?.getImagePreview(filepath) || ""
}

async function deleteScreenshot(
  path: string
): Promise<{ success: boolean; error?: string }> {
  return (
    state.screenshotHelper?.deleteScreenshot(path) || {
      success: false,
      error: "Screenshot helper not initialized"
    }
  )
}

function setHasDebugged(value: boolean): void {
  state.hasDebugged = value
}

function getHasDebugged(): boolean {
  return state.hasDebugged
}

// Export state and functions for other modules
export {
  state,
  createWindow,
  hideMainWindow,
  showMainWindow,
  toggleMainWindow,
  setWindowDimensions,
  moveWindowHorizontal,
  moveWindowVertical,
  getMainWindow,
  getView,
  setView,
  getScreenshotHelper,
  getProblemInfo,
  setProblemInfo,
  getScreenshotQueue,
  getExtraScreenshotQueue,
  clearQueues,
  takeScreenshot,
  getImagePreview,
  deleteScreenshot,
  setHasDebugged,
  getHasDebugged
}

app.whenReady().then(initializeApp)
