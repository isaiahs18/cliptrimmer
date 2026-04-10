import os
from pathlib import Path
from dotenv import load_dotenv
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from fastapi import APIRouter, Request as FastAPIRequest
from fastapi.responses import RedirectResponse, JSONResponse, HTMLResponse

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
TOKEN_FILE = Path("token.json")
REDIRECT_URI = os.environ.get("REDIRECT_URI", "http://localhost:8080/auth/callback")

router = APIRouter()


def _client_config():
    return {
        "installed": {
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [REDIRECT_URI],
        }
    }


def get_credentials() -> Credentials | None:
    if not TOKEN_FILE.exists():
        return None
    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())
    if creds and creds.valid:
        return creds
    return None


def _make_flow(state: str | None = None) -> Flow:
    return Flow.from_client_config(
        _client_config(),
        scopes=SCOPES,
        state=state,
        redirect_uri=REDIRECT_URI,
    )


@router.get("/auth/login")
def login():
    flow = _make_flow()
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    Path(".oauth_state").write_text(state)
    return RedirectResponse(auth_url)


@router.get("/auth/callback")
def callback(request: FastAPIRequest, code: str | None = None, state: str | None = None, error: str | None = None):
    # Google returned an error (e.g. user denied, redirect URI mismatch)
    if error:
        return HTMLResponse(
            f"<h2>Google auth error: {error}</h2>"
            f"<p>Make sure <code>http://localhost:8080/auth/callback</code> is added as an "
            f"Authorized Redirect URI in your Google Cloud Console credentials, then "
            f"<a href='/auth/login'>try again</a>.</p>",
            status_code=400,
        )

    if not code or not state:
        return HTMLResponse(
            "<h2>Missing auth parameters</h2>"
            "<p><a href='/auth/login'>Try again</a></p>",
            status_code=400,
        )

    saved_state = Path(".oauth_state").read_text().strip() if Path(".oauth_state").exists() else None
    if saved_state != state:
        return JSONResponse({"error": "State mismatch — possible CSRF"}, status_code=400)

    flow = _make_flow(state=state)
    flow.fetch_token(code=code)
    creds = flow.credentials
    TOKEN_FILE.write_text(creds.to_json())
    Path(".oauth_state").unlink(missing_ok=True)
    return RedirectResponse("/?authed=1")


@router.get("/auth/status")
def auth_status():
    creds = get_credentials()
    return {"authenticated": creds is not None}


@router.get("/auth/logout")
def logout():
    TOKEN_FILE.unlink(missing_ok=True)
    return {"ok": True}
