import re
from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
from auth import get_credentials

TEMP_DIR = Path("/tmp/cliptrimmer")
TEMP_DIR.mkdir(parents=True, exist_ok=True)


def _service():
    creds = get_credentials()
    if not creds:
        raise RuntimeError("Not authenticated")
    return build("drive", "v3", credentials=creds)


def parse_folder_id(url_or_id: str) -> str:
    """Extract a Drive folder ID from a folder URL or return the raw ID."""
    match = re.search(r"/folders/([a-zA-Z0-9_-]+)", url_or_id)
    if match:
        return match.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", url_or_id.strip()):
        return url_or_id.strip()
    raise ValueError(f"Could not parse a Drive folder ID from: {url_or_id!r}")


def parse_file_id(url_or_id: str) -> str:
    """Extract a Drive file ID from a share URL or return the raw ID."""
    patterns = [
        r"/file/d/([a-zA-Z0-9_-]+)",
        r"[?&]id=([a-zA-Z0-9_-]+)",
        r"open\?id=([a-zA-Z0-9_-]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    # Assume raw ID if it looks like one
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", url_or_id.strip()):
        return url_or_id.strip()
    raise ValueError(f"Could not parse a Drive file ID from: {url_or_id!r}")


def get_file_metadata(file_id: str) -> dict:
    svc = _service()
    return svc.files().get(
        fileId=file_id,
        fields="id,name,mimeType,parents,size",
    ).execute()


def download_file(file_id: str, on_progress=None) -> tuple[Path, str]:
    """Download a Drive file to TEMP_DIR. Returns (local_path, filename).
    on_progress(bytes_done, total_bytes) is called after each chunk if provided.
    """
    svc = _service();
    meta = svc.files().get(fileId=file_id, fields="id,name,mimeType,parents,size").execute()
    filename = meta["name"]
    total_bytes = int(meta.get("size") or 0)
    dest = TEMP_DIR / f"{file_id}_{filename}"

    request = svc.files().get_media(fileId=file_id)
    with open(dest, "wb") as fh:
        dl = MediaIoBaseDownload(fh, request, chunksize=16 * 1024 * 1024)
        done = False
        while not done:
            progress, done = dl.next_chunk()
            if on_progress and progress:
                loaded = int(progress.resumable_progress)
                total = progress.total_size or total_bytes
                on_progress(loaded, total)

    return dest, filename


def upload_file(local_path: Path, filename: str, parent_folder_id: str) -> str:
    """Upload a file to Drive in the given parent folder. Returns the new file's web URL."""
    svc = _service()
    file_metadata = {
        "name": filename,
        "parents": [parent_folder_id],
    }
    media = MediaFileUpload(str(local_path), mimetype="video/mp4", resumable=True)
    file = svc.files().create(
        body=file_metadata,
        media_body=media,
        fields="id,webViewLink",
    ).execute()
    return file.get("webViewLink", f"https://drive.google.com/file/d/{file['id']}/view")


def cleanup(file_id: str, filename: str):
    """Remove all temp files associated with a file_id."""
    for p in TEMP_DIR.glob(f"{file_id}_*"):
        p.unlink(missing_ok=True)


def list_folder(folder_id: str) -> list[dict]:
    """Return ALL video files in a Drive folder, newest first (handles pagination)."""
    svc = _service()
    files = []
    page_token = None
    while True:
        kwargs = dict(
            q=f"'{folder_id}' in parents and mimeType contains 'video/' and trashed=false",
            fields="nextPageToken,files(id,name,mimeType,size,modifiedTime)",
            orderBy="modifiedTime desc",
            pageSize=200,
        )
        if page_token:
            kwargs["pageToken"] = page_token
        results = svc.files().list(**kwargs).execute()
        files.extend(results.get("files", []))
        page_token = results.get("nextPageToken")
        if not page_token:
            break
    return files
