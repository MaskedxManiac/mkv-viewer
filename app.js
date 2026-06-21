/* ===================================================================
   Reel — a local-only MKV player
   Everything happens in this tab: the file is read with the
   File API, demuxed/remuxed in-browser with ffmpeg.wasm (compiled
   to WebAssembly, no upload, no server), and played with a plain
   <video> element. Nothing here ever leaves the device.
   =================================================================== */

(function () {
  "use strict";

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);

  const screenIdle = $("screenIdle");
  const screenProcessing = $("screenProcessing");
  const screenPlayer = $("screenPlayer");

  const dropZone = $("dropZone");
  const chooseBtn = $("chooseBtn");
  const fileInput = $("fileInput");
  const resumeNotice = $("resumeNotice");

  const procTitle = $("procTitle");
  const procFile = $("procFile");
  const procBar = $("procBar");
  const procLog = $("procLog");

  const video = $("video");
  const playerWrap = $("playerWrap");
  const controls = $("controls");
  const playBtn = $("playBtn");
  const playIcon = $("playIcon");
  const backBtn = $("backBtn");
  const fwdBtn = $("fwdBtn");
  const seek = $("seek");
  const curTimeEl = $("curTime");
  const durTimeEl = $("durTime");
  const tracksBtn = $("tracksBtn");
  const tracksBtnLabel = $("tracksBtnLabel");
  const sheet = $("sheet");
  const sheetBackdrop = $("sheetBackdrop");
  const audioTrackRow = $("audioTrackRow");
  const subTrackRow = $("subTrackRow");
  const toastEl = $("toast");
  const topTag = $("topTag");

  /* ---------------- language labels ---------------- */
  const LANG_NAMES = {
    eng: "English", hin: "Hindi", kan: "Kannada", tam: "Tamil", tel: "Telugu",
    mal: "Malayalam", mar: "Marathi", ben: "Bengali", guj: "Gujarati", pan: "Punjabi",
    urd: "Urdu", spa: "Spanish", fre: "French", fra: "French", ger: "German",
    deu: "German", jpn: "Japanese", kor: "Korean", chi: "Chinese", zho: "Chinese",
    rus: "Russian", ara: "Arabic", por: "Portuguese", ita: "Italian", und: "Unknown"
  };
  const langLabel = (code, idx) => {
    if (code && LANG_NAMES[code]) return LANG_NAMES[code];
    if (code && code !== "und") return code.toUpperCase();
    return "Track " + (idx + 1);
  };

  const TEXT_SUB_CODECS = new Set(["subrip", "ass", "ssa", "mov_text", "webvtt", "text"]);
  const BITMAP_SUB_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);

  /* ---------------- tiny helpers ---------------- */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  function showScreen(el) {
    [screenIdle, screenProcessing, screenPlayer].forEach((s) => s.classList.add("hide"));
    el.classList.remove("hide");
  }

  function logLine(text, cls) {
    const div = document.createElement("div");
    div.className = "line " + (cls || "");
    div.textContent = text;
    procLog.appendChild(div);
    procLog.scrollTop = procLog.scrollHeight;
    return div;
  }

  /* ---------------- resume storage (localStorage, tiny) ----------------
     We only persist a few bytes of position/track-choice metadata per
     file fingerprint — never the video itself. Re-selecting the same
     file later re-extracts tracks (a browser security limit means a
     page can't silently reopen a local file on its own) and then
     seeks straight back to where playback stopped. */
  const RESUME_PREFIX = "reelmkv:";
  function fingerprint(file) {
    return RESUME_PREFIX + file.name + "::" + file.size + "::" + file.lastModified;
  }
  function loadResume(file) {
    try {
      const raw = localStorage.getItem(fingerprint(file));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveResume(file, data) {
    try {
      localStorage.setItem(fingerprint(file), JSON.stringify(data));
      localStorage.setItem(RESUME_PREFIX + "__last", JSON.stringify({
        name: file.name, t: data.t, savedAt: Date.now()
      }));
    } catch (e) { /* quota or private mode — ignore */ }
  }
  function showIdleResumeHint() {
    try {
      const raw = localStorage.getItem(RESUME_PREFIX + "__last");
      if (!raw) { resumeNotice.classList.add("hide"); return; }
      const last = JSON.parse(raw);
      resumeNotice.innerHTML = `<span class="resume-pill">Continue “${last.name}” from ${fmtTime(last.t)}</span>`;
      resumeNotice.classList.remove("hide");
    } catch (e) { resumeNotice.classList.add("hide"); }
  }

  /* ===================================================================
     STATE
     =================================================================== */
  let ffmpeg = null;
  let ffmpegLoaded = false;
  let currentFile = null;
  let resumeData = null;

  let audioTracks = [];   // [{streamIndex, lang, codec, label, url}]
  let subTracks = [];     // [{streamIndex, lang, codec, label, url, supported}]
  let activeAudioIdx = 0;
  let activeSubIdx = -1;  // -1 = off
  let videoStreamIndex = 0;

  let suppressSave = false;
  let lastSaveAt = 0;
  let currentProgressListener = null;

  /* ===================================================================
     FFMPEG SETUP (lazy — only loaded once user picks a file)
     =================================================================== */
  async function ensureFFmpeg() {
    if (ffmpegLoaded) return;
    const { FFmpeg } = FFmpegWASM;
    ffmpeg = new FFmpeg();
    // Resolve to absolute blob: URLs up front — a worker resolves relative
    // paths against its own script location (the 814.ffmpeg.js chunk),
    // not the page, so a plain relative path here would point to the
    // wrong folder.
    const base = new URL("vendor/ffmpeg/", document.baseURI).href;
    const coreURL = await FFmpegUtil.toBlobURL(base + "ffmpeg-core.js", "text/javascript");
    const wasmURL = await FFmpegUtil.toBlobURL(base + "ffmpeg-core.wasm", "application/wasm");
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegLoaded = true;
  }

  /* Parse the "Stream #0:N(lang): Type: codec ..." lines ffmpeg prints
     when probing a file with `-i` and no output (it exits non-zero,
     but the stream listing has already been logged by then). */
  function parseStreams(logLines) {
    const re = /Stream #0:(\d+)(?:\((\w+)\))?:\s*(Video|Audio|Subtitle):\s*([A-Za-z0-9_]+)/;
    const streams = [];
    for (const line of logLines) {
      const m = line.match(re);
      if (m) {
        streams.push({
          index: parseInt(m[1], 10),
          lang: m[2] || null,
          type: m[3],
          codec: m[4],
        });
      }
    }
    return streams;
  }

  async function probeFile(filename) {
    const lines = [];
    const collector = ({ message }) => lines.push(message);
    ffmpeg.on("log", collector);
    try {
      await ffmpeg.exec(["-hide_banner", "-i", filename]);
    } catch (e) {
      /* expected: ffmpeg -i with no output "fails" — we only wanted the log */
    }
    ffmpeg.off("log", collector);
    return parseStreams(lines);
  }

  /* ===================================================================
     MAIN PROCESSING PIPELINE
     =================================================================== */
  async function processFile(file) {
    currentFile = file;
    resumeData = loadResume(file);

    showScreen(screenProcessing);
    procLog.innerHTML = "";
    procBar.style.width = "0%";
    procFile.textContent = file.name + "  ·  " + (file.size / (1024 * 1024)).toFixed(0) + " MB";
    procTitle.textContent = "Starting up…";

    let stepNote = logLine("Loading the in-browser conversion engine…", "now");
    await ensureFFmpeg();
    stepNote.className = "line ok";
    stepNote.textContent = "Conversion engine ready";

    procTitle.textContent = "Reading file structure…";
    const inputName = "input.mkv";
    await ffmpeg.writeFile(inputName, await FFmpegUtil.fetchFile(file));

    const streams = await probeFile(inputName);
    const videoStream = streams.find((s) => s.type === "Video");
    const audioStreams = streams.filter((s) => s.type === "Audio");
    const subStreams = streams.filter((s) => s.type === "Subtitle");

    if (!videoStream) {
      logLine("Couldn't find a video track in this file.", "skip");
      toast("This doesn't look like a playable video file.");
      showScreen(screenIdle);
      return;
    }
    videoStreamIndex = videoStream.index;
    logLine(`Found video: ${videoStream.codec}`, "ok");

    if (audioStreams.length === 0) {
      logLine("No audio tracks found — continuing with video only.", "skip");
    }

    const totalSteps = Math.max(1, audioStreams.length + subStreams.length);
    let stepsDone = 0;
    const bump = () => {
      stepsDone++;
      procBar.style.width = Math.round((stepsDone / totalSteps) * 100) + "%";
    };
    const liveProgress = (frac) => {
      const pct = ((stepsDone + frac) / totalSteps) * 100;
      procBar.style.width = Math.min(100, Math.round(pct)) + "%";
    };
    if (currentProgressListener) ffmpeg.off("progress", currentProgressListener);
    currentProgressListener = ({ progress }) => liveProgress(Math.max(0, Math.min(1, progress)));
    ffmpeg.on("progress", currentProgressListener);

    /* ---- audio tracks: one self-contained mp4 per language ---- */
    audioTracks = [];
    for (let i = 0; i < audioStreams.length; i++) {
      const s = audioStreams[i];
      const label = langLabel(s.lang, i);
      procTitle.textContent = `Extracting ${label} audio…`;
      const line = logLine(`${label} audio (${s.codec})…`, "now");
      const outName = `audio_${i}.mp4`;
      const needsTranscode = s.codec !== "aac";
      const args = ["-i", inputName, "-map", `0:${videoStreamIndex}`, "-map", `0:${s.index}`, "-c:v", "copy"];
      if (needsTranscode) {
        args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
      } else {
        args.push("-c:a", "copy");
      }
      args.push("-movflags", "+faststart", outName);
      try {
        await ffmpeg.exec(args);
        const data = await ffmpeg.readFile(outName);
        const url = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
        audioTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url });
        await ffmpeg.deleteFile(outName);
        line.className = "line ok";
        line.textContent = `${label} audio ready` + (needsTranscode ? " (converted to AAC)" : "");
      } catch (err) {
        line.className = "line skip";
        line.textContent = `${label} audio couldn't be processed — skipped`;
      }
      bump();
    }

    /* ---- subtitle tracks: text-based ones become WebVTT ---- */
    subTracks = [];
    for (let i = 0; i < subStreams.length; i++) {
      const s = subStreams[i];
      const label = langLabel(s.lang, i);
      if (BITMAP_SUB_CODECS.has(s.codec)) {
        logLine(`${label} subtitles (${s.codec})`, "skip");
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url: null, supported: false });
        bump();
        continue;
      }
      procTitle.textContent = `Extracting ${label} subtitles…`;
      const line = logLine(`${label} subtitles (${s.codec})…`, "now");
      const outName = `sub_${i}.vtt`;
      try {
        await ffmpeg.exec(["-i", inputName, "-map", `0:${s.index}`, outName]);
        const data = await ffmpeg.readFile(outName);
        const url = URL.createObjectURL(new Blob([data.buffer], { type: "text/vtt" }));
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url, supported: true });
        await ffmpeg.deleteFile(outName);
        line.className = "line ok";
        line.textContent = `${label} subtitles ready`;
      } catch (err) {
        line.className = "line skip";
        line.textContent = `${label} subtitles couldn't be converted — skipped`;
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url: null, supported: false });
      }
      bump();
    }

    try { await ffmpeg.deleteFile(inputName); } catch (e) {}

    if (audioTracks.length === 0) {
      logLine("No usable audio track survived processing.", "skip");
    }

    procTitle.textContent = "Ready";
    procBar.style.width = "100%";
    setTimeout(() => setupPlayer(), 250);
  }

  /* ===================================================================
     PLAYER
     =================================================================== */
  function setupPlayer() {
    showScreen(screenPlayer);

    // pick defaults — prefer a resumed choice, else English, else first
    activeAudioIdx = 0;
    if (audioTracks.length) {
      if (resumeData && resumeData.a != null && audioTracks[resumeData.a]) {
        activeAudioIdx = resumeData.a;
      } else {
        const eng = audioTracks.findIndex((t) => t.lang === "eng");
        if (eng >= 0) activeAudioIdx = eng;
      }
    }
    activeSubIdx = -1;
    if (resumeData && resumeData.s != null && resumeData.s >= 0 && subTracks[resumeData.s] && subTracks[resumeData.s].supported) {
      activeSubIdx = resumeData.s;
    }

    buildTrackSheet();
    loadAudioTrack(activeAudioIdx, resumeData ? resumeData.t : 0, false);
    applySubtitle(activeSubIdx);

    if (resumeData) {
      toast(`Resuming from ${fmtTime(resumeData.t)}`);
    }
  }

  function loadAudioTrack(idx, seekTo, wasPlaying) {
    if (!audioTracks[idx]) return;
    suppressSave = true;
    video.src = audioTracks[idx].url;
    video.load();
    const onMeta = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      if (seekTo && isFinite(seekTo)) {
        video.currentTime = Math.min(seekTo, Math.max(0, (video.duration || seekTo) - 0.5));
      }
      durTimeEl.textContent = fmtTime(video.duration);
      seek.max = String(video.duration || 0);
      if (wasPlaying) video.play().catch(() => {});
      suppressSave = false;
    };
    video.addEventListener("loadedmetadata", onMeta);
  }

  function applySubtitle(idx) {
    // remove existing <track> elements
    Array.from(video.querySelectorAll("track")).forEach((t) => t.remove());
    if (idx >= 0 && subTracks[idx] && subTracks[idx].url) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = subTracks[idx].label;
      track.srclang = subTracks[idx].lang || "und";
      track.src = subTracks[idx].url;
      track.default = true;
      video.appendChild(track);
      // Safari needs the mode set explicitly after the track loads
      track.addEventListener("load", () => { track.track.mode = "showing"; });
      setTimeout(() => { if (track.track) track.track.mode = "showing"; }, 50);
    }
  }

  function buildTrackSheet() {
    audioTrackRow.innerHTML = "";
    if (audioTracks.length === 0) {
      audioTrackRow.innerHTML = '<span class="fineprint">No audio tracks found</span>';
    }
    audioTracks.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "track-pill" + (i === activeAudioIdx ? " active audio-active" : "");
      b.innerHTML = `${t.label}<span class="codec">${t.codec}</span>`;
      b.addEventListener("click", () => selectAudio(i));
      audioTrackRow.appendChild(b);
    });

    subTrackRow.innerHTML = "";
    const offBtn = document.createElement("button");
    offBtn.className = "track-pill" + (activeSubIdx === -1 ? " active sub-active" : "");
    offBtn.textContent = "Off";
    offBtn.addEventListener("click", () => selectSubtitle(-1));
    subTrackRow.appendChild(offBtn);
    subTracks.forEach((t, i) => {
      const b = document.createElement("button");
      const supported = t.supported !== false;
      b.className = "track-pill" + (i === activeSubIdx ? " active sub-active" : "") + (!supported ? " unsupported" : "");
      b.innerHTML = `${t.label}<span class="codec">${t.codec}</span>`;
      if (supported) b.addEventListener("click", () => selectSubtitle(i));
      else b.addEventListener("click", () => toast(`${t.label} subtitles are image-based and can't be read in-browser.`));
      subTrackRow.appendChild(b);
    });

    tracksBtnLabel.textContent = (audioTracks[activeAudioIdx] ? audioTracks[activeAudioIdx].label : "Audio");
  }

  function selectAudio(i) {
    if (i === activeAudioIdx) { closeSheet(); return; }
    const t = video.currentTime;
    const wasPlaying = !video.paused;
    activeAudioIdx = i;
    loadAudioTrack(i, t, wasPlaying);
    buildTrackSheet();
    persist();
    closeSheet();
  }

  function selectSubtitle(i) {
    activeSubIdx = i;
    applySubtitle(i);
    buildTrackSheet();
    persist();
    closeSheet();
  }

  /* ---------------- transport controls ---------------- */
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  playBtn.addEventListener("click", togglePlay);
  playerWrap.addEventListener("click", (e) => {
    if (e.target === video) toggleControls();
  });

  video.addEventListener("play", () => {
    playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
    scheduleAutoHide();
  });
  video.addEventListener("pause", () => {
    playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    showControls();
    persist(true);
  });

  function skip(delta) {
    video.currentTime = Math.max(0, Math.min((video.duration || 1e9), video.currentTime + delta));
    bumpAutoHide();
  }
  backBtn.addEventListener("click", () => skip(-10));
  fwdBtn.addEventListener("click", () => skip(10));

  let seeking = false;
  seek.addEventListener("input", () => { seeking = true; curTimeEl.textContent = fmtTime(parseFloat(seek.value)); });
  seek.addEventListener("change", () => {
    video.currentTime = parseFloat(seek.value);
    seeking = false;
  });

  video.addEventListener("timeupdate", () => {
    if (!seeking) {
      seek.value = String(video.currentTime);
      curTimeEl.textContent = fmtTime(video.currentTime);
    }
    const now = Date.now();
    if (!suppressSave && now - lastSaveAt > 4000) {
      lastSaveAt = now;
      persist();
    }
  });
  video.addEventListener("loadedmetadata", () => { durTimeEl.textContent = fmtTime(video.duration); });

  video.addEventListener("error", () => {
    toast("Safari couldn't play this track — the source codec may be unsupported.");
  });

  /* ---------------- controls auto-hide ---------------- */
  let hideTimer = null;
  function showControls() { controls.classList.remove("hidden"); $("rightRow").style.opacity = "1"; }
  function toggleControls() {
    controls.classList.toggle("hidden");
    bumpAutoHide();
  }
  function scheduleAutoHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!video.paused) controls.classList.add("hidden"); }, 3200);
  }
  function bumpAutoHide() { showControls(); if (!video.paused) scheduleAutoHide(); }
  playerWrap.addEventListener("pointerdown", () => bumpAutoHide());

  /* ---------------- track sheet open/close ---------------- */
  function openSheet() { sheet.classList.add("open"); sheetBackdrop.classList.add("open"); }
  function closeSheet() { sheet.classList.remove("open"); sheetBackdrop.classList.remove("open"); }
  tracksBtn.addEventListener("click", openSheet);
  sheetBackdrop.addEventListener("click", closeSheet);

  /* ---------------- persistence ---------------- */
  function persist(force) {
    if (!currentFile || !video.duration) return;
    saveResume(currentFile, {
      t: video.currentTime,
      a: activeAudioIdx,
      s: activeSubIdx,
      dur: video.duration,
      savedAt: Date.now(),
    });
  }
  window.addEventListener("pagehide", () => persist(true));
  document.addEventListener("visibilitychange", () => { if (document.hidden) persist(true); });

  /* ===================================================================
     FILE PICKING
     =================================================================== */
  function pickFile() { fileInput.click(); }
  chooseBtn.addEventListener("click", pickFile);
  dropZone.addEventListener("click", pickFile);

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) processFile(f);
    fileInput.value = "";
  });

  // drag & drop (mostly for desktop testing; harmless on iPad)
  ["dragover", "dragenter"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); })
  );
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) processFile(f);
  });

  topTag.textContent = "local mkv player";
  showIdleResumeHint();
})();
