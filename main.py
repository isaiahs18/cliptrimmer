import subprocess
import json as _json
import struct
import base64
import threading
from pathlib import Path
from fastapi import FastAPI, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional

import auth
import drive
import trimmer

load_dotenv()

app = FastAPI(title="Clip Trimmer")
app.include_router(auth.router)

# ── Shared state ──────────────────────────────────────────────────────────────

# file_id -> {filename, local_path, parent_folder_id}
_sessions: dict[str, dict] = {}

# file_id -> {phase, bytes_done, total_bytes, done, error, filename}
_load_progress: dict[str, dict] = {}

# Max 2 simultaneous ffmpeg trim jobs
_trim_semaphore = threading.Semaphore(2)


# ── Request models ─────────────────────────────────────────────────────────────

class LoadRequest(BaseModel):
    url: str


class TrimRequest(BaseModel):
    file_id: str
    start: float
    end: float
    output_filename: Optional[str] = None
    output_folder_id: Optional[str] = None


class ConcatClip(BaseModel):
    file_id: str
    start: float
    end: float


class ConcatRequest(BaseModel):
    clips: list[ConcatClip]
    output_filename: Optional[str] = None
    output_folder_id: Optional[str] = None


# ── Folder listing ─────────────────────────────────────────────────────────────

