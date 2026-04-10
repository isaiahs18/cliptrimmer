/**
 * WebCodecs-based reverse playback for clip-trimmer.
 *
 * The server provides two endpoints used here:
 *   GET /api/codec-desc/{fileId}  → {codec, desc_b64, width, height}
 *   GET /api/frames/{fileId}      → {frames: [[t, pos, size, key], ...]}
 *
 * Public API (window.WCReverse):
 *   .supported                     → bool
 *   .init(fileId, canvas)          → Promise<bool>
 *   .startReverse(currentTime, onStep) → Promise<void>
 *   .stop()                        → void
 *   .seekFrame(t)                  → Promise<void>
 */
(function () {
  "use strict";

  const supported = typeof VideoDecoder !== "undefined";

  // ── Module state ────────────────────────────────────────────────────────────
  let _fileId = null;
  let _canvas = null;
  let _ctx    = null;
  let _w      = 0;
  let _h      = 0;
  let _codec  = null;   // e.g. "avc1.640028"
  let _desc   = null;   // Uint8Array — AVCDecoderConfigurationRecord

  // Frame table: [[t_secs, byte_pos, byte_size, is_key(0|1)], ...]
  // Sorted by t (DTS/file order from ffprobe).
  let _frames = null;

  // GOP index: [{s: startFrameIdx, e: endFrameIdx}, ...]
  let _gops = null;

  let _ready = false;

  // ── Playback state ──────────────────────────────────────────────────────────
  let _active    = false;
  let _rafId     = null;
  let _gopFrames = [];  // VideoFrame[] for the current GOP (sorted by PTS)
  let _gopIdx    = -1;  // which _gops[] entry is loaded
  let _frameIdx  = -1;  // position in _gopFrames going backward
  let _onStep    = null;
  let _decoding  = false;

  // ── init ────────────────────────────────────────────────────────────────────
  async function init(fileId, canvas) {
    if (!supported) return false;
    stop();
    _fileId = fileId;
    _canvas = canvas;
    _ctx    = canvas.getContext("2d");
    _ready  = false;

    try {
      const [cd, fr] = await Promise.all([
        fetch(`/api/codec-desc/${fileId}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/frames/${fileId}`).then(r => r.ok ? r.json() : null),
      ]);

      if (!cd || !cd.codec || !fr || !fr.frames || fr.frames.length === 0) {
        return false;
      }

      _codec = cd.codec;
      _w     = cd.width  || 1920;
      _h     = cd.height || 1080;

      // Decode base64 description bytes
      const bin = atob(cd.desc_b64);
      _desc = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) _desc[i] = bin.charCodeAt(i);

      _frames = fr.frames; // [[t, pos, size, key], ...]

      // Build GOP index: each GOP starts with a keyframe (key===1)
      _gops = [];
      let s = 0;
      for (let i = 1; i <= _frames.length; i++) {
        if (i === _frames.length || _frames[i][3] === 1) {
          _gops.push({ s, e: i - 1 });
          s = i;
        }
      }

      // Set canvas intrinsic resolution to match video
      canvas.width  = _w;
      canvas.height = _h;

      // Verify the browser can handle this codec + description
      const cfg = { codec: _codec, description: _desc };
      const support = await VideoDecoder.isConfigSupported(cfg);
      if (!support.supported) return false;

      _ready = true;
      return true;
    } catch (err) {
      console.warn("[WCReverse] init failed:", err);
      return false;
    }
  }

  // ── GOP helpers ─────────────────────────────────────────────────────────────

  // Binary search: return index of the last GOP whose keyframe time ≤ t.
  function _gopAt(t) {
    if (!_gops || _gops.length === 0) return -1;
    let lo = 0, hi = _gops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (_frames[_gops[mid].s][0] <= t) lo = mid; else hi = mid - 1;
    }
    return (_frames[_gops[lo].s][0] <= t) ? lo : -1;
  }

  // Range-fetch one GOP and decode all its frames with VideoDecoder.
  // Returns VideoFrame[] sorted by PTS (ready for backward display).
  async function _decodeGop(gopIdx) {
    const gop   = _gops[gopIdx];
    const first = _frames[gop.s]; // [t, pos, size, key]
    const last  = _frames[gop.e];

    const rangeStart = first[1];
    const rangeEnd   = last[1] + last[2] - 1;

    const resp = await fetch(`/api/video/${_fileId}`, {
      headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Range fetch HTTP ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();

    const decoded = [];
    const decoder = new VideoDecoder({
      output: f  => decoded.push(f),
      error:  e  => console.warn("[WCReverse] VideoDecoder error:", e),
    });

    decoder.configure({
      codec:              _codec,
      description:        _desc,
      optimizeForLatency: false,
    });

    for (let i = gop.s; i <= gop.e; i++) {
      const f      = _frames[i]; // [t, pos, size, key]
      const offset = f[1] - rangeStart;
      decoder.decode(new EncodedVideoChunk({
        type:      f[3] ? "key" : "delta",
        timestamp: Math.round(f[0] * 1_000_000), // PTS in µs
        data:      new Uint8Array(buf, offset, f[2]),
      }));
    }

    await decoder.flush();
    decoder.close();

    // Sort by PTS so index 0 = earliest frame, last = latest
    decoded.sort((a, b) => a.timestamp - b.timestamp);
    return decoded;
  }

  function _freeGopFrames() {
    for (const f of _gopFrames) { try { f.close(); } catch (_) {} }
    _gopFrames = [];
  }

  // ── stop ────────────────────────────────────────────────────────────────────
  function stop() {
    _active   = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _freeGopFrames();
    _gopIdx   = -1;
    _frameIdx = -1;
    _decoding = false;
    _onStep   = null;
  }

  // ── rAF loop ─────────────────────────────────────────────────────────────────
  function _rafStep() {
    if (!_active) return;

    if (_frameIdx < 0) {
      // Current GOP exhausted — load the previous one
      if (_gopIdx <= 0) {
        // Hit the very start of the video
        stop();
        return;
      }
      if (_decoding) {
        // Wait for ongoing decode to finish
        _rafId = requestAnimationFrame(_rafStep);
        return;
      }
      // Kick async decode of the previous GOP
      _decoding = true;
      const prevIdx = _gopIdx - 1;
      _decodeGop(prevIdx)
        .then(frames => {
          if (!_active) {
            for (const f of frames) { try { f.close(); } catch (_) {} }
            _decoding = false;
            return;
          }
          _freeGopFrames();
          _gopFrames = frames;
          _gopIdx    = prevIdx;
          _frameIdx  = frames.length - 1;
          _decoding  = false;
          _rafId = requestAnimationFrame(_rafStep);
        })
        .catch(err => {
          console.warn("[WCReverse] GOP load error:", err);
          _decoding = false;
          stop();
        });
      return;
    }

    // Draw the next frame in reverse
    const frame = _gopFrames[_frameIdx--];
    _ctx.drawImage(frame, 0, 0, _canvas.width, _canvas.height);
    const t = frame.timestamp / 1_000_000; // µs → seconds
    frame.close();

    if (_onStep) _onStep(t);
    _rafId = requestAnimationFrame(_rafStep);
  }

  // ── startReverse ────────────────────────────────────────────────────────────
  // Decode the GOP that contains `currentTime`, then play backward frame-by-frame.
  // `onStep(t_seconds)` is called for each rendered frame.
  async function startReverse(currentTime, onStep) {
    if (!_ready) return;
    stop();
    _active = true;
    _onStep = onStep;

    const gi = _gopAt(currentTime);
    if (gi < 0) { _active = false; return; }

    try {
      const frames = await _decodeGop(gi);
      if (!_active) {
        for (const f of frames) { try { f.close(); } catch (_) {} }
        return;
      }

      _gopFrames = frames;
      _gopIdx    = gi;

      // Find the starting frame: last frame with PTS ≤ currentTime
      const tUs = currentTime * 1_000_000;
      let fi = frames.length - 1;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].timestamp > tUs) { fi = Math.max(0, i - 1); break; }
      }
      _frameIdx = fi;

      _rafId = requestAnimationFrame(_rafStep);
    } catch (err) {
      console.warn("[WCReverse] startReverse error:", err);
      _active = false;
    }
  }

  // ── seekFrame ───────────────────────────────────────────────────────────────
  // Decode the GOP that contains `t` and draw the single closest frame.
  async function seekFrame(t) {
    if (!_ready) return;
    const gi = _gopAt(t);
    if (gi < 0) return;

    try {
      const frames = await _decodeGop(gi);
      const tUs  = t * 1_000_000;
      let best   = frames[0];
      for (const f of frames) {
        if (Math.abs(f.timestamp - tUs) < Math.abs(best.timestamp - tUs)) best = f;
      }
      _ctx.drawImage(best, 0, 0, _canvas.width, _canvas.height);
      for (const f of frames) { try { f.close(); } catch (_) {} }
    } catch (err) {
      console.warn("[WCReverse] seekFrame error:", err);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.WCReverse = { supported, init, startReverse, seekFrame, stop };
})();
