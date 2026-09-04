# Paper Gist

Fetches the latest **Large Language Model** papers from arXiv **live** and lets
you generate a compact, structured **learning note** for any paper **on demand**
using Groq's API.

- 🔎 Pulls the latest 100 papers matching `"large language model"` straight from
  the arXiv API — **no stored data, no `data.json`**.
- 📖 **Lit. Review** button shows the paper's real `\section{Introduction}` —
  extracted verbatim from its TeX source, cleaned for reading.
- 🧠 Generates a Markdown learning note (problem, prior work, comparison table,
  timeline, open questions, where-this-fits) **on the fly** when you click the
  **Learn** button on any paper.
- ⚡ Everything is fetched live; nothing is pre-generated, stored, or baked into
  a JSON file.
- 🚀 Serves via a small Flask API and a vanilla JS frontend. No GitHub Actions,
  no CI, no database.

```
site/              → the static frontend
  index.html
  app.js
  style.css
pipeline.py        → Flask API server (papers + gist + intro endpoints)
```

## How it works

`pipeline.py` runs as a **Flask API server** with four endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/papers` | Fetch the latest papers **live** from the arXiv API |
| `POST` | `/api/gist`  | Generate a learning note for a paper **on demand** via Groq |
| `POST` | `/api/intro` | Return the paper's `\section{Introduction}` verbatim from its TeX source |
| `GET`  | `/api/health` | Health check |

The frontend (`site/app.js`) starts by calling `GET /api/papers` to list all
papers, then each paper card has a **Learn** button. Clicking it calls
`POST /api/gist`, which downloads the paper's TeX source from arXiv, extracts
the `\section{Introduction}`, sends it to Groq, and returns the learning note —
all in real time. The **Lit. Review** button calls `POST /api/intro` instead,
skipping Groq and showing the raw Introduction directly.

There is **no** `data.json` and no batch/pre-generation step.

## Setup (one time)

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Set your Groq API key

```bash
export GROQ_API_KEY="gsk_..."
```

### 3. Run the server

```bash
python pipeline.py
```

This starts the API on `http://127.0.0.1:5000`. The frontend detects localhost
and points at that same server automatically.

### 4. Serve the site

Open `site/index.html` directly in a browser, or serve it:

```bash
cd site && python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## CLI batch mode

A legacy `--cli` mode is retained for pre-generating notes into
`site/data.json` (not used by the live site):

```bash
python pipeline.py --cli --fetch 100 --new 10
```

## Deployment

The API server must be hosted somewhere that supports Python + Flask (e.g.
Render, Railway, Fly.io, a VPS) and must have the `GROQ_API_KEY` set. The
static `site/` folder can be served from anywhere (GitHub Pages, Netlify, etc.)
with the API base URL configured in `site/app.js`. No GitHub Actions, cron jobs,
or CI are required — everything is live and on demand.
