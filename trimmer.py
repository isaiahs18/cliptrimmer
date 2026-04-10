import subprocess
import uuid
from pathlib import Path

TEMP_DIR = Path("/tmp/cliptrimmer")


def trim(input_path: Path, start: float, end: float) -> Path:
    """
    Trim a video using FFmpeg stream copy (no re-encode, zero quality loss).
    The cut aligns to the nearest preceding keyframe — correct for H.264.
    Returns the path of the trimmed output file.
    """
    stem = input_path.stem
    suffix = input_path.suffix or ".mp4"
    uid = uuid.uuid4().hex[:8]
    output_path = TEMP_DIR / f"{stem}_{uid}{suffix}"

    cmd = [
        "ffmpeg",
        "-y",                      # overwrite if exists
        "-ss", str(start),         # seek BEFORE input (fast, keyframe-accurate)
        "-to", str(end),
        "-i", str(input_path),
        "-c", "copy",              # stream copy — no re-encode
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",   # move moov atom to front for instant streaming
        str(output_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg timed out after 120s — process killed")

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{result.stderr}")

    return output_path


def concat(clip_paths: list[Path]) -> Path:
    """
    Concatenate pre-trimmed clip files using the FFmpeg concat demuxer.
    All clips must share the same codec/resolution (stream-copy, no re-encode).
    Returns the path of the concatenated output file.
    """
    if not clip_paths:
        raise RuntimeError("concat() called with empty clip list")

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    uid = uuid.uuid4().hex[:8]
    suffix = clip_paths[0].suffix or ".mp4"
    list_path  = TEMP_DIR / f"concat_{uid}.txt"
    output_path = TEMP_DIR / f"joined_{uid}{suffix}"

    # Write concat list file (ffmpeg safe format)
    with open(list_path, "w") as fh:
        for p in clip_paths:
            # Escape single quotes in path by ending the string, inserting \', reopening
            escaped = str(p).replace("'", "'\\''")
            fh.write(f"file '{escaped}'\n")

    cmd = [
        "ffmpeg",
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c", "copy",
        "-movflags", "+faststart",
        str(output_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg concat timed out after 300s")
    finally:
        list_path.unlink(missing_ok=True)

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg concat failed:\n{result.stderr}")

    return output_path