@app.get("/api/folder")
def folder_list(folder_url: str):
    creds = auth.get_credentials()
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated with Google Drive")
    try:
        folder_id = drive.parse_folder_id(folder_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        files = drive.list_folder(folder_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not list folder: {e}")
    return {"folder_id": folder_id, "files": files}


# ── Load: background download with progress ────────────────────────────────────

def _background_download(file_id: str, meta: dict):
    prog = _load_progress[file_id]
    filename = meta["name"]
    parent_folder_id = meta.get("parents", [None])[0]

    def on_progress(bytes_done: int, total_bytes: int):
        prog["bytes_done"] = bytes_done
        prog["total_bytes"] = total_bytes

    try:
        local_path, _ = drive.download_file(file_id, on_progress=on_progress)
    except Exception as e:
        prog["error"] = f"Download failed: {e}"
        prog["done"] = True
        return

    _sessions[file_id] = {
        "filename": filename,
        "local_path": str(local_path),
        "parent_folder_id": parent_folder_id,
    }
    prog["done"] = True


@app.post("/api/load")
def load_start(req: LoadRequest):
    creds = auth.get_credentials()
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated with Google Drive")

    try:
        file_id = drive.parse_file_id(req.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if file_id in _sessions:
        sess = _sessions[file_id]
        return {"file_id": file_id, "filename": sess["filename"]}

    try:
        meta = drive.get_file_metadata(file_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not access Drive file: {e}")

    if not meta.get("mimeType", "").startswith("video/"):
        raise HTTPException(
            status_code=400,
            detail=f"File is not a video (mimeType: {meta.get('mimeType')})"
        )

    _load_progress[file_id] = {
        "bytes_done": 0,
        "total_bytes": int(meta.get("size") or 0),
        "done": False,
        "error": None,
        "filename": meta["name"],
    }

    t = threading.Thread(target=_background_download, args=(file_id, meta), daemon=True)
    t.start()

    return {"file_id": file_id, "filename": meta["name"]}


@app.get("/api/load_progress/{file_id}")
def load_progress(file_id: str):
    prog = _load_progress.get(file_id)
    if not prog:
        if file_id in _sessions:
            return {"done": True, "error": None, "bytes_done": 0, "total_bytes": 0,
                    "filename": _sessions[file_id]["filename"]}
        raise HTTPException(status_code=404, detail="No load in progress for this file_id")
    return prog


# ── Video streaming ────────────────────────────────────────────────────────────

@app.get("/api/video/{file_id}")
def stream_video(file_id: str, range: Optional[str] = Header(default=None)):
    session = _sessions.get(file_id)
    if not session:
        prog = _load_progress.get(file_id, {})
        if prog.get("error"):
            raise HTTPException(status_code=500, detail=prog["error"])
        raise HTTPException(status_code=404, detail="File not loaded yet")

    path = Path(session["local_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Local file not found")

    file_size = path.stat().st_size
    start, end = 0, file_size - 1

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
    }

    if range:
        try:
            range_val = range.replace("bytes=", "")
            parts = range_val.split("-")
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else file_size - 1
        except (ValueError, IndexError):
            raise HTTPException(status_code=416, detail="Invalid Range header")

    chunk_size = end - start + 1
    headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    headers["Content-Length"] = str(chunk_size)

    def iterfile():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            buf = 1024 * 1024 * 4
            while remaining > 0:
                read = f.read(min(buf, remaining))
                if not read:
                    break
                remaining -= len(read)
                yield read

    status = 206 if range else 200
    return StreamingResponse(iterfile(), status_code=status, headers=headers)


# ── Trim & upload ──────────────────────────────────────────────────────────────

@app.post("/api/trim")
def trim_and_upload(req: TrimRequest):
    session = _sessions.get(req.file_id)
    if not session:
        raise HTTPException(status_code=404, detail="File not loaded — call /api/load first")

    if req.start < 0 or req.end <= req.start:
        raise HTTPException(status_code=400, detail="Invalid start/end times")

    if req.output_filename and "\x00" in req.output_filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    input_path = Path(session["local_path"])
    orig_name = Path(session["filename"])

    if req.output_filename and req.output_filename.strip():
        custom = Path(req.output_filename.strip())
        trimmed_filename = custom.stem + orig_name.suffix
    else:
        trimmed_filename = f"{orig_name.stem}_trimmed{orig_name.suffix}"

    parent = req.output_folder_id or session["parent_folder_id"]
    if not parent:
        raise HTTPException(status_code=400,
                            detail="Could not determine an output Drive folder. Set a clips output folder on the load screen.")

    if not _trim_semaphore.acquire(timeout=120):
        raise HTTPException(status_code=503, detail="Trim queue full — two jobs already running. Try again in a moment.")
    trimmed_path = None
    try:
        trimmed_path = trimmer.trim(input_path, req.start, req.end)
        web_url = drive.upload_file(trimmed_path, trimmed_filename, parent)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    finally:
        _trim_semaphore.release()
        if trimmed_path:
            trimmed_path.unlink(missing_ok=True)

    return {"ok": True, "url": web_url, "filename": trimmed_filename}


# ── Concat & upload ────────────────────────────────────────────────────────────

@app.post("/api/concat")
def concat_and_upload(req: ConcatRequest):
    if not req.clips:
        raise HTTPException(status_code=400, detail="No clips provided")
    if len(req.clips) > 50:
        raise HTTPException(status_code=400, detail="Too many clips (max 50)")

    if req.output_filename and "\x00" in req.output_filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Resolve all sessions up front so we fail fast before any ffmpeg work
    sessions = []
    for clip in req.clips:
        session = _sessions.get(clip.file_id)
        if not session:
            raise HTTPException(status_code=404,
                                detail=f"File not loaded: {clip.file_id}")
        if clip.start < 0 or clip.end <= clip.start:
            raise HTTPException(status_code=400,
                                detail=f"Invalid start/end for clip {clip.file_id}")
        sessions.append(session)

    # Determine output folder from first clip's parent
    parent = req.output_folder_id or sessions[0]["parent_folder_id"]
    if not parent:
        raise HTTPException(status_code=400,
                            detail="Could not determine output folder. Set a clips output folder.")

    orig_name = Path(sessions[0]["filename"])
    if req.output_filename and req.output_filename.strip():
        custom = Path(req.output_filename.strip())
        out_filename = custom.stem + orig_name.suffix
    else:
        out_filename = f"{orig_name.stem}_joined{orig_name.suffix}"

    if not _trim_semaphore.acquire(timeout=120):
        raise HTTPException(status_code=503, detail="Trim queue full — try again in a moment.")

    temp_clips: list[Path] = []
    concat_path = None
    try:
        # Trim each segment to a temp file
        for clip, session in zip(req.clips, sessions):
            p = trimmer.trim(Path(session["local_path"]), clip.start, clip.end)
            temp_clips.append(p)

        concat_path = trimmer.concat(temp_clips)
        web_url = drive.upload_file(concat_path, out_filename, parent)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Concat failed: {e}")
    finally:
        _trim_semaphore.release()
        for p in temp_clips:
            p.unlink(missing_ok=True)
        if concat_path:
            concat_path.unlink(missing_ok=True)

    return {"ok": True, "url": web_url, "filename": out_filename}


# ── File metadata (duration via ffprobe) ──────────────────────────────────────

@app.get("/api/metadata/{file_id}")
def get_metadata(file_id: str):
    session = _sessions.get(file_id)
    if not session:
        raise HTTPException(status_code=404, detail="File not loaded")
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format",
         session["local_path"]],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail="ffprobe failed")
    fmt = _json.loads(result.stdout).get("format", {})
    return {"duration": float(fmt.get("duration") or 0), "filename": session["filename"]}


# ── Keyframe timestamps (for timeline overlay) ───────────────────────────────

@app.get("/api/keyframes/{file_id}")
def get_keyframes(file_id: str):
    session = _sessions.get(file_id)
    if not session:
        raise HTTPException(status_code=404, detail="File not loaded")
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-select_streams", "v:0",
            "-show_packets",
            "-show_entries", "packet=pts_time,flags",
            "-of", "json",
            session["local_path"],
        ],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail="ffprobe keyframe scan failed")
    packets = _json.loads(result.stdout).get("packets", [])
    keyframes = [
        float(p["pts_time"])
        for p in packets
        if "K" in p.get("flags", "") and p.get("pts_time") not in (None, "N/A")
    ]
    return {"keyframes": keyframes}


