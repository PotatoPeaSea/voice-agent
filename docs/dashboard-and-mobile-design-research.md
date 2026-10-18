# Dashboard and phone app: design styles and components

Research for IMPROVEMENTS items 6 (dashboard / desktop app) and 7 (phone app). Done 2026-10-17. Secondary sources are
marked; check anything marked "unverified" on a device before building on it.

## What the two apps have to show

From README, IMPROVEMENTS and HANDOFF, the screens need to carry this project's own data, not a generic "voice bot":

| Data | Where it comes from today | Dashboard | Phone |
|---|---|---|---|
| Bot / TTS service up or down, GPU vs cloud fallback, MCP servers up or failed | startup log, `qwen-tts.log` | status strip + service cards | small status dot |
| Conversation state: listening, thinking, speaking, waiting for wake phrase (`interrupt` mode), hold music | `VoiceSession`, listen modes | live state pill | the main screen |
| Agent tasks `t1`, `t2`... with progress, model/effort/mode, report, `VOICE SUMMARY` | `data/tasks/`, Discord threads | task list + detail pane | task cards, push when done |
| Permission requests from agents, `run_command` / `discord_send` confirmations | ACP, `confirm.ts` | approve/deny card | actionable notification |
| Latency breakdown (speech end → turn end → LLM first token → first sentence → TTS first audio → playing) | per-reply log line | waterfall chart per turn | no |
| Voices, cloning (≤15 s clip), prompts, listen mode | `voices.yaml`, `/voice`, `/prompt`, `/mode` | forms, clip trimmer | quick switcher |
| Reminders, shared memory | reminder tools, `MEMORY_URL` | lists | lists |
| `.env`, `config/*.yaml`, allowed users and folders, Google auth | hand-edited files | settings forms + setup wizard | no |

The state set is wider than the usual listening / thinking / speaking: this bot also has **waiting for wake phrase**,
**agent working (hold music)**, **needs your answer** (permission request) and **song playing**. The state visuals
should cover all of them.

## Recommended direction

**One design system, two shells.** React + Tailwind v4 + shadcn/ui tokens for both, so the orb, transcript, task
card and permission card are written once.

