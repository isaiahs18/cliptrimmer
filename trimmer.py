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
