export interface TranscriptSegment {
  id: string
  source: "them" | "you"
  text: string
  timestamp: number
}

export interface ElectronAPI {
  // Original methods
  openSubscriptionPortal: (authData: {
    id: string
    email: string
  }) => Promise<{ success: boolean; error?: string }>
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  clearStore: () => Promise<{ success: boolean; error?: string }>
  getScreenshots: () => Promise<{
    success: boolean
    previews?: Array<{ path: string; preview: string }> | null
    error?: string
  }>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  openExternal: (url: string) => void
  toggleMainWindow: () => Promise<{ success: boolean; error?: string }>
  triggerScreenshot: () => Promise<{ success: boolean; error?: string }>
  triggerProcessScreenshots: () => Promise<{ success: boolean; error?: string }>
  updateVoiceTranscript: (transcript: string) => Promise<{ success: boolean; error?: string }>

  // Live assistant
  sendAudioFrame: (pcm: string, source: "them" | "you") => void
  supportsLiveTranscription: () => Promise<{ supported: boolean }>
  stopLiveTranscription: () => Promise<{ success: boolean }>
  onInterimTranscript: (
    callback: (data: { source: "them" | "you"; text: string }) => void
  ) => () => void
  transcribeChunk: (
    base64: string,
    mimeType: string,
    source: "them" | "you"
  ) => Promise<{ success: boolean; text?: string; error?: string }>
  getTranscript: () => Promise<TranscriptSegment[]>
  clearTranscript: () => Promise<{ success: boolean }>
  askAssistant: (
    question: string,
    includeScreen?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  answerLatest: (
    includeScreen?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  stopAssistant: () => Promise<{ success: boolean }>
  setClickThrough: (
    enabled: boolean
  ) => Promise<{ success: boolean; enabled: boolean }>
  toggleClickThrough: () => Promise<{ success: boolean; enabled: boolean }>
  writeClipboard: (text: string) => Promise<{ success: boolean; error?: string }>
  recenterWindow: () => Promise<{ success: boolean }>
  focusWindow: () => Promise<{ success: boolean }>
  blurWindow: () => Promise<{ success: boolean }>
  onProcessingStatus: (
    callback: (data: { message: string; progress: number }) => void
  ) => () => void
  onSolutionChunk: (callback: (delta: string) => void) => () => void
  onTranscriptUpdate: (
    callback: (segments: TranscriptSegment[]) => void
  ) => () => void
  onAssistantStreamStart: (
    callback: (data: { question: string; isAuto: boolean }) => void
  ) => () => void
  onAssistantStreamChunk: (callback: (delta: string) => void) => () => void
  onAssistantStreamDone: (
    callback: (data: { answer?: string; aborted?: boolean }) => void
  ) => () => void
  onAssistantStreamError: (callback: (error: string) => void) => () => void
  onFocusAsk: (callback: () => void) => () => void
  onClickThroughChanged: (callback: (enabled: boolean) => void) => () => void
  triggerReset: () => Promise<{ success: boolean; error?: string }>
  triggerMoveLeft: () => Promise<{ success: boolean; error?: string }>
  triggerMoveRight: () => Promise<{ success: boolean; error?: string }>
  triggerMoveUp: () => Promise<{ success: boolean; error?: string }>
  triggerMoveDown: () => Promise<{ success: boolean; error?: string }>
  onSubscriptionUpdated: (callback: () => void) => () => void
  onSubscriptionPortalClosed: (callback: () => void) => () => void
  startUpdate: () => Promise<{ success: boolean; error?: string }>
  installUpdate: () => void
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void

  decrementCredits: () => Promise<void>
  setInitialCredits: (credits: number) => Promise<void>
  onCreditsUpdated: (callback: (credits: number) => void) => () => void
  onOutOfCredits: (callback: () => void) => () => void
  openSettingsPortal: () => Promise<void>
  getPlatform: () => string
  
  // New methods for OpenAI integration
  getConfig: () => Promise<{
    apiKey: string
    apiProvider?: "openai" | "gemini" | "anthropic"
    extractionModel?: string
    solutionModel?: string
    debuggingModel?: string
    language?: string
    opacity?: number
  }>
  // Previously declared only { apiKey, model }, while the settings dialog
  // saves provider and three separate model fields through it.
  updateConfig: (config: {
    apiKey?: string
    apiProvider?: "openai" | "gemini" | "anthropic"
    extractionModel?: string
    solutionModel?: string
    debuggingModel?: string
    language?: string
    opacity?: number
  }) => Promise<boolean>
  checkApiKey: () => Promise<boolean>
  validateApiKey: (apiKey: string) => Promise<{ valid: boolean; error?: string }>
  openLink: (url: string) => void
  onApiKeyInvalid: (callback: () => void) => () => void
  removeListener: (eventName: string, callback: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    electron: {
      ipcRenderer: {
        on: (channel: string, func: (...args: any[]) => void) => void
        removeListener: (
          channel: string,
          func: (...args: any[]) => void
        ) => void
      }
    }
    __CREDITS__: number
    __LANGUAGE__: string
    __IS_INITIALIZED__: boolean
    __AUTH_TOKEN__?: string | null
  }
}