# ── Per-frame metadata (WebCodecs reverse scrub) ──────────────────────────────

@app.get("/api/frames/{file_id}")
def get_frames(file_id: str):
    """Return per-packet byte positions, sizes, timestamps, and keyframe flags.
    Used by the WebCodecs-based reverse scrub feature."""
    session = _sessions.get(file_id)
    if not session:
        raise HTTPException(status_code=404, detail="File not loaded")

    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-select_streams", "v:0",
            "-show_packets",
            "-show_entries", "packet=pts_time,pos,size,flags",
            "-of", "csv=p=0",
            session["local_path"],
        ],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail="ffprobe frame scan failed")

    frames = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(",")
        if len(parts) < 4:
            continue
        t_s, pos_s, size_s, flags_s = parts[0], parts[1], parts[2], parts[3]
        if t_s in ("N/A", "") or pos_s in ("N/A", "") or size_s in ("N/A", ""):
            continue
        try:
            frames.append([
                round(float(t_s), 6),
                int(pos_s),
                int(size_s),
                1 if flags_s.startswith("K") else 0,
            ])
        except (ValueError, IndexError):
            continue

    return {"frames": frames}


# ── Codec description (WebCodecs decoder config) ──────────────────────────────

def _find_avcc_bytes(filepath: str) -> bytes | None:
    """Brute-force scan the first 2 MB of an MP4 for the avcC box content."""
    try:
        with open(filepath, "rb") as f:
            data = f.read(2 * 1024 * 1024)
    except OSError:
        return None
    idx = data.find(b"avcC")
    if idx < 4:
        return None
    try:
        box_size = struct.unpack(">I", data[idx - 4 : idx])[0]
    except struct.error:
        return None
    content_end = idx - 4 + box_size
    if content_end > len(data):
        return None
    return data[idx + 4 : content_end]


@app.get("/api/codec-desc/{file_id}")
def get_codec_desc(file_id: str):
    """Return codec string, avcC description bytes (base64), and dimensions.
    Currently supports H.264 only; returns null codec for other formats."""
    session = _sessions.get(file_id)
    if not session:
        raise HTTPException(status_code=404, detail="File not loaded")

    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height",
            "-of", "json",
            session["local_path"],
        ],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail="ffprobe codec scan failed")

    streams = _json.loads(result.stdout).get("streams", [])
    if not streams:
        return {"codec": None, "desc_b64": None, "width": 0, "height": 0}

    s = streams[0]
    width  = s.get("width",  0)
    height = s.get("height", 0)

    if s.get("codec_name") != "h264":
        return {"codec": None, "desc_b64": None, "width": width, "height": height}

    avcc = _find_avcc_bytes(session["local_path"])
    if not avcc or len(avcc) < 4:
        return {"codec": None, "desc_b64": None, "width": width, "height": height}

    # Codec string from AVCDecoderConfigurationRecord bytes 1-3
    codec_str = f"avc1.{avcc[1]:02X}{avcc[2]:02X}{avcc[3]:02X}"

    return {
        "codec":    codec_str,
        "desc_b64": base64.b64encode(avcc).decode(),
        "width":    width,
        "height":   height,
    }


@app.post("/api/unload/{file_id}")
def unload_by_id(file_id: str):
    session = _sessions.pop(file_id, None)
    _load_progress.pop(file_id, None)
    if session:
        drive.cleanup(file_id, session["filename"])
    return {"ok": True}


# ── Static files ───────────────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
