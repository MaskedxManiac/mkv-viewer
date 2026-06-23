/* ===================================================================
   Reel — a local-only MKV player
   Everything happens in this tab: the file is read with the File
   API, demuxed/remuxed in-browser with ffmpeg.wasm (WebAssembly,
   no upload, no server), and played with a plain <video> element.
   =================================================================== */

(function () {
  "use strict";

  /* ---------------- DOM refs ---------------- */
  const $ = (id) => document.getElementById(id);

  const screenIdle       = $("screenIdle");
  const screenSelect     = $("screenSelect");
  const screenProcessing = $("screenProcessing");
  const screenPlayer     = $("screenPlayer");

  const dropZone     = $("dropZone");
  const chooseBtn    = $("chooseBtn");
  const fileInput    = $("fileInput");
  const resumeNotice = $("resumeNotice");

  // selection screen
  const selFileName  = $("selFileName");
  const selAudioList = $("selAudioList");
  const selSubList   = $("selSubList");
  const selAudioWarn = $("selAudioWarn");
  const selBackBtn   = $("selBackBtn");
  const selGoBtn     = $("selGoBtn");

  // processing screen
  const procTitle = $("procTitle");
  const procFile  = $("procFile");
  const procBar   = $("procBar");
  const procLog   = $("procLog");

  // player
  const video          = $("video");
  const playerWrap     = $("playerWrap");
  const controls       = $("controls");
  const playBtn        = $("playBtn");
  const playIcon       = $("playIcon");
  const backBtn        = $("backBtn");
  const fwdBtn         = $("fwdBtn");
  const seek           = $("seek");
  const curTimeEl      = $("curTime");
  const durTimeEl      = $("durTime");
  const tracksBtn      = $("tracksBtn");
  const tracksBtnLabel = $("tracksBtnLabel");
  const sheet          = $("sheet");
  const sheetBackdrop  = $("sheetBackdrop");
  const audioTrackRow  = $("audioTrackRow");
  const subTrackRow    = $("subTrackRow");
  const toastEl        = $("toast");
  const topTag         = $("topTag");

  /* ---------------- constants ---------------- */
  const LANG_NAMES = {
    eng:"English", hin:"Hindi", kan:"Kannada", tam:"Tamil", tel:"Telugu",
    mal:"Malayalam", mar:"Marathi", ben:"Bengali", guj:"Gujarati", pan:"Punjabi",
    urd:"Urdu", spa:"Spanish", fre:"French", fra:"French", ger:"German",
    deu:"German", jpn:"Japanese", kor:"Korean", chi:"Chinese", zho:"Chinese",
    rus:"Russian", ara:"Arabic", por:"Portuguese", ita:"Italian", und:"Unknown"
  };
  const langLabel = (code, idx) => {
    if (code && LANG_NAMES[code]) return LANG_NAMES[code];
    if (code && code !== "und") return code.toUpperCase();
    return "Track " + (idx + 1);
  };
  const BITMAP_SUB_CODECS = new Set(["hdmv_pgs_subtitle","dvd_subtitle","dvb_subtitle","xsub"]);

  /* ---------------- helpers ---------------- */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    return `${m}:${String(sec).padStart(2,"0")}`;
  }

  let toastTimer = null;
  function toast(msg, ms = 2800) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  const ALL_SCREENS = [screenIdle, screenSelect, screenProcessing, screenPlayer];
  function showScreen(el) {
    ALL_SCREENS.forEach(s => s.classList.add("hide"));
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

  /* ---------------- resume storage ---------------- */
  const RESUME_PREFIX = "reelmkv:";
  const fingerprint = f => RESUME_PREFIX + f.name + "::" + f.size + "::" + f.lastModified;

  function loadResume(file) {
    try { const r = localStorage.getItem(fingerprint(file)); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }
  function saveResume(file, data) {
    try {
      localStorage.setItem(fingerprint(file), JSON.stringify(data));
      localStorage.setItem(RESUME_PREFIX + "__last", JSON.stringify({ name: file.name, t: data.t }));
    } catch (e) {}
  }
  function showIdleResumeHint() {
    try {
      const raw = localStorage.getItem(RESUME_PREFIX + "__last");
      if (!raw) { resumeNotice.classList.add("hide"); return; }
      const last = JSON.parse(raw);
      resumeNotice.innerHTML = `<span class="resume-pill">Continue "${last.name}" from ${fmtTime(last.t)}</span>`;
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
  let probedStreams = [];          // raw probe results kept for selection screen

  let audioTracks = [];           // [{streamIndex, lang, codec, label, url}]
  let subTracks = [];             // [{streamIndex, lang, codec, label, url, supported}]
  let activeAudioIdx = 0;
  let activeSubIdx = -1;
  let videoStreamIndex = 0;

  let suppressSave = false;
  let lastSaveAt = 0;
  let currentProgressListener = null;

  /* ===================================================================
     FFMPEG INIT
     =================================================================== */
  async function ensureFFmpeg() {
    if (ffmpegLoaded) return;
    const { FFmpeg } = FFmpegWASM;
    ffmpeg = new FFmpeg();
    const base = new URL("vendor/ffmpeg/", document.baseURI).href;
    const coreURL = await FFmpegUtil.toBlobURL(base + "ffmpeg-core.js", "text/javascript");
    const wasmURL = await FFmpegUtil.toBlobURL(base + "ffmpeg-core.wasm", "application/wasm");
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegLoaded = true;
  }

  function parseStreams(logLines) {
    const re = /Stream #0:(\d+)(?:\((\w+)\))?:\s*(Video|Audio|Subtitle):\s*([A-Za-z0-9_]+)/;
    const streams = [];
    for (const line of logLines) {
      const m = line.match(re);
      if (m) streams.push({ index: parseInt(m[1],10), lang: m[2]||null, type: m[3], codec: m[4] });
    }
    return streams;
  }

  async function probeFile(filename) {
    const lines = [];
    const collector = ({ message }) => lines.push(message);
    ffmpeg.on("log", collector);
    try { await ffmpeg.exec(["-hide_banner", "-i", filename]); } catch (e) {}
    ffmpeg.off("log", collector);
    return parseStreams(lines);
  }

  /* ===================================================================
     PHASE 1 — probe and show track selector (or skip if trivial)
     =================================================================== */
  async function startWithFile(file) {
    currentFile = file;
    resumeData = loadResume(file);

    // show processing screen just for the engine-load + probe phase
    showScreen(screenProcessing);
    procLog.innerHTML = "";
    procBar.style.width = "0%";
    procFile.textContent = file.name + "  ·  " + (file.size / (1024*1024)).toFixed(0) + " MB";
    procTitle.textContent = "Loading engine…";

    const engLine = logLine("Loading the in-browser conversion engine…", "now");
    await ensureFFmpeg();
    engLine.className = "line ok";
    engLine.textContent = "Conversion engine ready";

    procTitle.textContent = "Reading file structure…";
    procBar.style.width = "15%";

    await ffmpeg.writeFile("input.mkv", await FFmpegUtil.fetchFile(file));
    probedStreams = await probeFile("input.mkv");

    procBar.style.width = "30%";

    const videoStream = probedStreams.find(s => s.type === "Video");
    if (!videoStream) {
      logLine("No video track found — is this really a video file?", "skip");
      setTimeout(() => showScreen(screenIdle), 1800);
      return;
    }
    videoStreamIndex = videoStream.index;

    const audioStreams = probedStreams.filter(s => s.type === "Audio");
    const subStreams   = probedStreams.filter(s => s.type === "Subtitle");

    // If only 1 audio and ≤1 subtitle tracks — nothing to choose, skip selector
    if (audioStreams.length <= 1 && subStreams.length <= 1) {
      await extractAndPlay(audioStreams, subStreams);
      return;
    }

    // Otherwise show the selection screen
    buildSelectionScreen(file, audioStreams, subStreams);
    showScreen(screenSelect);
  }

  /* ===================================================================
     SELECTION SCREEN
     =================================================================== */
  // track which indices are checked; keyed by stream index
  let selAudioChecked = new Set();
  let selSubChecked   = new Set();

  function buildSelectionScreen(file, audioStreams, subStreams) {
    selFileName.textContent = file.name + "  ·  " + (file.size/(1024*1024)).toFixed(0) + " MB";

    // default: all audio tracks checked, all subtitle tracks checked
    selAudioChecked = new Set(audioStreams.map(s => s.index));
    selSubChecked   = new Set(subStreams.map(s => s.index));

    renderSelList(selAudioList, audioStreams, selAudioChecked, "audio");
    if (subStreams.length === 0) {
      $("selSubGroup").classList.add("hide");
    } else {
      $("selSubGroup").classList.remove("hide");
      renderSelList(selSubList, subStreams, selSubChecked, "sub");
    }
    selAudioWarn.classList.remove("show");
    selGoBtn.disabled = false;
  }

  function renderSelList(container, streams, checkedSet, kind) {
    container.innerHTML = "";
    streams.forEach((s, i) => {
      const label = langLabel(s.lang, i);
      const isBitmap = BITMAP_SUB_CODECS.has(s.codec);
      const row = document.createElement("div");
      row.className = "sel-row" + (checkedSet.has(s.index) ? ` checked-${kind}` : "");
      row.dataset.idx = s.index;
      row.innerHTML = `
        <div class="sel-check">
          <svg viewBox="0 0 12 10" fill="none" stroke="${kind==="audio"?"#1A1303":"#F2EDE3"}" stroke-width="2">
            <polyline points="1,5 4.5,8.5 11,1"/>
          </svg>
        </div>
        <div class="sel-meta">
          <div class="sel-name">${label}</div>
          <div class="sel-codec">${s.codec}${isBitmap ? " · image-based subtitles (will be skipped)" : ""}</div>
        </div>
        <div class="sel-badge">${s.lang ? s.lang.toUpperCase() : "?"}</div>
      `;
      // bitmap subs can't be extracted — show as uncheckable
      if (isBitmap) {
        row.style.opacity = "0.4";
        row.style.cursor = "default";
        checkedSet.delete(s.index);
        row.classList.remove(`checked-${kind}`);
      } else {
        row.addEventListener("click", () => toggleSelRow(row, s.index, checkedSet, kind));
      }
      container.appendChild(row);
    });
  }

  function toggleSelRow(row, streamIdx, checkedSet, kind) {
    if (checkedSet.has(streamIdx)) {
      checkedSet.delete(streamIdx);
      row.classList.remove(`checked-${kind}`);
    } else {
      checkedSet.add(streamIdx);
      row.classList.add(`checked-${kind}`);
    }
    // validate: at least 1 audio
    if (kind === "audio") {
      const valid = selAudioChecked.size > 0;
      selAudioWarn.classList.toggle("show", !valid);
      selGoBtn.disabled = !valid;
    }
  }

  selBackBtn.addEventListener("click", () => {
    // clean up the written file so memory is freed
    if (ffmpeg && ffmpegLoaded) {
      ffmpeg.deleteFile("input.mkv").catch(() => {});
    }
    showScreen(screenIdle);
  });

  selGoBtn.addEventListener("click", async () => {
    if (selAudioChecked.size === 0) {
      selAudioWarn.classList.add("show");
      return;
    }
    const allAudio = probedStreams.filter(s => s.type === "Audio");
    const allSub   = probedStreams.filter(s => s.type === "Subtitle");
    const chosenAudio = allAudio.filter(s => selAudioChecked.has(s.index));
    const chosenSub   = allSub.filter(s => selSubChecked.has(s.index));
    await extractAndPlay(chosenAudio, chosenSub);
  });

  /* ===================================================================
     PHASE 2 — extract chosen tracks then play
     =================================================================== */
  async function extractAndPlay(audioStreams, subStreams) {
    showScreen(screenProcessing);
    procLog.innerHTML = "";
    procBar.style.width = "30%";  // probe already done
    procFile.textContent = currentFile.name + "  ·  " + (currentFile.size/(1024*1024)).toFixed(0) + " MB";
    procTitle.textContent = "Extracting tracks…";

    const totalSteps = Math.max(1, audioStreams.length + subStreams.length);
    let stepsDone = 0;
    const basePct = 30;

    const liveProgress = (frac) => {
      const pct = basePct + ((stepsDone + Math.max(0, Math.min(1, frac))) / totalSteps) * (100 - basePct);
      procBar.style.width = Math.round(pct) + "%";
    };
    if (currentProgressListener) ffmpeg.off("progress", currentProgressListener);
    currentProgressListener = ({ progress }) => liveProgress(progress);
    ffmpeg.on("progress", currentProgressListener);

    /* ---- audio tracks ---- */
    audioTracks = [];
    for (let i = 0; i < audioStreams.length; i++) {
      const s = audioStreams[i];
      const label = langLabel(s.lang, i);
      procTitle.textContent = `Extracting ${label} audio…`;
      const line = logLine(`${label} audio (${s.codec})…`, "now");
      const outName = `audio_${i}.mp4`;
      const needsTranscode = s.codec !== "aac";
      const args = [
        "-i", "input.mkv",
        "-map", `0:${videoStreamIndex}`,
        "-map", `0:${s.index}`,
        "-c:v", "copy",
        ...(needsTranscode ? ["-c:a", "aac", "-b:a", "192k", "-ac", "2"] : ["-c:a", "copy"]),
        "-movflags", "+faststart", outName
      ];
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
        line.textContent = `${label} audio — couldn't be processed, skipped`;
      }
      stepsDone++;
      liveProgress(0);
    }

    /* ---- subtitle tracks ---- */
    subTracks = [];
    for (let i = 0; i < subStreams.length; i++) {
      const s = subStreams[i];
      const label = langLabel(s.lang, i);
      if (BITMAP_SUB_CODECS.has(s.codec)) {
        logLine(`${label} subtitles (${s.codec}) — image-based, skipped`, "skip");
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url: null, supported: false });
        stepsDone++;
        liveProgress(0);
        continue;
      }
      procTitle.textContent = `Extracting ${label} subtitles…`;
      const line = logLine(`${label} subtitles (${s.codec})…`, "now");
      const outName = `sub_${i}.vtt`;
      try {
        await ffmpeg.exec(["-i", "input.mkv", "-map", `0:${s.index}`, outName]);
        const data = await ffmpeg.readFile(outName);
        const url = URL.createObjectURL(new Blob([data.buffer], { type: "text/vtt" }));
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url, supported: true });
        await ffmpeg.deleteFile(outName);
        line.className = "line ok";
        line.textContent = `${label} subtitles ready`;
      } catch (err) {
        line.className = "line skip";
        line.textContent = `${label} subtitles — couldn't convert, skipped`;
        subTracks.push({ streamIndex: s.index, lang: s.lang, codec: s.codec, label, url: null, supported: false });
      }
      stepsDone++;
      liveProgress(0);
    }

    try { await ffmpeg.deleteFile("input.mkv"); } catch (e) {}
    if (currentProgressListener) { ffmpeg.off("progress", currentProgressListener); currentProgressListener = null; }

    if (audioTracks.length === 0) {
      logLine("No usable audio track — check the original file.", "skip");
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

    // pick default audio: resume choice → English → first
    activeAudioIdx = 0;
    if (audioTracks.length) {
      if (resumeData && resumeData.a != null && audioTracks[resumeData.a]) {
        activeAudioIdx = resumeData.a;
      } else {
        const eng = audioTracks.findIndex(t => t.lang === "eng");
        if (eng >= 0) activeAudioIdx = eng;
      }
    }
    // pick default subtitle
    activeSubIdx = -1;
    if (resumeData && resumeData.s != null && resumeData.s >= 0
        && subTracks[resumeData.s] && subTracks[resumeData.s].supported) {
      activeSubIdx = resumeData.s;
    }

    buildTrackSheet();
    loadAudioTrack(activeAudioIdx, resumeData ? resumeData.t : 0, false);
    applySubtitle(activeSubIdx);

    if (resumeData) toast(`Resuming from ${fmtTime(resumeData.t)}`);
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
    Array.from(video.querySelectorAll("track")).forEach(t => t.remove());
    if (idx >= 0 && subTracks[idx] && subTracks[idx].url) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = subTracks[idx].label;
      track.srclang = subTracks[idx].lang || "und";
      track.src = subTracks[idx].url;
      track.default = true;
      video.appendChild(track);
      track.addEventListener("load", () => { track.track.mode = "showing"; });
      setTimeout(() => { if (track.track) track.track.mode = "showing"; }, 50);
    }
  }

  function buildTrackSheet() {
    audioTrackRow.innerHTML = "";
    if (audioTracks.length === 0) {
      audioTrackRow.innerHTML = '<span class="fineprint">No audio tracks</span>';
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
      const ok = t.supported !== false;
      b.className = "track-pill" + (i === activeSubIdx ? " active sub-active" : "") + (!ok ? " unsupported" : "");
      b.innerHTML = `${t.label}<span class="codec">${t.codec}</span>`;
      b.addEventListener("click", ok
        ? () => selectSubtitle(i)
        : () => toast(`${t.label} subtitles are image-based and can't be shown.`));
      subTrackRow.appendChild(b);
    });

    tracksBtnLabel.textContent = audioTracks[activeAudioIdx] ? audioTracks[activeAudioIdx].label : "Audio";
  }

  function selectAudio(i) {
    if (i === activeAudioIdx) { closeSheet(); return; }
    const t = video.currentTime, playing = !video.paused;
    activeAudioIdx = i;
    loadAudioTrack(i, t, playing);
    buildTrackSheet(); persist(); closeSheet();
  }
  function selectSubtitle(i) {
    activeSubIdx = i;
    applySubtitle(i);
    buildTrackSheet(); persist(); closeSheet();
  }

  /* ---------------- playback controls ---------------- */
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  playBtn.addEventListener("click", togglePlay);
  playerWrap.addEventListener("click", e => { if (e.target === video) toggleControls(); });

  video.addEventListener("play", () => {
    playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
    scheduleAutoHide();
  });
  video.addEventListener("pause", () => {
    playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    showControls(); persist(true);
  });

  function skip(delta) {
    video.currentTime = Math.max(0, Math.min(video.duration || 1e9, video.currentTime + delta));
    bumpAutoHide();
  }
  backBtn.addEventListener("click", () => skip(-10));
  fwdBtn.addEventListener("click", () => skip(10));

  let seeking = false;
  seek.addEventListener("input", () => { seeking = true; curTimeEl.textContent = fmtTime(parseFloat(seek.value)); });
  seek.addEventListener("change", () => { video.currentTime = parseFloat(seek.value); seeking = false; });

  video.addEventListener("timeupdate", () => {
    if (!seeking) { seek.value = String(video.currentTime); curTimeEl.textContent = fmtTime(video.currentTime); }
    const now = Date.now();
    if (!suppressSave && now - lastSaveAt > 4000) { lastSaveAt = now; persist(); }
  });
  video.addEventListener("loadedmetadata", () => { durTimeEl.textContent = fmtTime(video.duration); });
  video.addEventListener("error", () => toast("Safari couldn't play this track — codec may be unsupported."));

  /* ---------------- controls auto-hide ---------------- */
  let hideTimer = null;
  function showControls() { controls.classList.remove("hidden"); $("rightRow").style.opacity = "1"; }
  function toggleControls() { controls.classList.toggle("hidden"); bumpAutoHide(); }
  function scheduleAutoHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!video.paused) controls.classList.add("hidden"); }, 3200);
  }
  function bumpAutoHide() { showControls(); if (!video.paused) scheduleAutoHide(); }
  playerWrap.addEventListener("pointerdown", () => bumpAutoHide());

  /* ---------------- sheet ---------------- */
  function openSheet()  { sheet.classList.add("open"); sheetBackdrop.classList.add("open"); }
  function closeSheet() { sheet.classList.remove("open"); sheetBackdrop.classList.remove("open"); }
  tracksBtn.addEventListener("click", openSheet);
  sheetBackdrop.addEventListener("click", closeSheet);

  /* ---------------- persistence ---------------- */
  function persist() {
    if (!currentFile || !video.duration) return;
    saveResume(currentFile, { t: video.currentTime, a: activeAudioIdx, s: activeSubIdx, dur: video.duration });
  }
  window.addEventListener("pagehide", () => persist());
  document.addEventListener("visibilitychange", () => { if (document.hidden) persist(); });

  /* ===================================================================
     FILE PICKING
     =================================================================== */
  function pickFile() { fileInput.click(); }
  chooseBtn.addEventListener("click", pickFile);
  dropZone.addEventListener("click", pickFile);

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) startWithFile(f);
    fileInput.value = "";
  });

  ["dragover","dragenter"].forEach(evt =>
    dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add("drag-over"); }));
  ["dragleave","drop"].forEach(evt =>
    dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove("drag-over"); }));
  dropZone.addEventListener("drop", e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startWithFile(f);
  });

  /* init */
  topTag.textContent = "local mkv player";
  showIdleResumeHint();

})();