- **Dashboard:** Tauri 2 (or Electron) wrapping a React + shadcn app, talking to the bot over the local HTTP/WebSocket
  API that IMPROVEMENTS item 6 already calls for. Tauri is much smaller and lighter; Electron renders the same on every
  OS and has the more mature packaging and auto-update tools ([pkgpulse](https://www.pkgpulse.com/guides/electron-vs-tauri-2026),
  [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/); both secondary). Since the bot already runs on
  Node, Electron avoids adding Rust; Tauri wins if bundle size matters. Either works with shadcn.
- **Phone, step 1: a PWA** reusing the same React components. Fastest way to "press and talk" away from Discord.
  Limits on iOS: the mic stream ends when the app is backgrounded (open WebKit bug), and Web Push works only once the
  app is added to the home screen ([Firtman's iOS PWA notes](https://firt.dev/notes/pwa-ios/),
  [WebKit 226163](https://bugs.webkit.org/show_bug.cgi?id=226163)). Fine for a foreground talk screen, not for
  Siri-style launching.
- **Phone, step 2: Expo (React Native)** once lock-screen/side-button launch matters. Expo UI is stable in SDK 56 and
  renders real SwiftUI on iOS and Jetpack Compose on Android from one `@expo/ui` import
  ([Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56), [Expo UI SDK 55 post](https://expo.dev/blog/expo-ui-in-sdk-55-jetpack-compose-now-available-for-react-native-apps)),
  so the platform chrome looks native while the orb and transcript stay custom.

## Design styles

### Dashboard: "quiet ops console"
The look of tools people keep open all day: Linear, Vercel, Supabase, PostHog. Roundups describe it as dark-first,
monochrome chrome where **color only means something** (status, severity, the assistant's own accent), dense lists,
keyboard-first ([adminlte roundup](https://adminlte.io/blog/saas-dashboard-design-examples/),
[inspoai](https://www.inspoai.io/blog/dark-mode-design-examples); secondary).

- Dark gray/near-black surfaces in two or three elevation steps rather than pure black; off-white text.
- Three panes: sidebar (Overview, Tasks, Voices, Tools/MCP, Memory, Settings, Logs) → list → detail panel.
- A command palette (Ctrl+K): "restart TTS", "switch voice to …", "cancel t3", "open logs". It mirrors the voice
  commands, which suits this project.
- Status strip along the top: Discord ● · STT ● · LLM ● · TTS (local GPU / cloud fallback) ● · MCP 4/5 ●. Green/amber/red
  are the only saturated colors besides the accent.
- Monospace for task ids, log lines, latencies.

### Phone: "ambient orb"
Full-screen and calm, one big target, the state shown by motion rather than text.

- The orb/aura **is** the state indicator. Listening reacts to your mic level, thinking pulses without input, speaking
  follows the bot's output level. Guidance from voice-UX writers: listening must be unmistakable, thinking must not look
  frozen, and on barge-in the speaking animation has to stop at once (half a second of lag reads as broken)
  ([vp0](https://vp0.com/blogs/ai-voice-agent-ui-screen), [uxdesign.cc](https://uxdesign.cc/8-voice-aiux-patterns-81324c8feaa0); secondary).
- **Transcript in the same view.** ChatGPT dropped its separate blue-orb voice screen in Nov 2025 and moved voice into
  the chat, with a live transcript, inline cards, scrolling without interrupting and typing as a fallback; the old
  separate mode is still a setting ([Android Authority](https://www.androidauthority.com/chatgpt-voice-mode-in-chat-3619633),
  [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect)).
  Worth copying: orb on top or as a collapsible header, transcript and task cards below.
- Task updates and permission requests appear as cards in the transcript ("t3 wants to run `npm test` — Allow / Deny").
- Platform chrome: on iOS 26, Liquid Glass belongs to the navigation and control layer only, never on content cards
  or glass stacked on glass ([Firefox Acorn notes](https://acorn.firefox.com/latest/mobile/patterns/i-os-26-and-liquid-glass-w2oH48nk),
  [atelier-socle](https://www.atelier-socle.com/en/articles/swiftui-liquid-glass-guide)). On Android, Material 3
  Expressive adds button groups, FAB menus, the new loading indicator, split buttons and toolbars, plus spring motion
  ([9to5Google](https://9to5google.com/2025/05/13/android-16-material-3-expressive-redesign/)). Expo UI gets both for
  free; the M3 Expressive loading indicator is a natural "thinking" state on Android.

### Shared identity
Give the assistant (Veronica) a signature accent color and orb treatment, and use it for the Discord bot avatar, the
dashboard accent and the phone orb. One accent, everything else neutral.

## Ready-made components

All three voice libraries are shadcn registries: the source is copied into your repo and can be edited.

| Library | What's useful | Catch |
|---|---|---|
| [ElevenLabs UI](https://elevenlabs.io/blog/elevenlabs-ui) (MIT, [repo](https://github.com/elevenlabs/ui)) | **Orb**, Live Waveform, Conversation Bar, Voice Button, Voice Picker, audio player; blocks such as a dictation component and a voice chat with state built in | Docs assume Next.js; whether components need the ElevenLabs SDK is unverified (the components page rate-limited me). Copying the visuals and driving them with our own state should work |
| [LiveKit Agents UI](https://docs.livekit.io/frontends/components/agents-ui/) | Five visualizers (Bar, Grid, Radial, Wave, **Aura** — a WebGL shader that reacts to state and volume), control bar, chat transcript | "Most components require a LiveKit session object" ([LiveKit blog](https://livekit.com/blog/design-voice-ai-interfaces-with-agents-ui)). Use them as reference, or as the transport too if we pick LiveKit for WebRTC |
| [Pipecat UI](https://docs.pipecat.ai/client/pipecat-ui) (replaces Voice UI Kit) | Indicators, transcripts, controls, a console template; the old kit had headless components | Tied to the Pipecat client; needs React 19, Tailwind 4 |

Dashboard parts:
- shadcn/ui primitives (sidebar, table, tabs, sheet, command palette, form, toast) and shadcn charts for the latency
  waterfall and per-turn trends.
- Logs: a virtualized viewer fed from a WebSocket, with level filter and follow toggle.
  [react-logviewer](https://openapps.pro/packages/react-logviewer) does streaming from WebSocket/EventSource (MPL-2.0);
  21st.dev and shadcn.io have shadcn-styled log/event blocks ([shadcn.io event log](https://www.shadcn.io/blocks/dashboard-event-log)).
- Voice cloning: a waveform with a trim range to pick the ≤15 s reference, then a "say a test line" button.
- Setup wizard: stepper for Discord token → channel → API keys (each with a live "check" like `npm run check`) → Google
  auth → first test call.

**Suggestion:** write one `useVoiceSession()` hook in our code that exposes `state` (the full state set above),
`inputLevel`, `outputLevel` and `transcript`, and feed it to whichever orb we copy in. Then the transport (WebSocket now,
WebRTC/LiveKit later) can change without touching the UI.

## Launching it like Siri (phone)

- **iOS:** `AudioRecordingIntent` (iOS 18+) marks an intent as recording audio and shows the recording indicator
  ([Apple docs](https://developer.apple.com/documentation/appintents/audiorecordingintent)). Developer forum reports say
  starting the mic from a fully backgrounded state or the lock screen fails; what works is starting in the foreground and
  then controlling the session from a **Live Activity** ([forum 815725](https://developer.apple.com/forums/thread/815725),
  [forum 836958](https://developer.apple.com/forums/thread/836958); unverified). Plan: the Action button / Control Center
  control opens the app straight into listening, and a Live Activity shows "Veronica: listening / t3 working" on the lock
  screen and Dynamic Island.
- **Android:** an app that implements `VoiceInteractionService` or handles `ACTION_ASSIST` can hold the assistant role
  (`RoleManagerCompat`), which is what long-press power / the assist gesture launches
  ([Android docs](https://developer.android.com/reference/androidx/core/role/RoleManagerCompat)). A reported gotcha:
  reinstalling the APK clears the role, and on a Pixel 10 long-press still went to Gemini
  ([issue](https://github.com/anthropics/claude-code/issues/41696)). A Quick Settings tile and a home-screen widget are
  easy extra entry points.
- Both: push notifications for finished tasks, reminders and permission requests, with Allow/Deny as notification actions.

## Open questions for you

1. Electron or Tauri for the dashboard? (Electron: no Rust, same Node stack. Tauri: smaller, also builds mobile.)
2. Start the phone app as a PWA, or go straight to Expo for lock-screen and side-button launch?
3. Dark-only, or dark + light?
4. Is LiveKit an option for the phone audio transport? If so, its Agents UI comes almost for free.
5. A signature color/look for Veronica, or should I propose a few?
