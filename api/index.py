import os
import sys
from pathlib import Path

# Add project root to sys.path
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# On Vercel serverless environment, use /tmp/setu.db for writable SQLite
if os.environ.get("VERCEL"):
    tmp_db = Path("/tmp/setu.db")
    if not tmp_db.exists() and (ROOT / "setu.db").exists():
        import shutil
        try:
            shutil.copy(ROOT / "setu.db", tmp_db)
        except Exception:
            pass
    os.environ["SETU_DB_PATH"] = str(tmp_db)

from backend.app import app
