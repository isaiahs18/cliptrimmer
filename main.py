import subprocess
import json as _json
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

@app.post("/api/unload/{file_id}")
def unload_by_id(file_id: str):
    session = _sessions.pop(file_id, None)
    _load_progress.pop(file_id, None)
    if session:
        drive.cleanup(file_id, session["filename"])
    return {"ok": True}


# ── Static files ───────────────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
