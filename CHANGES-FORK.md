# Changes in this fork

This is a modified version of **CodeInterviewAssist**
(https://github.com/greeneu/interview-coder-withoupaywall-opensource),
distributed under the same GNU AGPL-3.0 licence as the original.

The AGPL requires modified versions to carry prominent notices stating what was
changed. This file is that notice.

## Renamed

The application is now **Code Pro**. Product name, app id, window title and the
user-data directory changed; settings are migrated automatically from the old
`interview-coder-v1` directory on first run.

## Fixed

- **Retired models broke every request.** The app shipped with `gemini-2.0-flash`
  and `gemini-1.5-pro` hardcoded, both since retired, so every Gemini call
  returned 404. Worse, the config sanitiser rewrote any model the user chose back
  to that dead default, so it could not be fixed from Settings. Retired models are
  now migrated to working equivalents and the migration is persisted; unrecognised
  models pass through untouched instead of being downgraded.
- **Misleading API errors.** A spent daily quota reported "check your API key",
  sending users after the wrong problem. Errors now distinguish quota, rate limit,
  revoked key, retired model and provider outage. Streaming error bodies are read
  rather than discarded (with `responseType: "stream"` the body arrives as an
  unread stream, so the provider's actual message never surfaced).
- **Crash on unusual model responses.** Parsing used
  `candidates[0].content.parts[0].text`, which throws when a model returns no
  parts — normal on `MAX_TOKENS` and safety stops.
- **Fabricated complexity.** When the complexity failed to parse, the app
  substituted a hardcoded string about hashmap lookups regardless of the actual
  problem, and prefixed a guessed `O(n)` to any prose. Both removed.
- **Copy button never worked in production.** The renderer is loaded from
  `file://`, which is not a secure context, so `navigator.clipboard` was undefined
  and every copy threw silently. Clipboard access now goes through the main process.
- **Window could be stranded off-screen.** Vertical movement rejected out-of-range
  positions instead of clamping, so once the window was outside the allowed range
  (which happened on its own when the view changed size) it could move neither up
  nor down. Movement now clamps, height is capped to the screen, and reset
  recentres the window.
- **Dead global shortcuts were silent.** `globalShortcut.register` returns false
  when another process already owns an accelerator — typically a leftover instance
  — and the return value was discarded at all 20 registration sites, so every
  hotkey silently did nothing. Conflicts are now logged and reported.
- **Settings dialog shook.** The window resizes itself to fit content, and opening
  a modal perturbed that measurement, causing an unbounded resize loop. Auto-resize
  is suspended while a modal is open, x is no longer recomputed from width, and
  near-identical resizes are ignored.
- **Ctrl+R did not reset the assistant.** Transcript and chat history survived a
  reset, so "start fresh" still answered against the previous question.

## Added

- **Live transcription** of system audio and microphone as separate labelled
  speakers, streaming over the Gemini Live API where available and falling back to
  batched uploads otherwise.
- **Live assistant**: ask a question mid-conversation, or answer whatever was just
  said, with streaming replies and follow-up context.
- **Model fail-safe**: quota-exhausted, retired, overloaded or stalled requests
  automatically fall back through a chain of working models.
- **Richer solutions**: a spoken-style derivation, a traced walkthrough that
  explains why each load-bearing construct exists, explicit edge cases, and
  complexity derived from the generated code rather than recalled.
- **Click-through mode**, so the overlay never intercepts a click.

## Stealth fixes

Several things leaked despite the window itself being excluded from capture,
because the OS draws them outside the window:

- Native `title` tooltips were visible in screen shares; replaced with in-app ones.
- The native `<select>` dropdown had the same problem; replaced with a div menu.
- The mouse cursor changed shape over the overlay (I-beam over inputs, hand over
  buttons), which is visible to everyone on a call; all cursors are now forced to
  the plain arrow.
- Transcript contents were being written to stdout; reduced to metadata only.
