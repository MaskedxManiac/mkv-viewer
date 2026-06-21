# mkv-viewer

A browser-based MKV player that runs entirely inside Safari — no app
install required. Built for devices where the App Store is off-limits
(MDM-managed iPads, etc).

Open the page, choose an `.mkv` file, and it's demuxed/remuxed
in-browser with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
(WebAssembly, single-threaded — no special server headers needed, so
plain GitHub Pages hosting works). Nothing is uploaded anywhere.

Features:
- Switches between multiple audio language tracks (e.g. English / Hindi)
- Switches between subtitle tracks (text-based: SRT/ASS — converted to WebVTT)
- 10 second skip back / forward
- Remembers playback position, audio language, and subtitle choice per file
  (re-pick the same file later and it re-extracts, then auto-seeks back)

Live at: https://maskedxmaniac.github.io/mkv-viewer/
