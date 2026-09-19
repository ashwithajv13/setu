# Setu Demo Checklist

## Before the demo

- Start the app with `python -m backend.app`.
- Set `GROQ_API_KEY` only if live classification is part of the pitch.
- Run `python scripts/seed_demo.py` to reset old demo/test rows and create the ten HSR Layout complaints, then refresh the public board.
- Confirm at least one card shows a priority score and one resolved card shows `Verified resolution ledger`.
- Record a backup video of the full flow.

## 90-second walkthrough

1. Open the public board and point out priority, status, SLA, and verification.
2. Submit a new report with category, description, photo, and location.
3. Explain that the report is stored locally when offline and syncs when connectivity returns.
4. Show the report on the board with its priority score.
5. Mark it resolved with a proof photo.
6. Refresh and show the verified resolution ledger badge.

## Recovery plan

- If the microphone fails, type the description.
- If Wi-Fi fails, demonstrate the offline saved message and continue from the seeded board.
- If the live API fails, use the backup video.
- Do not add features during the demo; return to the seeded board and follow the script.
