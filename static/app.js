(() => {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────
  let currentFileId = null;
  let currentOrigName = null;
  let inPoint = 0;
  let outPoint = 0;
  let clipIndex = 1;
  let rafId = null;
  let clipQueue = []; // [{start, end, filename, color, file_id, loading?}]
  let selectedQueueIdx = null; // index of clip being re-edited, or null
  let allFiles = []; // full folder file list in server order
  const checkedFileIds = new Set(); // IDs checked in folder browser
  const fileOrigNames = new Map(); // Drive file_id → original Drive filename
  const _loadedFileIds = new Set(); // all server-resident file_ids (unloaded only on full reset)
  let _batchMode = false; // true when loading via "Load Selected"
  let keyframeTimes = []; // keyframe timestamps for the current file (from ffprobe)
  let _draggedQueueIdx = null; // index of queue item being dragged onto the timeline
  let _tlDragOverTime  = null; // current timeline drop position (seconds) while dragging
  let _waveData        = null; // Float32Array of resampled mono samples for current file
  let _waveFileId      = null; // file_id the _waveData belongs to

  // ── JKL shuttle state ───────────────────────────────────────────────────────
  let _jklSpeed      = 0;    // 0 = paused, positive = forward playbackRate
  // Scrub state is declared in the JKL shuttle section below
  const _JKL_FRAME   = 1 / 30; // seconds per single-tap j step (~1 frame @ 30fps)
  const MIN_CLIP_GAP  = 5 / 30; // minimum clip length: 5 frames @ 30fps

  // ── WebCodecs state ──────────────────────────────────────────────────────────
  let _wcReady     = false; // true when WCReverse.init succeeded for current file
  let _wcScrubTime = 0;     // last PTS reported by WCReverse.startReverse onStep

  const CLIP_COLORS = [
    "rgba(79,142,247,0.35)",   // blue
    "rgba(247,140,54,0.35)",   // orange
    "rgba(167,100,247,0.35)",  // purple
    "rgba(54,200,170,0.35)",   // teal
    "rgba(247,90,140,0.35)",   // pink
    "rgba(220,200,60,0.35)",   // yellow
  ];

  const FOLDER_KEY        = "cliptrimmer_folder_url";
  const OUTPUT_FOLDER_KEY = "cliptrimmer_output_folder";
  const GROUP_TAG_KEY     = "cliptrimmer_group_tag";

  // ── Elements ───────────────────────────────────────────────────────────────
  const authLabel        = document.getElementById("auth-label");
  const authBtn          = document.getElementById("auth-btn");
  const folderUrlInput   = document.getElementById("folder-url");
  const browseBtn        = document.getElementById("browse-btn");
  const folderError      = document.getElementById("folder-error");
  const fileListWrap     = document.getElementById("file-list-wrap");
  const fileList         = document.getElementById("file-list");
  const fileCount        = document.getElementById("file-count");
  const refreshBtn       = document.getElementById("refresh-btn");
  const driveUrl         = document.getElementById("drive-url");
  const loadBtn          = document.getElementById("load-btn");
  const loadError        = document.getElementById("load-error");
  const loadPanel        = document.getElementById("load-panel");
  const spinnerPanel     = document.getElementById("spinner-panel");
  const spinnerLabel     = document.getElementById("spinner-label");
  const editorPanel      = document.getElementById("editor-panel");
  const player           = document.getElementById("player");
  const videoFilename    = document.getElementById("video-filename");
  const inTimeInput      = document.getElementById("in-time");
  const outTimeInput     = document.getElementById("out-time");
  const setInBtn         = document.getElementById("set-in-btn");
  const setOutBtn        = document.getElementById("set-out-btn");
  const trimRangeDisplay = document.getElementById("trim-range-display");
  const outFilenameInput = document.getElementById("out-filename");
  const trimError        = document.getElementById("trim-error");
  const trimBtn          = document.getElementById("trim-btn");
  const resetBtn         = document.getElementById("reset-btn");
  const successToast     = document.getElementById("success-toast");
  const timeline         = document.getElementById("timeline");
  const ctx              = timeline.getContext("2d");
  const waveCanvas       = document.getElementById("waveform");
  const waveCtx          = waveCanvas ? waveCanvas.getContext("2d") : null;
  const playPauseBtn     = document.getElementById("play-pause-btn");
  const muteBtn          = document.getElementById("mute-btn");
  const fullscreenBtn    = document.getElementById("fullscreen-btn");
  const gearBtn          = document.getElementById("gear-btn");
  const hotkeysPanel     = document.getElementById("hotkeys-panel");
  const bufferBarWrap    = document.getElementById("buffer-bar-wrap");
  const bufferFill       = document.getElementById("buffer-fill");
  const bufferLabel      = document.getElementById("buffer-label");
  const addQueueBtn      = document.getElementById("add-queue-btn");
  const splitBtn         = document.getElementById("split-btn");
  const uploadQueueBtn   = document.getElementById("upload-queue-btn");
  const clearQueueBtn    = document.getElementById("clear-queue-btn");
  const queueSection     = document.getElementById("queue-section");
  const queueList        = document.getElementById("queue-list");
  const queueCount       = document.getElementById("queue-count");
  const queueProgress    = document.getElementById("queue-progress");
  const queueFill        = document.getElementById("queue-fill");
  const queueLabel       = document.getElementById("queue-label");
  const outputFolderInput = document.getElementById("output-folder-url");
  const groupTagInput     = document.getElementById("group-tag");
  const reloadBtn         = document.getElementById("reload-btn");
  const frameBackBtn      = document.getElementById("frame-back-btn");
  const frameFwdBtn       = document.getElementById("frame-fwd-btn");
  const logPanel          = document.getElementById("log-panel");
  const logList           = document.getElementById("log-list");
  const scrubCanvas       = document.getElementById("scrub-canvas");
  const logToggleBtn      = document.getElementById("log-toggle-btn");
  const logClearBtn       = document.getElementById("log-clear-btn");
  const logCopyBtn        = document.getElementById("log-copy-btn");
  const logBadge          = document.getElementById("log-badge");
  const loadSelectedBtn   = document.getElementById("load-selected-btn");
  const selectAllCb       = document.getElementById("select-all-cb");

  // ── Helpers ────────────────────────────────────────────────────────────────

  function show(el)  { el.classList.remove("hidden"); }
  function hide(el)  { el.classList.add("hidden"); }
  function showError(el, msg) { el.textContent = msg; show(el); }
  function clearError(el) { hide(el); el.textContent = ""; }

  function fmtTime(secs) {
    if (isNaN(secs) || secs < 0) return "0:00.000";
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(3).padStart(6, "0");
    return `${m}:${s}`;
  }

  function parseTime(str) {
    str = str.trim();
    const parts = str.split(":");
    if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(str);
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    const mb = bytes / (1024 * 1024);
    return mb < 1000 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
  }

  function updateRangeDisplay() {
    const dur = isNaN(player.duration) ? 0 : player.duration;
    const len = (outPoint - inPoint).toFixed(3);
    trimRangeDisplay.textContent =
      `Trim: ${fmtTime(inPoint)} → ${fmtTime(outPoint)}  (${len}s of ${fmtTime(dur)})`;
  }

  function defaultClipName(origName, index) {
    const tag = groupTagInput.value.trim();
    const ext = origName.match(/\.[^.]+$/)?.[0] ?? ".mp4";
    if (tag) {
      return `${tag}_${String(index).padStart(2, "0")}${ext}`;
    }
    const stem = origName.slice(0, origName.length - ext.length);
    return `${stem}_clip${String(index).padStart(2, "0")}${ext}`;
  }

  // ── Error log ─────────────────────────────────────────────────────────────

  let _logErrorCount = 0;
  function logAppend(level, msg) {
    const levels = { INFO: "log", WARN: "warn", ERROR: "error" };
    console[levels[level] || "log"](`[cliptrimmer ${level}] ${msg}`);
    const li = document.createElement("li");
    li.className = `log-entry log-${level.toLowerCase()}`;
    li.textContent = `${new Date().toLocaleTimeString()} [${level}] ${msg}`;
    logList.appendChild(li);
    logList.scrollTop = logList.scrollHeight;
    if (level === "ERROR") {
      _logErrorCount++;
      logBadge.textContent = _logErrorCount;
      logBadge.classList.remove("hidden");
      logPanel.classList.add("log-panel-open");
    }
  }

  let toastTimer = null;
  function showToast(msg, url) {
    successToast.innerHTML = `${msg} &nbsp;<a href="${url}" target="_blank" rel="noopener">Open in Drive ↗</a>`;
    successToast.className = "";
    show(successToast);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(successToast), 6000);
  }
  function showWarnToast(msg) {
    successToast.textContent = msg;
    successToast.className = "toast-warn";
    show(successToast);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { hide(successToast); successToast.className = ""; }, 4000);
  }

  // ── Custom player controls ──────────────────────────────────────────────────

  const DEFAULT_HOTKEYS = {
    playPause:  " ",
    mute:       "m",
    fullscreen: "f",
    setIn:      "i",
    setOut:     "o",
    split:      "s",
    seekBack:   "ArrowLeft",
    seekFwd:    "ArrowRight",
  };
  const HOTKEY_LABELS = {
    playPause:  "Play / Pause",
    mute:       "Mute / Unmute",
    fullscreen: "Fullscreen",
    setIn:      "Set In point",
    setOut:     "Set Out point",
    split:      "Split at playhead",
    seekBack:   "Seek back 5s",
    seekFwd:    "Seek forward 5s",
  };
  const HOTKEYS_KEY = "cliptrimmer_hotkeys";
  let hotkeys = { ...DEFAULT_HOTKEYS, ...JSON.parse(localStorage.getItem(HOTKEYS_KEY) || "{}") };

  function togglePlay() {
    if (player.paused) {
      player.play().catch(err => { if (err.name !== "AbortError") { logAppend("ERROR", `play() failed: ${err.name} — ${err.message}`); } });
    } else {
      player.pause();
    }
  }
  function toggleMute() { player.muted = !player.muted; }
  function toggleFullscreen() {
    if (!document.fullscreenElement) player.requestFullscreen();
    else document.exitFullscreen();
  }

  playPauseBtn.addEventListener("click", togglePlay);
  muteBtn.addEventListener("click", toggleMute);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  player.addEventListener("click", togglePlay);

  player.addEventListener("play",    () => { playPauseBtn.textContent = "\u23F8"; _decodeRecoveries = 0; scrubCanvas.style.display = "none"; });
  player.addEventListener("pause",   () => {
    playPauseBtn.textContent = "\u25B6";
    _jklStopScrub();
    _jklSpeed = 0;
  });
  player.addEventListener("seeked", () => {
    if (!_playerResetting) _decodeRecoveries = 0;
    _isSeeking = false;
    // Dispatch the latest scrub position that queued up while we were seeking
    if (dragTarget === "seek" && _pendingScrubTime !== null) {
      _isSeeking = true;
      player.currentTime = _pendingScrubTime;
      _pendingScrubTime = null;
    }
  });
  let _stallTimer = null;
  let _playerResetting = false; // true while we're intentionally clearing the player src
  let _decodeRecoveries = 0;    // consecutive DECODE recovery attempts (reset on successful play)
  function armStallTimer() {
    clearTimeout(_stallTimer);
    if (_playerResetting || player.paused) return;
    _stallTimer = setTimeout(() => {
      if (_playerResetting || player.paused || !currentFileId) return;
      if (player.readyState < 3) { // HAVE_FUTURE_DATA — still buffering
        logAppend("WARN", `Stall timeout — reloading stream at ${player.currentTime.toFixed(2)}s`);
        showWarnToast("\u23F3 Buffering stalled — reloading\u2026");
        const resumeAt = player.currentTime;
        _playerResetting = true;
        player.removeAttribute("src");
        player.load();
        player.src = `/api/video/${currentFileId}`;
        player.addEventListener("canplay", () => {
          player.currentTime = resumeAt;
          player.addEventListener("seeked", () => {
            _playerResetting = false;
            player.play().catch(() => {});
          }, { once: true });
        }, { once: true });
      }
    }, 5000);
  }

  player.addEventListener("waiting", () => {
    playPauseBtn.textContent = "\u23F8";
    armStallTimer();
  });
  player.addEventListener("playing", () => { clearTimeout(_stallTimer); });
  player.addEventListener("stalled", () => {
    if (_playerResetting) return;
    logAppend("WARN", `Video stalled at ${player.currentTime.toFixed(2)}s (readyState=${player.readyState})`);
    armStallTimer();
  });
  player.addEventListener("canplay", () => { clearTimeout(_stallTimer); playPauseBtn.textContent = player.paused ? "\u25B6" : "\u23F8"; });
  player.addEventListener("error",   () => {
    if (_playerResetting) return; // intentional src clear — not a real error
    clearTimeout(_stallTimer);
    const code = player.error?.code;
    const codeNames = { 1:"ABORTED", 2:"NETWORK", 3:"DECODE", 4:"SRC_NOT_SUPPORTED" };

    // DECODE errors during seek-scrub are spurious (Chromium fails on non-keyframe seeks).
    // Reload silently at the same position — don't skip forward, don't toast, don't cancel drag.
    if (code === 3 && dragTarget === "seek" && currentFileId) {
      // DECODE errors on non-keyframe seeks are normal in Chromium — don't reload.
      // Just clear the in-flight flag and dispatch the next pending scrub position.
      logAppend("WARN", `DECODE during scrub at ${player.currentTime.toFixed(2)}s — skipping to next position`);
      _isSeeking = false;
      if (_pendingScrubTime !== null) {
        _isSeeking = true;
        player.currentTime = _pendingScrubTime;
        _pendingScrubTime = null;
      }
      return;
    }

    dragTarget = null; // cancel any active timeline drag
    playPauseBtn.textContent = "\u25B6";
    logAppend("ERROR", `Player error ${code} (${codeNames[code] || "?"}): ${player.error?.message || "unknown"}`);
    // Auto-recover from DECODE errors: reload stream and skip 0.5s past the bad packet.
    // Cap at 3 consecutive attempts; if still failing, skip 2s forward and give up.
    if (code === 3 && currentFileId) {
      _decodeRecoveries++;
      if (_decodeRecoveries > 3) {
        logAppend("ERROR", `DECODE recovery gave up after 3 attempts — skipping 2s forward`);
        showWarnToast("\u26A0\uFE0F Unrecoverable decode error — skipping ahead");
        _decodeRecoveries = 0;
        player.currentTime = Math.min((player.duration || 0), player.currentTime + 2);
        return;
      }
      const skipTo = Math.min((player.duration || 0), player.currentTime + 0.5);
      const wasP = !player.paused;
      _playerResetting = true;
      // Safety: force-clear _playerResetting after 5s if seeked event never fires
      const resetSafety = setTimeout(() => { _playerResetting = false; }, 5000);
      player.removeAttribute("src");
      player.load();
      player.src = `/api/video/${currentFileId}`;
      // Hold _playerResetting true through the seek so errors during seek are suppressed.
      player.addEventListener("canplay", () => {
        player.currentTime = skipTo;
        player.addEventListener("seeked", () => {
          clearTimeout(resetSafety);
          _playerResetting = false;
          if (wasP) player.play().catch(() => {});
        }, { once: true });
      }, { once: true });
      logAppend("INFO", `DECODE auto-recovery #${_decodeRecoveries}: seeking to ${skipTo.toFixed(2)}s`);
      showWarnToast("\u26A0\uFE0F Decoder error — reloading video…");
    }
  });
  player.addEventListener("volumechange", () => {
    muteBtn.textContent = (player.muted || player.volume === 0) ? "\uD83D\uDD07" : "\uD83D\uDD0A";
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement ? "\u2715" : "\u26F6";
  });

  logToggleBtn.addEventListener("click", () => {
    logPanel.classList.toggle("log-panel-open");
    _logErrorCount = 0;
    logBadge.classList.add("hidden");
    logBadge.textContent = "0";
  });
  logClearBtn.addEventListener("click", () => { logList.innerHTML = ""; _logErrorCount = 0; logBadge.classList.add("hidden"); });
  logCopyBtn.addEventListener("click", () => {
    const text = [...logList.querySelectorAll("li")].map(li => li.textContent).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  });

  // Gear: toggle hotkeys panel
  gearBtn.addEventListener("click", () => {
    hotkeysPanel.classList.toggle("hidden");
    if (!hotkeysPanel.classList.contains("hidden")) renderHotkeysPanel();
  });

  function displayKey(key) { return key === " " ? "Space" : key; }

  function renderHotkeysPanel() {
    const grid = hotkeysPanel.querySelector(".hotkeys-grid");
    grid.innerHTML = "";
    for (const [action, label] of Object.entries(HOTKEY_LABELS)) {
      const lbl = document.createElement("span");
      lbl.className = "hk-label";
      lbl.textContent = label;
      const inp = document.createElement("input");
      inp.className = "hk-input";
      inp.type = "text";
      inp.readOnly = true;
      inp.dataset.action = action;
      inp.value = displayKey(hotkeys[action]);
      inp.addEventListener("keydown", (e) => {
        e.preventDefault();
        hotkeys[action] = e.key;
        inp.value = displayKey(e.key);
        localStorage.setItem(HOTKEYS_KEY, JSON.stringify(hotkeys));
        inp.blur();
      });
      inp.addEventListener("click", () => {
        inp.readOnly = false;
        inp.value = "";
        inp.placeholder = "Press a key…";
        inp.focus();
      });
      inp.addEventListener("blur", () => {
        inp.readOnly = true;
        inp.value = displayKey(hotkeys[action]);
        inp.placeholder = "";
      });
      grid.appendChild(lbl);
      grid.appendChild(inp);
    }
  }

  // ── Keyframe helpers ──────────────────────────────────────────────────────

  async function fetchKeyframes(fileId) {
    try {
      const r = await fetch(`/api/keyframes/${fileId}`);
      if (!r.ok) return;
      const d = await r.json();
      keyframeTimes = (d.keyframes || []).sort((a, b) => a - b);
    } catch (_) { /* non-fatal */ }
  }

  // Returns the largest keyframe time <= t, or null if none.
  function snapToKeyframe(t) {
    if (!keyframeTimes.length) return null;
    let lo = 0, hi = keyframeTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keyframeTimes[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return keyframeTimes[lo] <= t ? keyframeTimes[lo] : null;
  }

  // Returns the index of the largest keyframe <= t (-1 if none).
  function _kfIndexAt(t) {
    if (!keyframeTimes.length) return -1;
    let lo = 0, hi = keyframeTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keyframeTimes[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return keyframeTimes[lo] <= t ? lo : -1;
  }

  // ── JKL shuttle ───────────────────────────────────────────────────────────
  //
  // Backward scrub design:
  //   - Every seek target is a known keyframe (I-frame), so no DECODE errors.
  //   - Seeks are paced with a minimum interval that shrinks the longer J is held,
  //     giving a "ramp up" feel: slow at first, faster after ~1s of holding.
  //   - Both conditions must be true before the next seek fires:
  //       (1) previous seek has completed ("seeked" event)
  //       (2) minimum interval has elapsed (setTimeout)
  //   - This prevents seek queuing (the browser discards intermediate seeks if
  //     you assign currentTime repeatedly before the previous seek lands).

  const _SCRUB_INTERVAL_START = 350; // ms between steps when first holding J
  const _SCRUB_INTERVAL_MIN   =  80; // ms at full ramp speed (after ~1.5s hold)
  const _SCRUB_RAMP_TIME      = 1500; // ms to go from start → min interval

  let _jklScrubbing    = false;
  let _jklScrubFn      = null;  // seeked listener
  let _jklScrubTimer   = null;  // setTimeout handle
  let _jklScrubHoldMs  = 0;     // how long J has been held (ms)
  let _jklScrubHoldT0  = 0;     // Date.now() when J-hold started
  let _jklScrubReady   = false; // timer has elapsed (waiting for seek to complete)
  let _jklScrubDone    = false; // seek has completed (waiting for timer)

  // ── L-hold forward speed ramp ─────────────────────────────────────────────
  let _lHoldRampTimer = null;
  function _lStartHoldRamp() {
    clearTimeout(_lHoldRampTimer);
    let elapsed = 0;
    const step = () => {
      if (_jklSpeed <= 0) return;
      _jklSet(Math.min(_jklSpeed + 1, 8));
      elapsed += 400;
      if (_jklSpeed < 8) {
        _lHoldRampTimer = setTimeout(step, Math.max(150, 600 - elapsed));
      }
    };
    _lHoldRampTimer = setTimeout(step, 700);
  }
  function _lStopHoldRamp() {
    clearTimeout(_lHoldRampTimer);
    _lHoldRampTimer = null;
  }

  // Called when BOTH the interval timer and the seeked event have fired.
  function _jklScrubMaybeStep() {
    if (!_jklScrubbing || !_jklScrubReady || !_jklScrubDone) return;
    _jklScrubReady = false;
    _jklScrubDone  = false;
    if (player.currentTime <= 0) { _jklStopScrub(); return; }

    // Find target: keyframe strictly before current position
    let target;
    if (keyframeTimes.length) {
      const idx = _kfIndexAt(player.currentTime - 0.001);
      target = idx > 0 ? keyframeTimes[idx - 1] : 0;
    } else {
      target = Math.max(0, player.currentTime - _JKL_FRAME);
    }

    if (target <= 0) { player.currentTime = 0; _jklStopScrub(); return; }

    // Schedule the next interval (ramps from START→MIN over _SCRUB_RAMP_TIME)
    _jklScrubHoldMs = Date.now() - _jklScrubHoldT0;
    const t = Math.min(_jklScrubHoldMs / _SCRUB_RAMP_TIME, 1);
    const interval = Math.round(_SCRUB_INTERVAL_START + (_SCRUB_INTERVAL_MIN - _SCRUB_INTERVAL_START) * t);
    _jklScrubTimer = setTimeout(() => {
      _jklScrubTimer  = null;
      _jklScrubReady  = true;
      _jklScrubMaybeStep();
    }, interval);

    // Issue the seek — _jklScrubFn (seeked handler) will set _jklScrubDone
    player.currentTime = target;
  }

  // Stop backward scrub — detach listener, cancel timer, clear all state.
  function _jklStopScrub() {
    if (_jklScrubFn !== null) {
      player.removeEventListener("seeked", _jklScrubFn);
      _jklScrubFn = null;
    }
    if (_jklScrubTimer !== null) {
      clearTimeout(_jklScrubTimer);
      _jklScrubTimer = null;
    }
    _jklScrubbing   = false;
    _jklScrubReady  = false;
    _jklScrubDone   = false;
    // Stop WebCodecs playback and commit the final scrub position to the player.
    // Must snap to a keyframe — the <video> element cannot decode from delta frames.
    if (_wcReady && WCReverse.supported) {
      WCReverse.stop();
      if (_wcScrubTime > 0) {
        const snapT = keyframeTimes.length
          ? (snapToKeyframe(_wcScrubTime) ?? _wcScrubTime)
          : _wcScrubTime;
        // Hide canvas once the video element has seeked to the keyframe
        player.addEventListener("seeked", () => { scrubCanvas.style.display = "none"; }, { once: true });
        player.currentTime = snapT;
        _wcScrubTime = 0;
      } else {
        scrubCanvas.style.display = "none";
      }
    }
  }

  // Start j-hold scrub: pause if playing, then begin paced backward keyframe steps.
  function _jklStartScrub() {
    if (_jklScrubbing) return;
    if (_jklSpeed > 0) { player.pause(); player.playbackRate = 1; _jklSpeed = 0; }
    _jklScrubbing = true;

    // ── WebCodecs path: smooth per-frame reverse ──────────────────────────────
    if (_wcReady && WCReverse.supported) {
      scrubCanvas.style.display = "block";
      WCReverse.startReverse(player.currentTime, t => { _wcScrubTime = t; })
        .catch(() => {
          scrubCanvas.style.display = "none";
          _jklScrubbing = false;
        });
      return;
    }

    // ── Fallback: keyframe-only paced scrub ───────────────────────────────────
    _jklScrubHoldT0 = Date.now();
    _jklScrubHoldMs = 0;
    _jklScrubReady  = false;
    _jklScrubDone   = true; // treat as "initial seek done" to allow first step

    _jklScrubFn = () => { _jklScrubDone = true; _jklScrubMaybeStep(); };
    player.addEventListener("seeked", _jklScrubFn);

    // Kick first step immediately (no initial delay)
    _jklScrubReady = true;
    _jklScrubMaybeStep();
  }

  // Seek back ~1 second (snapped to nearest preceding keyframe).
  function _jklJumpBack1s() {
    if (!player.duration) return;
    const target = player.currentTime - 1;
    if (target <= 0) { player.currentTime = 0; return; }
    player.currentTime = keyframeTimes.length ? (snapToKeyframe(target) ?? target) : target;
  }

  // Stop/pause everything and set forward playback speed (0 = pause).
  function _jklSet(speed) {
    _jklStopScrub();
    _jklSpeed = speed;
    if (speed === 0) {
      player.pause();
      player.playbackRate = 1;
    } else {
      player.playbackRate = speed;
      player.play().catch(() => {});
    }
  }

  // j → single tap: step back one frame (stay paused)
  //       hold:       scrub backward at 1× speed
  // l → tap: play forward / ramp speed up (NLE model)
  // k → stop everything
  function handleJKL(key, repeat) {
    if (!player.duration) return;
    if (key === "k") { _lStopHoldRamp(); _jklSet(0); return; }
    if (key === "j") {
      if (player.currentTime <= 0) return;
      if (repeat) { _jklStartScrub(); return; }
      // Single tap: stop any forward play, step back 30 frames (~1 second).
      _jklStopScrub();
      if (_jklSpeed > 0) _jklSet(0);
      player.currentTime = Math.max(0, player.currentTime - _JKL_FRAME * 30);
      return;
    }
    // key === "l"
    if (repeat) return; // ramp handled by _lStartHoldRamp timer
    _jklStopScrub();
    scrubCanvas.style.display = "none"; // hide canvas when starting forward play
    _lStopHoldRamp();
    _jklSet(_jklSpeed > 0 ? _jklSpeed + 1 : 1);
    _lStartHoldRamp();
  }



  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      player.playbackRate = parseFloat(btn.dataset.speed);
      document.querySelectorAll(".speed-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Reset speed indicator when a new video loads
  function resetSpeed() {
    _jklSet(0);
    player.playbackRate = 1;
    document.querySelectorAll(".speed-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.speed === "1");
    });
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  function resizeTimeline() {
    timeline.width = timeline.parentElement.clientWidth;
    if (waveCanvas) waveCanvas.width = waveCanvas.parentElement.clientWidth;
    drawTimeline();
    drawWaveform();
  }

  function drawWaveform() {
    if (!waveCtx || !waveCanvas || !waveCanvas.width) return;
    const W = waveCanvas.width;
    const H = waveCanvas.height;
    waveCtx.clearRect(0, 0, W, H);
    waveCtx.fillStyle = "#0d1014";
    waveCtx.fillRect(0, 0, W, H);
    if (!_waveData || !player.duration) return;
    const dur = player.duration;
    const vd  = tlViewDur();
    const samples = _waveData;
    const totalSamples = samples.length;
    waveCtx.fillStyle = "rgba(79,142,247,0.65)";
    const mid = H / 2;
    for (let px = 0; px < W; px++) {
      const t0 = tlOffset + (px / W) * vd;
      const t1 = tlOffset + ((px + 1) / W) * vd;
      if (t1 < 0 || t0 > dur) continue;
      const i0 = Math.floor((t0 / dur) * totalSamples);
      const i1 = Math.ceil((t1 / dur) * totalSamples);
      let mn = 0, mx = 0;
      for (let i = Math.max(0, i0); i < Math.min(totalSamples, i1); i++) {
        if (samples[i] < mn) mn = samples[i];
        if (samples[i] > mx) mx = samples[i];
      }
      const yTop = mid - mx * (mid - 1);
      const yBot = mid - mn * (mid - 1);
      waveCtx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
    }
    // Playhead
    const phx = Math.round(tlTimeToX(player.currentTime, W));
    waveCtx.fillStyle = "rgba(255,255,255,0.65)";
    waveCtx.fillRect(phx, 0, 1, H);
  }

  async function decodeWaveform(fileId) {
    if (!waveCanvas) return;
    _waveData = null;
    drawWaveform();
    try {
      // HEAD first to get file size, then fetch from ~15% in to avoid
      // moov/ftyp header bytes that have no audio data
      const head = await fetch(`/api/video/${fileId}`, { method: "HEAD" });
      const total = parseInt(head.headers.get("content-length") || "0");
      const chunkSize = 12 * 1024 * 1024; // 12 MB
      const start = total > chunkSize * 2 ? Math.floor(total * 0.15) : 0;
      const end = start + chunkSize - 1;
      const resp = await fetch(`/api/video/${fileId}`, { headers: { Range: `bytes=${start}-${end}` } });
      if (!resp.ok && resp.status !== 206) return;
      const arrayBuf = await resp.arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      let audioBuf;
      try { audioBuf = await ac.decodeAudioData(arrayBuf); }
      catch (_) { ac.close(); return; }
      ac.close();
      const raw = audioBuf.getChannelData(0);
      const target = 4000;
      const step = Math.max(1, Math.floor(raw.length / target));
      const out = new Float32Array(target);
      for (let i = 0; i < target; i++) out[i] = raw[Math.min(raw.length - 1, i * step)];
      if (fileId === currentFileId) {
        _waveData   = out;
        _waveFileId = fileId;
        drawWaveform();
      }
    } catch (_) { /* silent — waveform is decorative */ }
  }

  function drawTimeline() {
    const W   = timeline.width;
    const H   = timeline.height;
    const dur = player.duration || 1;
    const pos = player.currentTime || 0;
    const vd  = tlViewDur();
    const ve  = tlOffset + vd; // right edge in seconds

    ctx.clearRect(0, 0, W, H);

    // Track background
    ctx.fillStyle = "#1c1f24";
    ctx.fillRect(0, 0, W, H);

    // Pass 0: keyframe tick marks at bottom of canvas (faint amber)
    if (keyframeTimes.length) {
      const kfTicks = new Path2D();
      const tickH   = 14; // height from bottom
      for (let i = 0; i < keyframeTimes.length; i++) {
        const kft = keyframeTimes[i];
        if (kft < tlOffset || kft > ve) continue; // skip out-of-viewport
        const kx = tlTimeToX(kft, W);
        kfTicks.moveTo(kx, H);
        kfTicks.lineTo(kx, H - tickH);
      }
      ctx.strokeStyle = "rgba(255,180,40,0.28)";
      ctx.lineWidth = 1;
      ctx.stroke(kfTicks);
    }

    // Already-queued clip ranges — only draw clips from the current file
    // Pass 1: fills + selection borders
    clipQueue.forEach((item, qi) => {
      if (item.loading || item.file_id !== currentFileId) return;
      const qx1 = tlTimeToX(item.start, W);
      const qx2 = tlTimeToX(item.end,   W);
      ctx.globalAlpha = item.draft ? 0.35 : 1;
      ctx.fillStyle = item.color || CLIP_COLORS[qi % CLIP_COLORS.length];
      ctx.fillRect(qx1, 0, qx2 - qx1, H);
      if (item.draft) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(qx1 + 0.5, 0.5, qx2 - qx1 - 1, H - 1);
        ctx.setLineDash([]);
      }
      if (qi === selectedQueueIdx) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 2;
        ctx.strokeRect(qx1 + 1, 1, qx2 - qx1 - 2, H - 2);
        ctx.lineWidth = 1;
      }
      ctx.globalAlpha = 1;
    });
    // Pass 2: edge handles (resize grips)
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    clipQueue.forEach((item) => {
      if (item.loading || item.file_id !== currentFileId) return;
      const qx1 = tlTimeToX(item.start, W);
      const qx2 = tlTimeToX(item.end,   W);
      ctx.fillRect(qx1,     2, 3, H - 4);
      ctx.fillRect(qx2 - 3, 2, 3, H - 4);
    });
    // Pass 3: index labels
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    clipQueue.forEach((item, qi) => {
      if (item.loading || item.file_id !== currentFileId) return;
      const qx1 = tlTimeToX(item.start, W);
      const qx2 = tlTimeToX(item.end,   W);
      if (qx2 - qx1 > 16) ctx.fillText(String(qi + 1), qx1 + (qx2 - qx1) / 2, H / 2 + 4);
    });
    ctx.textAlign = "left";

    // Pass 4: drop ghost — show rebased clip position while dragging from queue
    if (_draggedQueueIdx !== null && _tlDragOverTime !== null) {
      const dItem   = clipQueue[_draggedQueueIdx];
      const dur2    = player.duration || 0;
      if (dItem) {
        const dLen    = dItem.end - dItem.start;
        const dStart  = Math.max(0, Math.min(_tlDragOverTime, dur2 - dLen));
        const dEnd    = dStart + dLen;
        const dx1     = tlTimeToX(dStart, W);
        const dx2     = tlTimeToX(dEnd,   W);
        ctx.globalAlpha = 0.55;
        ctx.fillStyle   = dItem.color || CLIP_COLORS[_draggedQueueIdx % CLIP_COLORS.length];
        ctx.fillRect(dx1, 0, dx2 - dx1, H);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,200,40,0.9)";
        ctx.lineWidth   = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(dx1 + 1, 1, dx2 - dx1 - 2, H - 2);
        ctx.setLineDash([]);
        ctx.lineWidth   = 1;
        // Drop line at cursor
        ctx.strokeStyle = "rgba(255,200,40,1)";
        ctx.lineWidth   = 2;
        const dropX     = tlTimeToX(_tlDragOverTime, W);
        ctx.beginPath(); ctx.moveTo(dropX, 0); ctx.lineTo(dropX, H); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // In→Out region (blue fill)
    const inX  = tlTimeToX(inPoint,  W);
    const outX = tlTimeToX(outPoint, W);
    ctx.fillStyle = "rgba(79,142,247,0.22)";
    ctx.fillRect(inX, 0, outX - inX, H);

    // Time tick marks — only within viewport, density based on view duration
    const tickInterval = niceTick(vd);
    const tickStart    = Math.floor(tlOffset / tickInterval) * tickInterval;
    const minorTicks   = new Path2D();
    const majorTicks   = new Path2D();
    for (let t = tickStart; t <= ve + tickInterval; t += tickInterval) {
      if (t < 0 || t > dur) continue;
      const x       = tlTimeToX(t, W);
      const isMajor = Math.round(t / tickInterval) % 5 === 0;
      if (isMajor) { majorTicks.moveTo(x, H); majorTicks.lineTo(x, H * 0.35); }
      else          { minorTicks.moveTo(x, H); minorTicks.lineTo(x, H * 0.6);  }
    }
    ctx.strokeStyle = "#2e3138";
    ctx.lineWidth = 1;
    ctx.stroke(minorTicks);
    ctx.stroke(majorTicks);
    ctx.fillStyle = "#555b6e";
    ctx.font = "10px monospace";
    for (let t = tickStart; t <= ve + tickInterval; t += tickInterval) {
      if (t < 0 || t > dur) continue;
      if (Math.round(t / tickInterval) % 5 !== 0) continue;
      const x = tlTimeToX(t, W);
      if (x >= -30 && x <= W + 30) ctx.fillText(fmtTimeTick(t), x + 3, H * 0.28);
    }

    // In-point marker (green)
    const inXc  = tlTimeToX(inPoint, W);
    ctx.fillStyle = "#4caf7d";
    ctx.fillRect(inXc - 1, 0, 2, H);
    _arrow(ctx, inXc, 0, "in");

    // Out-point marker (red)
    const outXc = tlTimeToX(outPoint, W);
    ctx.fillStyle = "#e05252";
    ctx.fillRect(outXc - 1, 0, 2, H);
    _arrow(ctx, outXc, 0, "out");

    // Snap ghost lines: show where FFmpeg will actually cut (nearest preceding keyframe)
    if (keyframeTimes.length) {
      const inSnap  = snapToKeyframe(inPoint);
      const outSnap = snapToKeyframe(outPoint);
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      if (inSnap !== null && Math.abs(inSnap - inPoint) > 0.01) {
        ctx.strokeStyle = "rgba(76,175,125,0.6)";
        const gx = tlTimeToX(inSnap, W);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      }
      if (outSnap !== null && Math.abs(outSnap - outPoint) > 0.01) {
        ctx.strokeStyle = "rgba(224,82,82,0.6)";
        const gx = tlTimeToX(outSnap, W);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    // Playhead (white)
    const playX = tlTimeToX(pos, W);
    ctx.fillStyle = "#fff";
    ctx.fillRect(playX - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(playX - 6, 0);
    ctx.lineTo(playX + 6, 0);
    ctx.lineTo(playX, 10);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  function _arrow(ctx, x, y, side) {
    const size = 12; // larger = easier to grab
    ctx.beginPath();
    if (side === "in") {
      ctx.moveTo(x, y + size);
      ctx.lineTo(x, y);
      ctx.lineTo(x + size, y);
    } else {
      ctx.moveTo(x, y + size);
      ctx.lineTo(x, y);
      ctx.lineTo(x - size, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  function niceTick(dur) {
    const targets = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const targetCount = 10;
    const ideal = dur / targetCount;
    return targets.reduce((a, b) => Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a);
  }

  function fmtTimeTick(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m > 0 ? `${m}:${String(s).padStart(2,"0")}` : `${s}s`;
  }

  // Animate timeline while video is playing
  function startTimelineLoop() {
    cancelAnimationFrame(rafId);
    function loop() {
      tlAutoScroll();
      drawTimeline();
      drawWaveform();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
  }

  function stopTimelineLoop() {
    cancelAnimationFrame(rafId);
    rafId = null;
    drawTimeline();
    drawWaveform();
  }

  // Coalesce rapid draw calls (e.g. marker drags) to one per animation frame.
  let _drawRafId = null;
  function scheduleDraw() {
    if (rafId) return;        // play-loop RAF already redraws every frame
    if (_drawRafId) return;   // already scheduled this frame
    _drawRafId = requestAnimationFrame(() => { _drawRafId = null; drawTimeline(); });
  }

  player.addEventListener("play",  startTimelineLoop);
  player.addEventListener("pause", stopTimelineLoop);
  player.addEventListener("seeked", () => drawTimeline());

  // Click/drag on timeline — seek or drag in/out markers
  let dragTarget        = null;  // null | "seek" | "in" | "out" | {type,qi}
  let wasPlaying        = false; // was video playing when seek-drag started?
  let _isSeeking        = false; // true while a browser seek is in-flight
  let _pendingScrubTime = null;  // latest scrub target queued while a seek is in-flight

  // ── Timeline viewport (zoom & pan) ────────────────────────────────────
  let tlZoom      = 1;     // 1 = full video visible; >1 = zoomed in
  let tlOffset    = 0;     // seconds at the canvas left edge
  let tlPanning   = false; // true while shift-dragging to pan
  let tlPanStartX = 0, tlPanStartOff = 0;

  function tlViewDur()     { return (player.duration || 1) / tlZoom; }
  function tlTimeToX(t, W) { return ((t - tlOffset) / tlViewDur()) * W; }
  function tlClampOff(off) {
    const avail = (player.duration || 0) - tlViewDur();
    return avail <= 0 ? 0 : Math.max(0, Math.min(avail, off));
  }
  function tlUpdateScrollbar() {
    const sb    = document.getElementById("tl-scrollbar");
    const thumb = document.getElementById("tl-scrollbar-thumb");
    const zlbl  = document.getElementById("tl-zoom-label");
    if (!sb || !thumb) return;
    if (tlZoom <= 1.001) {
      sb.classList.add("hidden");
      if (zlbl) zlbl.textContent = "";
    } else {
      sb.classList.remove("hidden");
      const thumbPct = 100 / tlZoom;
      const maxOff   = (player.duration || 0) - tlViewDur();
      const leftPct  = maxOff > 0 ? (tlOffset / maxOff) * (100 - thumbPct) : 0;
      thumb.style.width = `${thumbPct}%`;
      thumb.style.left  = `${Math.max(0, leftPct)}%`;
      if (zlbl) zlbl.textContent = `${tlZoom.toFixed(1)}×`;
    }
  }
  function tlAutoScroll() {
    if (tlZoom <= 1 || !player.duration) return;
    const pos = player.currentTime;
    const vd  = tlViewDur();
    if (pos < tlOffset + 0.1 * vd || pos > tlOffset + 0.9 * vd) {
      const newOff = tlClampOff(pos - 0.5 * vd);
      if (Math.abs(newOff - tlOffset) > 0.001) {
        tlOffset = newOff;
        tlUpdateScrollbar();
      }
    }
  }

  function hitMarker(clientX) {
    // returns "in" | "out" | {type:"clip-start"|"clip-end", qi} | null
    const rect   = timeline.getBoundingClientRect();
    const px     = clientX - rect.left;
    const W      = rect.width;
    const thresh = 10;
    if (Math.abs(px - tlTimeToX(inPoint,  W)) <= thresh) return "in";
    if (Math.abs(px - tlTimeToX(outPoint, W)) <= thresh) return "out";
    for (let qi = 0; qi < clipQueue.length; qi++) {
      const item = clipQueue[qi];
      if (item.loading || item.error || item.file_id !== currentFileId) continue;
      if (Math.abs(px - tlTimeToX(item.start, W)) <= thresh) return { type: "clip-start", qi };
      if (Math.abs(px - tlTimeToX(item.end,   W)) <= thresh) return { type: "clip-end",   qi };
    }
    return null;
  }

  function clientXToTime(clientX) {
    const rect = timeline.getBoundingClientRect();
    const x    = clientX - rect.left;
    return Math.max(0, Math.min(player.duration || 0,
      tlOffset + (x / rect.width) * tlViewDur()));
  }

  function timelineSeek(clientX) {
    const t = clientXToTime(clientX);
    _pendingScrubTime = t;
    // Only dispatch immediately if the browser isn't already mid-seek
    if (!_isSeeking && !_playerResetting) {
      _isSeeking = true;
      player.currentTime = t;
      _pendingScrubTime = null;
    }
    scheduleDraw();
  }

  timeline.addEventListener("mousedown", (e) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      tlPanning     = true;
      tlPanStartX   = e.clientX;
      tlPanStartOff = tlOffset;
      return;
    }
    const hit = hitMarker(e.clientX);
    if (hit) {
      dragTarget = hit;
      // When grabbing a clip edge, sync in/out to that clip so the editor stays aware
      if (typeof hit === "object") {
        const item = clipQueue[hit.qi];
        if (item) {
          selectedQueueIdx = hit.qi;
          inPoint = item.start; outPoint = item.end;
          inTimeInput.value = fmtTime(inPoint);
          outTimeInput.value = fmtTime(outPoint);
          outFilenameInput.value = item.filename;
          addQueueBtn.textContent = `Update Clip ${hit.qi + 1}`;
          updateRangeDisplay();
          renderQueue();
        }
      }
    } else {
      dragTarget = "seek";
      // Abandon any in-flight seek so this click always dispatches immediately
      _isSeeking = false;
      _pendingScrubTime = null;
      // Pause while scrubbing so the decoder isn't overwhelmed
      wasPlaying = !player.paused;
      if (wasPlaying) player.pause();
      timelineSeek(e.clientX);
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (tlPanning) {
      const dx = e.clientX - tlPanStartX;
      const _tlW = timeline.getBoundingClientRect().width;
      tlOffset = tlClampOff(tlPanStartOff - (dx / _tlW) * tlViewDur());
      tlUpdateScrollbar();
      scheduleDraw();
      return;
    }
    if (!dragTarget) return;
    const dur = player.duration || 0;
    if (dragTarget === "seek") {
      timelineSeek(e.clientX);
    } else if (dragTarget === "in") {
      const t = clientXToTime(e.clientX);
      inPoint = Math.max(0, Math.min(t, outPoint - MIN_CLIP_GAP));
      inTimeInput.value = fmtTime(inPoint);
      updateRangeDisplay();
      scheduleDraw();
    } else if (dragTarget === "out") {
      const t = clientXToTime(e.clientX);
      outPoint = Math.min(dur, Math.max(t, inPoint + MIN_CLIP_GAP));
      outTimeInput.value = fmtTime(outPoint);
      updateRangeDisplay();
      scheduleDraw();
    } else if (typeof dragTarget === "object") {
      const t = clientXToTime(e.clientX);
      const item = clipQueue[dragTarget.qi];
      if (!item) { dragTarget = null; return; }
      if (dragTarget.type === "clip-start") {
        item.start = Math.max(0, Math.min(t, item.end - MIN_CLIP_GAP));
        inPoint = item.start;
        inTimeInput.value = fmtTime(inPoint);
      } else {
        item.end = Math.min(dur, Math.max(t, item.start + MIN_CLIP_GAP));
        outPoint = item.end;
        outTimeInput.value = fmtTime(outPoint);
      }
      updateRangeDisplay();
      scheduleDraw();
    }
  });

  window.addEventListener("mouseup", () => {
    tlPanning = false;
    if (dragTarget === "seek") {
      const _resumePlay = wasPlaying;
      // Flush the last scrub position so we always land exactly where the user released
      if (_pendingScrubTime !== null) {
        _isSeeking = true;
        player.currentTime = _pendingScrubTime;
        _pendingScrubTime = null;
      }
      if (_resumePlay) {
        // Wait for the final seek to settle before resuming playback
        if (_isSeeking) {
          player.addEventListener("seeked", () => {
            player.play().catch(err => { if (err.name !== "AbortError") console.warn("play():", err); });
          }, { once: true });
        } else {
          player.play().catch(err => { if (err.name !== "AbortError") console.warn("play():", err); });
        }
      }
    }
    if (typeof dragTarget === "object") renderQueue(); // refresh clip range display
    wasPlaying = false;
    dragTarget = null;
  });

  // Hover cursor: ew-resize near markers, crosshair otherwise
  timeline.addEventListener("mousemove", (e) => {
    if (dragTarget) return;
    timeline.style.cursor = hitMarker(e.clientX) ? "ew-resize" : "crosshair";
  });
  timeline.addEventListener("mouseleave", () => { timeline.style.cursor = "crosshair"; });

  // Double-click = reset zoom
  timeline.addEventListener("dblclick", () => {
    tlZoom = 1; tlOffset = 0;
    tlUpdateScrollbar();
    scheduleDraw();
  });

  // +/- zoom buttons
  function tlZoomStep(factor) {
    if (!player.duration) return;
    const mid = tlOffset + tlViewDur() / 2;
    tlZoom    = Math.max(1, Math.min(200, tlZoom * factor));
    tlOffset  = tlZoom <= 1 ? 0 : tlClampOff(mid - tlViewDur() / 2);
    tlUpdateScrollbar();
    scheduleDraw();
  }
  const _zoomInBtn  = document.getElementById("tl-zoom-in");
  const _zoomOutBtn = document.getElementById("tl-zoom-out");
  if (_zoomInBtn)  _zoomInBtn.addEventListener("click",  () => tlZoomStep(1.5));
  if (_zoomOutBtn) _zoomOutBtn.addEventListener("click", () => tlZoomStep(1 / 1.5));

  // Scrollbar thumb drag to pan
  const _sbThumb = document.getElementById("tl-scrollbar-thumb");
  if (_sbThumb) {
    let _sbDrag = false, _sbStartX = 0, _sbStartOff = 0;
    _sbThumb.addEventListener("mousedown", (e) => {
      _sbDrag = true; _sbStartX = e.clientX; _sbStartOff = tlOffset;
      e.stopPropagation(); e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!_sbDrag) return;
      const sbW     = document.getElementById("tl-scrollbar").getBoundingClientRect().width;
      const thumbW  = sbW / tlZoom;
      const dx      = e.clientX - _sbStartX;
      const dur     = player.duration || 0;
      tlOffset = tlClampOff(_sbStartOff + (dx / Math.max(1, sbW - thumbW)) * (dur - tlViewDur()));
      tlUpdateScrollbar();
      scheduleDraw();
    });
    window.addEventListener("mouseup", () => { _sbDrag = false; });
  }

  // ── Sidebar resize handle ─────────────────────────────────────────────────
  const _sidebarEl = document.getElementById("queue-sidebar");
  const _resizeHandle = document.getElementById("sidebar-resize-handle");
  if (_sidebarEl && _resizeHandle) {
    let _rDragging = false, _rStartX = 0, _rStartW = 0;
    _resizeHandle.addEventListener("mousedown", (e) => {
      _rDragging = true;
      _rStartX   = e.clientX;
      _rStartW   = _sidebarEl.getBoundingClientRect().width;
      _resizeHandle.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!_rDragging) return;
      const newW = Math.max(140, Math.min(600, _rStartW + (e.clientX - _rStartX)));
      _sidebarEl.style.width = `${newW}px`;
      resizeTimeline();
    });
    window.addEventListener("mouseup", () => {
      if (_rDragging) { _rDragging = false; _resizeHandle.classList.remove("dragging"); }
    });
  }

  // ── Timeline drag-and-drop from queue sidebar ─────────────────────────────
  timeline.addEventListener("dragover", (e) => {
    if (_draggedQueueIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    _tlDragOverTime = clientXToTime(e.clientX);
    scheduleDraw();
  });
  timeline.addEventListener("dragleave", () => {
    _tlDragOverTime = null;
    scheduleDraw();
  });
  timeline.addEventListener("drop", (e) => {
    e.preventDefault();
    if (_draggedQueueIdx === null) return;
    const item = clipQueue[_draggedQueueIdx];
    if (!item) { _draggedQueueIdx = null; _tlDragOverTime = null; return; }
    const dur      = player.duration || 0;
    const clipLen  = item.end - item.start;
    const dropT    = clientXToTime(e.clientX);
    const newStart = Math.max(0, Math.min(dropT, dur - clipLen));
    const newEnd   = Math.min(dur, newStart + clipLen);
    item.start = newStart;
    item.end   = newEnd;
    selectedQueueIdx      = _draggedQueueIdx;
    inPoint               = newStart;
    outPoint              = newEnd;
    inTimeInput.value     = fmtTime(newStart);
    outTimeInput.value    = fmtTime(newEnd);
    addQueueBtn.textContent = item.draft ? `Stage Draft ${_draggedQueueIdx + 1}` : `Update Clip ${_draggedQueueIdx + 1}`;
    updateRangeDisplay();
    // Seek to drop position if it's the active file
    if (item.file_id === currentFileId) player.currentTime = newStart;
    _draggedQueueIdx = null;
    _tlDragOverTime  = null;
    renderQueue();
    scheduleDraw();
  });

  // Touch support
  timeline.addEventListener("touchstart", (e) => {
    const touch = e.touches[0];
    const hit = hitMarker(touch.clientX);
    if (hit) {
      dragTarget = hit;
      if (typeof hit === "object") {
        const item = clipQueue[hit.qi];
        if (item) {
          selectedQueueIdx = hit.qi;
          inPoint = item.start; outPoint = item.end;
          inTimeInput.value = fmtTime(inPoint);
          outTimeInput.value = fmtTime(outPoint);
          outFilenameInput.value = item.filename;
          addQueueBtn.textContent = `Update Clip ${hit.qi + 1}`;
          updateRangeDisplay();
          renderQueue();
        }
      }
    } else {
      dragTarget = "seek";
      wasPlaying = !player.paused;
      if (wasPlaying) player.pause();
      timelineSeek(touch.clientX);
    }
    e.preventDefault();
  }, { passive: false });
  window.addEventListener("touchmove", (e) => {
    if (!dragTarget) return;
    const touch = e.touches[0];
    const dur = player.duration || 0;
    if (dragTarget === "seek") {
      timelineSeek(touch.clientX);
    } else if (dragTarget === "in") {
      inPoint = Math.max(0, Math.min(clientXToTime(touch.clientX), outPoint - 0.01));
      inTimeInput.value = fmtTime(inPoint);
      updateRangeDisplay(); scheduleDraw();
    } else if (dragTarget === "out") {
      outPoint = Math.min(dur, Math.max(clientXToTime(touch.clientX), inPoint + 0.01));
      outTimeInput.value = fmtTime(outPoint);
      updateRangeDisplay(); scheduleDraw();
    } else if (typeof dragTarget === "object") {
      const t = clientXToTime(touch.clientX);
      const item = clipQueue[dragTarget.qi];
      if (item) {
        if (dragTarget.type === "clip-start") {
          item.start = Math.max(0, Math.min(t, item.end - 0.01));
          inPoint = item.start; inTimeInput.value = fmtTime(inPoint);
        } else {
          item.end = Math.min(dur, Math.max(t, item.start + 0.01));
          outPoint = item.end; outTimeInput.value = fmtTime(outPoint);
        }
        updateRangeDisplay(); scheduleDraw();
      }
    }
  });
  window.addEventListener("touchend", () => {
    if (dragTarget === "seek" && wasPlaying) {
      player.play().catch(err => { if (err.name !== "AbortError") console.warn("play():", err); });
    }
    if (typeof dragTarget === "object") renderQueue();
    wasPlaying = false;
    dragTarget = null;
  });

  window.addEventListener("resize", resizeTimeline);

  // ── Auth ───────────────────────────────────────────────────────────────────

  async function checkAuth() {
    const res = await fetch("/auth/status");
    const data = await res.json();
    if (data.authenticated) {
      authLabel.textContent = "Connected to Drive";
      authBtn.textContent = "Disconnect";
      authBtn.classList.remove("hidden");
      authBtn.onclick = async () => {
        await fetch("/auth/logout");
        // Clear file list so stale entries don't show for a new account
        fileList.innerHTML = "";
        hide(fileListWrap);
        checkAuth();
      };
    } else {
      authLabel.textContent = "Not connected";
      authBtn.textContent = "Connect Google Drive";
      authBtn.classList.remove("hidden");
      authBtn.onclick = () => { window.location.href = "/auth/login"; };
    }
  }

  // Persist output folder across sessions
  const savedOutputFolder = localStorage.getItem(OUTPUT_FOLDER_KEY) || "https://drive.google.com/drive/folders/1EOuBel2ISjKYYGVrHP1SrGPeVLwxZzGd";
  outputFolderInput.value = savedOutputFolder;
  outputFolderInput.addEventListener("change", () => {
    localStorage.setItem(OUTPUT_FOLDER_KEY, outputFolderInput.value.trim());
  });

  // Persist group tag, reset clip index when tag changes
  const savedGroupTag = localStorage.getItem(GROUP_TAG_KEY);
  if (savedGroupTag) groupTagInput.value = savedGroupTag;
  groupTagInput.addEventListener("input", () => {
    localStorage.setItem(GROUP_TAG_KEY, groupTagInput.value.trim());
    clipIndex = 1;
    if (currentOrigName) outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
  });

  function getOutputFolderId() {
    const raw = outputFolderInput.value.trim();
    if (!raw) return null;
    try { return drive_parse_folder_id_client(raw); } catch { return null; }
  }

  // Client-side folder-ID extractor (mirrors drive.py parse_folder_id)
  function drive_parse_folder_id_client(urlOrId) {
    const m = urlOrId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId)) return urlOrId;
    return null;
  }
  const savedFolder = localStorage.getItem(FOLDER_KEY);
  if (savedFolder) {
    folderUrlInput.value = savedFolder;
    // Auto-browse after OAuth redirect back (?authed=1) or on normal load
    window.addEventListener("load", () => setTimeout(tryAutoBrowse, 300));
  }

  // Strip ?authed=1 from URL bar after OAuth redirect without reloading
  if (new URLSearchParams(location.search).get("authed")) {
    history.replaceState({}, "", location.pathname);
  }

  async function tryAutoBrowse() {
    const res = await fetch("/auth/status");
    const data = await res.json();
    if (data.authenticated && folderUrlInput.value.trim()) browseFolder();
  }

  browseBtn.addEventListener("click", browseFolder);
  folderUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") browseFolder(); });
  refreshBtn.addEventListener("click", browseFolder);

  selectAllCb.addEventListener("change", () => {
    const cbs = [...fileList.querySelectorAll(".file-item-cb")];
    cbs.forEach(cb => {
      cb.checked = selectAllCb.checked;
      if (selectAllCb.checked) {
        checkedFileIds.add(cb.dataset.id);
        cb.closest(".file-item").classList.add("file-item-checked");
      } else {
        checkedFileIds.delete(cb.dataset.id);
        cb.closest(".file-item").classList.remove("file-item-checked");
      }
    });
    updateLoadSelectedBtn();
  });

  loadSelectedBtn.addEventListener("click", () => {
    // Maintain server-list order regardless of check order
    const files = allFiles.filter(f => checkedFileIds.has(f.id));
    if (files.length === 0) return;
    checkedFileIds.clear();
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
    updateLoadSelectedBtn();
    _loadedFileIds.clear(); // fresh batch — any prior files were already reset
    _batchMode = true;
    // Pre-populate ALL placeholders in order BEFORE any async work so queue order matches file order
    files.forEach((f, i) => {
      clipQueue.push({ start: 0, end: 0, filename: f.name, color: CLIP_COLORS[i % CLIP_COLORS.length], file_id: f.id, loading: true });
    });
    renderQueue();
    // Load first file into player; background-download the rest
    loadById(files[0].id, files[0].name);
    files.slice(1).forEach(f => backgroundLoadFile(f));
  });


  async function browseFolder() {
    const url = folderUrlInput.value.trim();
    if (!url) return;
    clearError(folderError);
    browseBtn.disabled = true;
    browseBtn.textContent = "Loading…";
    try {
      const res = await fetch(`/api/folder?folder_url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not list folder");
      localStorage.setItem(FOLDER_KEY, url);
      renderFileList(data.files);
    } catch (err) {
      showError(folderError, err.message);
      hide(fileListWrap);
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = "Browse";
    }
  }

  function updateLoadSelectedBtn() {
    const n = checkedFileIds.size;
    if (n > 0) {
      loadSelectedBtn.textContent = `Load Selected (${n})`;
      show(loadSelectedBtn);
    } else {
      hide(loadSelectedBtn);
    }
  }

  function renderFileList(files) {
    allFiles = files;
    checkedFileIds.clear();
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
    updateLoadSelectedBtn();
    fileList.innerHTML = "";
    if (files.length === 0) {
      fileCount.textContent = "No video files found";
      show(fileListWrap);
      return;
    }
    fileCount.textContent = `${files.length} video${files.length !== 1 ? "s" : ""}`;
    files.forEach((f) => {
      const safeName = f.name.replace(/"/g, "&quot;");
      const li = document.createElement("li");
      li.className = "file-item";
      li.innerHTML = `
        <input type="checkbox" class="file-item-cb" data-id="${f.id}" data-name="${safeName}" title="Select for batch load">
        <span class="file-name" title="${f.name}">${f.name}</span>
        <span class="file-meta">${fmtSize(parseInt(f.size || 0))}</span>
        <button class="small load-file-btn" data-id="${f.id}" data-name="${f.name}">Load</button>
      `;
      fileList.appendChild(li);
    });
    fileList.querySelectorAll(".file-item-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) {
          checkedFileIds.add(cb.dataset.id);
          cb.closest(".file-item").classList.add("file-item-checked");
        } else {
          checkedFileIds.delete(cb.dataset.id);
          cb.closest(".file-item").classList.remove("file-item-checked");
        }
        const total = fileList.querySelectorAll(".file-item-cb").length;
        const checked = checkedFileIds.size;
        selectAllCb.checked = checked === total;
        selectAllCb.indeterminate = checked > 0 && checked < total;
        updateLoadSelectedBtn();
      });
    });
    fileList.querySelectorAll(".load-file-btn").forEach((btn) => {
      btn.addEventListener("click", () => loadById(btn.dataset.id, btn.dataset.name));
    });
    show(fileListWrap);
  }

  // ── Load by ID ────────────────────────────────────────────────────────────

  async function loadById(fileId, filename) {
    // Stash current file so it stays alive on the server for queue swaps
    if (currentFileId) _loadedFileIds.add(currentFileId);
    clearError(loadError);
    hide(loadPanel);
    spinnerLabel.textContent = `Downloading ${filename}…`;
    show(spinnerPanel);
    await doLoad(`https://drive.google.com/file/d/${fileId}/view`, fileId);
  }

  // ── Background batch-load helpers ────────────────────────────────────────

  async function pollLoadProgressSilent(fileId) {
    return new Promise((resolve, reject) => {
      const iv = setInterval(async () => {
        try {
          const r = await fetch(`/api/load_progress/${fileId}`);
          const p = await r.json();
          if (p.error) { clearInterval(iv); clearTimeout(to); reject(new Error(p.error)); return; }
          if (p.done)  { clearInterval(iv); clearTimeout(to); resolve(); }
        } catch (e) { clearInterval(iv); clearTimeout(to); reject(e); }
      }, 500);
      const to = setTimeout(() => {
        clearInterval(iv);
        reject(new Error("Background download timed out after 60s"));
      }, 60_000);
    });
  }

  async function backgroundLoadFile(f) {
    // Placeholder already pre-populated in queue by loadSelectedBtn — just download & update it
    let loadedFileId = null;
    try {
      const res = await fetch("/api/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://drive.google.com/file/d/${f.id}/view` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Load failed");
      loadedFileId = data.file_id;
      _loadedFileIds.add(data.file_id);
      fileOrigNames.set(data.file_id, f.name);
      await pollLoadProgressSilent(data.file_id);
      // Get duration via ffprobe
      const mr = await fetch(`/api/metadata/${data.file_id}`);
      if (!mr.ok) throw new Error("Metadata fetch failed");
      const meta = await mr.json();
      const duration = meta.duration || 0;
      // Find and update the placeholder
      const idx = clipQueue.findIndex(c => c.file_id === f.id && c.loading);
      if (idx !== -1) {
        const ext = f.name.match(/\.[^.]+$/)?.[0] ?? ".mp4";
        const stem = f.name.slice(0, f.name.length - ext.length);
        clipQueue[idx] = { ...clipQueue[idx], file_id: data.file_id, end: duration, filename: `${stem}_clip01${ext}`, loading: false };
        renderQueue();
        drawTimeline();
        logAppend("INFO", `Queued: ${f.name} (${fmtTime(duration)})`);
      }
    } catch (err) {
      // Remove from _loadedFileIds if it was registered (don't try to unload a failed download)
      if (loadedFileId) _loadedFileIds.delete(loadedFileId);
      // Mark placeholder as errored rather than silently removing it
      const idx = clipQueue.findIndex(c => c.file_id === f.id && c.loading);
      if (idx !== -1) {
        clipQueue[idx] = { ...clipQueue[idx], loading: false, error: err.message };
        renderQueue();
      }
      logAppend("ERROR", `Background load failed for ${f.name}: ${err.message}`);
    }
  }

  async function swapToFile(fileId) {
    _playerResetting = true;
    clearTimeout(_stallTimer);
    currentFileId = fileId;
    currentOrigName = fileOrigNames.get(fileId) || currentOrigName;
    player.src = `/api/video/${fileId}`;
    player.load();
    try {
      await new Promise((resolve, reject) => {
        if (player.readyState >= 1) { resolve(); return; }
        let settled = false;
        const done = (fn) => { if (settled) return; settled = true; clearTimeout(to); fn(); };
        const to = setTimeout(() => done(() => reject(new Error("Timed out loading video metadata"))), 15000);
        player.addEventListener("loadedmetadata", () => done(resolve), { once: true });
        player.addEventListener("error", () => done(() => {
          if (player.error) reject(new Error(`Player error (${player.error.code}): ${player.error.message}`));
          else resolve(); // no real error (e.g. empty-src flush)
        }), { once: true });
      });
    } catch (err) {
      _playerResetting = false;
      throw err;
    }
    _playerResetting = false;
    videoFilename.textContent = currentOrigName || "";
    clipIndex = 1;
    outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
    fetchKeyframes(fileId);
    decodeWaveform(fileId);
    // Initialise WebCodecs reverse scrub for this file (non-blocking)
    scrubCanvas.style.display = "none";
    _wcReady     = false;
    _wcScrubTime = 0;
    if (WCReverse.supported) {
      WCReverse.init(fileId, scrubCanvas)
        .then(ok => { _wcReady = ok; })
        .catch(() => { _wcReady = false; });
    }
  }

  loadBtn.addEventListener("click", () => {
    const url = driveUrl.value.trim();
    if (!url) return;
    // If a folder URL was pasted into the file input, redirect to the folder browser
    if (/\/folders\//.test(url)) {
      folderUrlInput.value = url;
      driveUrl.value = "";
      browseFolder();
      return;
    }
    clearError(loadError);
    hide(loadPanel);
    spinnerLabel.textContent = "Downloading…";
    show(spinnerPanel);
    doLoad(url);
  });

  driveUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") loadBtn.click(); });

  // Phase 1: poll server while it downloads from Drive
  async function pollLoadProgress(fileId) {
    return new Promise((resolve, reject) => {
      const iv = setInterval(async () => {
        try {
          const r = await fetch(`/api/load_progress/${fileId}`);
          const p = await r.json();
          if (p.error) { clearInterval(iv); reject(new Error(p.error)); return; }
          if (p.total_bytes > 0) {
            const pct = Math.round((p.bytes_done / p.total_bytes) * 100);
            bufferFill.style.width = `${pct}%`;
            bufferLabel.textContent = `Downloading… ${pct}%  \u2014  ${fmtSize(p.bytes_done)} / ${fmtSize(p.total_bytes)}`;
          } else if (p.bytes_done > 0) {
            bufferLabel.textContent = `Downloading… ${fmtSize(p.bytes_done)}`;
          }
          if (p.done) { clearInterval(iv); resolve(); }
        } catch (e) { clearInterval(iv); logAppend("ERROR", `Load progress poll failed: ${e.message}`); reject(e); }
      }, 300);
    });
  }


  async function doLoad(url, driveFileId = null) {
    try {
      // POST returns immediately — background download starts on server
      const res = await fetch("/api/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Load failed");

      currentFileId = data.file_id;
      currentOrigName = data.filename;
      fileOrigNames.set(data.file_id, data.filename);
      clipIndex = 1;
      videoFilename.textContent = data.filename;
      outFilenameInput.value = defaultClipName(data.filename, clipIndex);
      resetSpeed();

      // Phase 1: Drive → server with progress bar
      bufferFill.style.width = "0%";
      bufferLabel.textContent = `Downloading ${data.filename} from Drive…`;
      show(bufferBarWrap);
      spinnerLabel.textContent = `Downloading ${data.filename}…`;
      await pollLoadProgress(data.file_id);

      hide(bufferBarWrap);
      player.src = `/api/video/${data.file_id}`;
      player.load();

      hide(spinnerPanel);
      show(editorPanel);

      player.addEventListener("loadedmetadata", () => {
        inPoint = 0;
        outPoint = player.duration;
        inTimeInput.value = fmtTime(inPoint);
        outTimeInput.value = fmtTime(outPoint);
        updateRangeDisplay();
        resizeTimeline();
        fetchKeyframes(currentFileId); // fire-and-forget keyframe overlay
        decodeWaveform(currentFileId); // fire-and-forget waveform
        if (_batchMode) {
          // Find placeholder by Drive ID (driveFileId) then update it with the server file_id
          const pidx = driveFileId
            ? clipQueue.findIndex(c => c.file_id === driveFileId && c.loading)
            : clipQueue.findIndex(c => c.file_id === currentFileId && c.loading);
          if (pidx !== -1) {
            clipQueue[pidx] = { ...clipQueue[pidx], file_id: currentFileId, end: player.duration, filename: defaultClipName(currentOrigName, 1), loading: false };
            selectedQueueIdx = pidx;
            addQueueBtn.textContent = `Update Clip ${pidx + 1}`;
          }
          outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
          renderQueue();
          logAppend("INFO", `Queued: ${currentOrigName} (${fmtTime(player.duration)})`);
        }
      }, { once: true });

    } catch (err) {
      _batchMode = false;
      hide(bufferBarWrap);
      hide(spinnerPanel);
      show(loadPanel);
      showError(loadError, err.message);
      logAppend("ERROR", `Load failed: ${err.message}`);
    }
  }

  // ── Frame step ────────────────────────────────────────────────────────────

  function stepFrame(dir, frames = 20) {
    if (!player.duration) return;
    const step = frames / 30; // 20 frames at ~30 fps
    player.pause();
    player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + dir * step));
    drawTimeline();
  }

  frameBackBtn.addEventListener("click", () => stepFrame(-1));
  frameFwdBtn.addEventListener("click",  () => stepFrame(1));

  // ── Trim point controls ───────────────────────────────────────────────────

  function setInPoint() {
    const t = player.currentTime;
    inPoint = Math.min(t, outPoint - MIN_CLIP_GAP);
    inTimeInput.value = fmtTime(inPoint);
    updateRangeDisplay();
    drawTimeline();
  }

  function setOutPoint() {
    const t = player.currentTime;
    outPoint = Math.max(t, inPoint + MIN_CLIP_GAP);
    outTimeInput.value = fmtTime(outPoint);
    updateRangeDisplay();
    drawTimeline();
  }

  setInBtn.addEventListener("click", setInPoint);
  setOutBtn.addEventListener("click", setOutPoint);

  let _trimErrorTimer = null;
  function flashTrimWarn(msg) {
    showError(trimError, msg);
    if (_trimErrorTimer) clearTimeout(_trimErrorTimer);
    _trimErrorTimer = setTimeout(() => clearError(trimError), 2500);
  }

  inTimeInput.addEventListener("change", () => {
    const v = parseTime(inTimeInput.value);
    if (!isNaN(v) && v >= 0) {
      const dur = player.duration || 0;
      const clamped = Math.min(v, Math.max(0, dur - 0.001));
      if (clamped !== v) {
        inTimeInput.value = fmtTime(clamped);
        flashTrimWarn(`In point clamped to ${fmtTime(clamped)}`);
      }
      inPoint = clamped;
      player.currentTime = clamped;
      updateRangeDisplay();
      drawTimeline();
    }
  });

  outTimeInput.addEventListener("change", () => {
    const v = parseTime(outTimeInput.value);
    if (!isNaN(v) && v > 0) {
      const dur = player.duration || 0;
      const clamped = dur ? Math.min(v, dur) : v;
      if (clamped !== v) {
        outTimeInput.value = fmtTime(clamped);
        flashTrimWarn(`Out point clamped to ${fmtTime(clamped)}`);
      }
      outPoint = clamped;
      player.currentTime = clamped;
      updateRangeDisplay();
      drawTimeline();
    }
  });

  // ── Trim & upload ─────────────────────────────────────────────────────────

  trimBtn.addEventListener("click", async () => {
    clearError(trimError);
    if (outPoint <= inPoint) { showError(trimError, "Out point must be after in point."); return; }
    if (!currentFileId) { showError(trimError, "No file loaded."); return; }
    if (!getOutputFolderId()) { showError(trimError, "Set an output folder before trimming."); return; }

    const outputFilename = outFilenameInput.value.trim();
    trimBtn.disabled = true;
    trimBtn.textContent = "Uploading…";

    try {
      const res = await fetch("/api/trim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: currentFileId,
          start: inPoint,
          end: outPoint,
          output_filename: outputFilename || null,
          output_folder_id: getOutputFolderId(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Trim failed");

      showToast(`✓ Uploaded: ${data.filename}`, data.url);
      clipIndex += 1;
      outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
      inPoint = 0;
      outPoint = player.duration;
      inTimeInput.value = fmtTime(inPoint);
      outTimeInput.value = fmtTime(outPoint);
      player.currentTime = 0;
      updateRangeDisplay();
      drawTimeline();

    } catch (err) {
      showError(trimError, err.message);
    } finally {
      trimBtn.disabled = false;
      trimBtn.textContent = "Trim & Upload Now";
    }
  });

  // ── Queue ─────────────────────────────────────────────────────────────

  function renderQueue() {
    queueList.innerHTML = "";
    const stagedCount = clipQueue.filter(c => !c.draft).length;
    queueCount.textContent = `${stagedCount} clip${stagedCount !== 1 ? "s" : ""} queued`;
    if (clipQueue.length === 0) { hide(queueSection); return; }
    show(queueSection);
    clipQueue.forEach((item, idx) => {
      const isActive = item.file_id === currentFileId && !item.loading;
      const li = document.createElement("li");
      li.className = "queue-item" +
        (idx === selectedQueueIdx ? " queue-item-selected" : "") +
        (item.loading ? " queue-item-loading" : "") +
        (item.draft   ? " queue-item-draft"   : "");
      li.dataset.idx = idx;
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        _draggedQueueIdx = idx;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
        scheduleDraw();
      });
      li.addEventListener("dragend", () => {
        _draggedQueueIdx = null;
        _tlDragOverTime  = null;
        scheduleDraw();
      });
      let statusBadge, statusClass, editLabel, editDisabled;
      if (item.error) {
        statusBadge = "\u2717"; statusClass = "qi-err"; editLabel = "\u2717"; editDisabled = true;
      } else if (item.loading) {
        statusBadge = "\u23F3"; statusClass = "qi-downloading"; editLabel = "\u23F3"; editDisabled = true;
      } else if (item.draft) {
        statusBadge = "\u25CC"; statusClass = "qi-draft"; editLabel = idx === selectedQueueIdx ? "\u2713 editing" : "Edit"; editDisabled = false;
      } else if (isActive) {
        statusBadge = "\u25CF"; statusClass = "qi-active"; editLabel = idx === selectedQueueIdx ? "\u2713 editing" : "Edit"; editDisabled = false;
      } else {
        statusBadge = "\u25CB"; statusClass = "qi-onserver"; editLabel = idx === selectedQueueIdx ? "\u2713 editing" : "Edit"; editDisabled = false;
      }
      const rangeText = item.error ? `\u2717 ${item.error}` : item.loading ? "\u23F3 downloading\u2026" : (fmtTime(item.start) + " \u2192 " + fmtTime(item.end));
      const statusTitle = item.error ? item.error : item.loading ? "Downloading from Drive" : item.draft ? "Draft \u2013 not queued for upload" : (isActive ? "In player" : "Ready on server");
      const stageBtn = item.draft && !item.loading && !item.error
        ? `<button class="queue-item-stage" data-idx="${idx}" title="Add to upload queue">+ Queue</button>`
        : `<span></span>`;
      const srcName = fileOrigNames.get(item.file_id) || "";
      const srcSubtitle = srcName ? `<span class="queue-item-source" title="${srcName}">${srcName}</span>` : "";
      li.innerHTML = `
        <span class="queue-item-name" title="Click to rename" data-idx="${idx}" ${item.loading || item.error ? "" : 'style="cursor:text"'}>${item.filename}${srcSubtitle}</span>
        <span class="queue-item-range">${rangeText}</span>
        <span class="queue-item-status ${statusClass}" title="${statusTitle}">${statusBadge}</span>
        ${stageBtn}
        <button class="queue-item-load" data-idx="${idx}" title="Load into editor" ${editDisabled ? "disabled" : ""}>${editLabel}</button>
        <button class="queue-item-remove" data-idx="${idx}" title="Remove">&times;</button>
      `;
      queueList.appendChild(li);
    });
    queueList.querySelectorAll(".queue-item-name[data-idx]").forEach(span => {
      span.addEventListener("click", () => {
        const i = parseInt(span.dataset.idx);
        if (clipQueue[i].loading || clipQueue[i].error) return;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = clipQueue[i].filename;
        inp.className = "queue-name-input";
        span.replaceWith(inp);
        inp.select();
        const save = () => {
          const val = inp.value.trim();
          if (val) {
            clipQueue[i].filename = val;
            // keep outFilenameInput in sync if this clip is currently selected
            if (selectedQueueIdx === i) outFilenameInput.value = val;
          }
          renderQueue();
        };
        inp.addEventListener("blur", save);
        inp.addEventListener("keydown", e => {
          if (e.key === "Enter")  { e.preventDefault(); inp.blur(); }
          if (e.key === "Escape") { inp.removeEventListener("blur", save); renderQueue(); }
        });
      });
    });
    queueList.querySelectorAll(".queue-item-stage[data-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.idx);
        if (clipQueue[i]) { delete clipQueue[i].draft; renderQueue(); drawTimeline(); }
      });
    });
    queueList.querySelectorAll(".queue-item-load[data-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.idx);
        if (selectedQueueIdx === i) {
          // clicking the active clip's Load button deselects it
          selectedQueueIdx = null;
          addQueueBtn.textContent = "+ Add to Queue";
          drawTimeline();
          renderQueue();
        } else {
          selectQueueClip(i);
        }
      });
    });
    queueList.querySelectorAll(".queue-item-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.idx);
        if (selectedQueueIdx === i) {
          selectedQueueIdx = null;
          addQueueBtn.textContent = "+ Add to Queue";
        } else if (selectedQueueIdx !== null && i < selectedQueueIdx) {
          selectedQueueIdx--;
        }
        clipQueue.splice(i, 1);
        renderQueue();
        drawTimeline();
      });
    });
  }

  function setQueueItemStatus(idx, status, msg) {
    // status: 'pending' | 'running' | 'ok' | 'err'
    const li = queueList.querySelector(`[data-idx="${idx}"]`);
    if (!li) return;
    const badge = li.querySelector(".queue-item-status");
    if (!badge) return;
    badge.className = `queue-item-status qi-${status}`;
    const icons = { pending: "\u2022", running: "\u29D7", ok: "\u2713", err: "\u2717" };
    badge.textContent = icons[status] || "?";
    badge.title = msg || "";
    // Disable remove button when running/done
    const rmBtn = li.querySelector(".queue-item-remove");
    if (rmBtn) rmBtn.disabled = status === "running" || status === "ok" || status === "err";
  }

  async function selectQueueClip(idx) {
    const item = clipQueue[idx];
    if (!item || item.loading || item.error) return; // not editable while downloading or failed
    selectedQueueIdx = idx;

    // If this clip belongs to a different file, swap the player to that file
    if (item.file_id && item.file_id !== currentFileId) {
      try {
        await swapToFile(item.file_id);
      } catch (err) {
        selectedQueueIdx = null;
        showError(trimError, `Could not load clip: ${err.message}`);
        logAppend("ERROR", `swapToFile failed: ${err.message}`);
        return;
      }
    }

    inPoint = item.start;
    outPoint = item.end || player.duration || 0;
    inTimeInput.value = fmtTime(inPoint);
    outTimeInput.value = fmtTime(outPoint);
    outFilenameInput.value = item.filename;
    player.currentTime = inPoint;
    updateRangeDisplay();
    drawTimeline();
    addQueueBtn.textContent = item.draft ? `Stage Draft ${idx + 1}` : `Update Clip ${idx + 1}`;
    renderQueue();
    // Scroll the timeline into view so user can see the markers change
    timeline.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  addQueueBtn.addEventListener("click", () => {
    clearError(trimError);
    if (outPoint <= inPoint) { showError(trimError, "Out point must be after in point."); return; }
    if (!currentFileId) { showError(trimError, "No file loaded."); return; }
    const filename = outFilenameInput.value.trim() || defaultClipName(currentOrigName, clipIndex);

    if (selectedQueueIdx !== null) {
      // Update existing queue item in place (or stage a draft)
      const wasDraft = !!clipQueue[selectedQueueIdx].draft;
      clipQueue[selectedQueueIdx] = { ...clipQueue[selectedQueueIdx], start: inPoint, end: outPoint, filename };
      delete clipQueue[selectedQueueIdx].draft; // staging always clears draft flag
      const idx = selectedQueueIdx;
      logAppend("INFO", wasDraft
        ? `Draft ${idx + 1} staged: ${fmtTime(inPoint)} → ${fmtTime(outPoint)}`
        : `Clip ${idx + 1} updated: ${fmtTime(inPoint)} → ${fmtTime(outPoint)}`);
      // Auto-advance to the next clip for this file so user can review/edit it
      // (prevents accidentally re-adding the same clip as a new entry)
      const nextIdx = clipQueue.findIndex((c, i) =>
        i > idx && !c.loading && !c.error && c.file_id === currentFileId
      );
      if (nextIdx !== -1) {
        const next = clipQueue[nextIdx];
        selectedQueueIdx = nextIdx;
        inPoint = next.start; outPoint = next.end;
        inTimeInput.value  = fmtTime(inPoint);
        outTimeInput.value = fmtTime(outPoint);
        outFilenameInput.value = next.filename;
        addQueueBtn.textContent = next.draft ? `Stage Draft ${nextIdx + 1}` : `Update Clip ${nextIdx + 1}`;
      } else {
        selectedQueueIdx = null;
        addQueueBtn.textContent = "+ Add to Queue";
        outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
      }
    } else {
      const color = CLIP_COLORS[clipQueue.length % CLIP_COLORS.length];
      clipQueue.push({ start: inPoint, end: outPoint, filename, color, file_id: currentFileId });
      logAppend("INFO", `Clip ${clipQueue.length} added: ${fmtTime(inPoint)} → ${fmtTime(outPoint)} → "${filename}"`);
      clipIndex += 1;
      outFilenameInput.value = defaultClipName(currentOrigName, clipIndex);
    }

    updateRangeDisplay();
    drawTimeline();
    renderQueue();
  });

  function splitAtPlayhead() {
    if (!currentFileId) { showError(trimError, "No file loaded."); return; }
    const t = player.currentTime;
    const dur = player.duration || 0;

    // ── Case 1: find a queued clip that contains the playhead ────────────────
    let splitIdx = -1;
    if (selectedQueueIdx !== null) {
      const sel = clipQueue[selectedQueueIdx];
      if (sel && !sel.loading && !sel.error && sel.file_id === currentFileId &&
          t > sel.start + 0.01 && t < sel.end - 0.01) {
        splitIdx = selectedQueueIdx;
      }
    }
    if (splitIdx === -1) {
      splitIdx = clipQueue.findIndex(c =>
        !c.loading && !c.error && c.file_id === currentFileId &&
        t > c.start + 0.01 && t < c.end - 0.01
      );
    }

    if (splitIdx !== -1) {
      // Split the existing queued clip
      const item = clipQueue[splitIdx];
      const ext  = item.filename.match(/\.[^.]+$/)?.[0] ?? ".mp4";
      const stem = item.filename.slice(0, item.filename.length - ext.length);
      const clipA = { ...item, end:   t, filename: `${stem}_a${ext}` };
      const clipB = { ...item, start: t, filename: `${stem}_b${ext}`, draft: true };
      // _b always starts as draft; _a inherits original draft status
      if (!item.draft) delete clipA.draft;
      clipQueue.splice(splitIdx, 1, clipA, clipB);
      selectedQueueIdx = splitIdx;
      inPoint = clipA.start; outPoint = clipA.end;
      inTimeInput.value  = fmtTime(inPoint);
      outTimeInput.value = fmtTime(outPoint);
      outFilenameInput.value = clipA.filename;
      addQueueBtn.textContent = `Update Clip ${splitIdx + 1}`;
      updateRangeDisplay(); drawTimeline(); renderQueue();
      logAppend("INFO", `Split at ${fmtTime(t)}: "${clipA.filename}" + "${clipB.filename}"`);
      return;
    }

    // ── Case 2: no queued clip — split the current in→out selection ──────────
    if (t > inPoint + 0.01 && t < outPoint - 0.01) {
      const filename = outFilenameInput.value.trim() ||
                       (currentOrigName ? currentOrigName.replace(/\.[^.]+$/, ".mp4") : "clip.mp4");
      const ext  = filename.match(/\.[^.]+$/)?.[0] ?? ".mp4";
      const stem = filename.slice(0, filename.length - ext.length);
      const colorA = CLIP_COLORS[clipQueue.length % CLIP_COLORS.length];
      const colorB = CLIP_COLORS[(clipQueue.length + 1) % CLIP_COLORS.length];
      const clipA = { start: inPoint,  end: t,        filename: `${stem}_a${ext}`, color: colorA, file_id: currentFileId };
      const clipB = { start: t,        end: outPoint,  filename: `${stem}_b${ext}`, color: colorB, file_id: currentFileId, draft: true };
      clipQueue.push(clipA, clipB);
      selectedQueueIdx = clipQueue.length - 2;
      inPoint = clipA.start; outPoint = clipA.end;
      inTimeInput.value  = fmtTime(inPoint);
      outTimeInput.value = fmtTime(outPoint);
      outFilenameInput.value = clipA.filename;
      addQueueBtn.textContent = `Update Clip ${selectedQueueIdx + 1}`;
      updateRangeDisplay(); drawTimeline(); renderQueue();
      logAppend("INFO", `Split in→out at ${fmtTime(t)}: "${clipA.filename}" + "${clipB.filename}"`);
      return;
    }

    // ── Nothing to split ─────────────────────────────────────────────────────
    showError(trimError, "Playhead must be inside a queued clip or between In and Out points to split.");
    if (_trimErrorTimer) clearTimeout(_trimErrorTimer);
    _trimErrorTimer = setTimeout(() => clearError(trimError), 4000);
  }

  splitBtn.addEventListener("click", splitAtPlayhead);

  clearQueueBtn.addEventListener("click", () => {
    clipQueue = [];
    selectedQueueIdx = null;
    addQueueBtn.textContent = "+ Add to Queue";
    renderQueue();
    drawTimeline();
    hide(queueProgress);
  });

  uploadQueueBtn.addEventListener("click", () => runUploadQueue(false));

  async function runUploadQueue(retryOnly) {
    if (clipQueue.length === 0) return;
    if (!currentFileId) { showError(trimError, "No file loaded."); return; }
    if (!getOutputFolderId()) { showError(trimError, "Set an output folder before uploading."); return; }
    // Build uploadable list: pairs of {item, qi} so we use the correct queue index in DOM updates
    const uploadable = clipQueue
      .map((item, qi) => ({ item, qi }))
      .filter(({ item }) => !item.loading && !item.error && !item.draft)
      .filter(({ item }) => retryOnly ? !item._uploadOk : true);
    if (uploadable.length === 0) return;
    const uploadFileId = currentFileId;
    uploadQueueBtn.disabled = true;
    clearQueueBtn.disabled = true;
    addQueueBtn.disabled = true;
    trimBtn.disabled = true;
    resetBtn.disabled = true;
    show(queueProgress);
    queueFill.style.width = "0%";
    const total = uploadable.length;
    let done = 0;
    let errorCount = 0;
    try {
      for (const { item, qi } of uploadable) {
        setQueueItemStatus(qi, "running", "Uploading\u2026");
        queueLabel.textContent = `Uploading ${item.filename} (${done + 1} / ${total})\u2026`;
        try {
          const res = await fetch("/api/trim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_id: item.file_id || uploadFileId,
              start: item.start,
              end: item.end,
              output_filename: item.filename,
              output_folder_id: getOutputFolderId(),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Trim failed");
          item._uploadOk = true;
          setQueueItemStatus(qi, "ok", data.url);
        } catch (err) {
          item._uploadOk = false;
          setQueueItemStatus(qi, "err", err.message);
          errorCount++;
        }
        done++;
        queueFill.style.width = `${Math.round((done / total) * 100)}%`;
      }
      if (errorCount === 0) {
        queueLabel.textContent = `\u2713 All ${total} clip${total !== 1 ? "s" : ""} uploaded!`;
        clipQueue = [];
        selectedQueueIdx = null;
        addQueueBtn.textContent = "+ Add to Queue";
        renderQueue(); // clear queue list — stale disabled items would block further editing
        logAppend("INFO", `Queue upload complete: ${total} clip${total !== 1 ? "s" : ""} uploaded.`);
      } else {
        // Show Retry Failed button alongside the status text
        queueLabel.innerHTML = `Done \u2014 ${total - errorCount} ok, <span style="color:var(--danger)">${errorCount} failed</span>. ` +
          `<button id="retry-failed-btn" class="small secondary" style="margin-left:0.5rem">Retry Failed (${errorCount})</button>`;
        document.getElementById("retry-failed-btn")?.addEventListener("click", () => runUploadQueue(true));
        logAppend("WARN", `Queue upload done: ${total - errorCount} ok, ${errorCount} failed.`);
      }
    } finally {
      // Always re-enable buttons, even if an unexpected exception escapes the loop
      uploadQueueBtn.disabled = false;
      clearQueueBtn.disabled = false;
      addQueueBtn.disabled = false;
      trimBtn.disabled = false;
      resetBtn.disabled = false;
    }
  }

  async function unloadCurrent() {
    if (!currentFileId) return;
    _loadedFileIds.delete(currentFileId);
    await fetch(`/api/unload/${currentFileId}`, { method: "POST" }).catch(() => {});
    currentFileId = null;
    currentOrigName = null;
    keyframeTimes = [];
    _waveData = null;
    _waveFileId = null;
    cancelAnimationFrame(rafId);
    tlZoom = 1; tlOffset = 0;
    tlUpdateScrollbar();
  }

  async function resetToLoad() {
    clearTimeout(_stallTimer);
    _playerResetting = true;
    player.removeAttribute("src");
    player.load();
    _playerResetting = false;

    // Clean up WebCodecs
    if (WCReverse.supported) WCReverse.stop();
    _wcReady     = false;
    _wcScrubTime = 0;
    scrubCanvas.style.display = "none";

    fileOrigNames.clear();

    // Unload all server-resident files except currentFileId (handled by unloadCurrent below)
    for (const fid of _loadedFileIds) {
      if (fid !== currentFileId) {
        fetch(`/api/unload/${fid}`, { method: "POST" }).catch(() => {});
      }
    }
    _loadedFileIds.clear();
    _batchMode = false;

    await unloadCurrent();
    clipIndex = 1;
    inPoint = 0;
    outPoint = 0;
    driveUrl.value = "";
    inTimeInput.value = "";
    outTimeInput.value = "";
    outFilenameInput.value = "";
    addQueueBtn.textContent = "+ Add to Queue";
    clearError(loadError);
    clearError(trimError);
    clipQueue = [];
    selectedQueueIdx = null;
    renderQueue();
    hide(successToast);
    hide(bufferBarWrap);
    hide(queueProgress);
    hide(spinnerPanel);
    hide(editorPanel);
    ctx.clearRect(0, 0, timeline.width, timeline.height);
    show(loadPanel);
  }

  resetBtn.addEventListener("click", resetToLoad);

  // "+ Load Another Clip" — show load panel without wiping the queue
  async function addAnotherClip() {
    player.pause();
    clearError(loadError);
    show(loadPanel);
    loadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const addClipBtn = document.getElementById("add-clip-btn");
  if (addClipBtn) addClipBtn.addEventListener("click", addAnotherClip);

  reloadBtn.addEventListener("click", () => {
    if (!currentFileId) return;
    const resumeAt = player.currentTime || 0;
    logAppend("INFO", "Reloading video stream…");
    clearTimeout(_stallTimer);
    _stallTimer = null;
    _decodeRecoveries = 0;
    _playerResetting = true;
    player.removeAttribute("src");
    player.load();
    player.src = `/api/video/${currentFileId}`;
    player.load();
    player.addEventListener("loadedmetadata", () => {
      _playerResetting = false;
      player.currentTime = resumeAt;
      drawTimeline();
    }, { once: true });
    player.addEventListener("error", () => { _playerResetting = false; }, { once: true });
  });

  // ── Global hotkey handler ─────────────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const k = e.key;
    if (k === "Escape" && !hotkeysPanel.classList.contains("hidden")) { hotkeysPanel.classList.add("hidden"); return; }
    // Shift+J = set in point, Shift+L = set out point
    if (k === "J") { e.preventDefault(); setInPoint(); return; }
    if (k === "L") { e.preventDefault(); setOutPoint(); return; }
    // Alt+J = step back 1 frame, Alt+L = step forward 1 frame
    if (e.altKey && k === "j") { e.preventDefault(); if (player.duration) player.currentTime = Math.max(0, player.currentTime - _JKL_FRAME); return; }
    if (e.altKey && k === "l") { e.preventDefault(); if (player.duration) player.currentTime = Math.min(player.duration, player.currentTime + _JKL_FRAME); return; }
    // JKL shuttle (fixed, not remappable)
    if (!e.altKey && (k === "j" || k === "k" || k === "l")) { e.preventDefault(); handleJKL(k, e.repeat); return; }
    if (k === "h") { e.preventDefault(); _jklJumpBack1s(); return; }
    if (k === hotkeys.playPause)  { e.preventDefault(); togglePlay(); }
    else if (k === hotkeys.mute)       { e.preventDefault(); toggleMute(); }
    else if (k === hotkeys.fullscreen) { e.preventDefault(); toggleFullscreen(); }
    else if (k === hotkeys.setIn)      { e.preventDefault(); setInPoint(); }
    else if (k === hotkeys.setOut)     { e.preventDefault(); setOutPoint(); }
    else if (k === hotkeys.split)      { e.preventDefault(); splitAtPlayhead(); }
    else if (k === hotkeys.seekBack)   { e.preventDefault(); player.currentTime = Math.max(0, player.currentTime - 5); }
    else if (k === hotkeys.seekFwd)    { e.preventDefault(); player.currentTime = Math.min(player.duration || 0, player.currentTime + 5); }
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "j" && !e.altKey) _jklStopScrub(); // release j → stop backward scrub
    if (e.key === "l") _lStopHoldRamp();              // release l → stop forward ramp
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  checkAuth();

})();
