# Paper Gist

Fetches the latest **Large Language Model** papers from arXiv and turns each
paper's *Introduction* into a compact, structured **learning note** using
Groq, then publishes everything as a static GitHub Pages site.

- 🔎 Pulls the 100 latest papers matching `"large language model"`.
- 🧠 Generates a Markdown learning note (problem, prior work, comparison
  table, timeline, open questions, where-this-fits) for up to **10 new papers**
  per run.
- 🧬 **Deduplicates by arXiv id** — papers already in `site/data.json` are never
  reprocessed.
- 📅 Schedules an update **every 4 hours** via GitHub Actions.
- 🚀 Publishes to **GitHub Pages** automatically.

```
site/            → the static website (deployed to Pages)
  index.html
  app.js
  style.css
  data.json      → generated store of papers + learning notes
pipeline.py      → fetch → dedupe → gist → citations → merge → write
paper_Read-v2.ipynb → original Jupyter pipeline
.github/workflows/ → automation
```

## How it works

On a schedule (and on manual dispatch), `update-papers.yml`:

1. Fetches the 100 latest `"large language model"` papers from arXiv.
2. Filters out any arXiv id already present in `site/data.json`.
3. For up to 10 of the *new* papers: downloads the source, extracts the
   `\section{Introduction}`, asks Groq for a learning note, and reads a
   citation count from OpenAlex.
4. Merges everything into `site/data.json`, deduplicated and sorted newest-first.
5. **Only commits if `data.json` actually changed** — if no new papers appeared,
   nothing is committed.

Pushing `site/data.json` to `main` triggers `deploy-pages.yml`, which publishes
the `site/` folder to GitHub Pages.

## Setup (one time)

### 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/paper-gist.git
git push -u origin main
```

### 2. Add the Groq API key as a secret

Generating learning notes calls the Groq API, which needs a key:

1. Get a key from <https://console.groq.com/keys>.
2. In your repo go to **Settings → Secrets and variables → Actions**.
3. **New repository secret** → name `GROQ_API_KEY`, paste the key.

> ⚠️ Never hardcode the key in a file. It is read from the secret so it never
> lands in the repository or in commit history.

### 3. Enable GitHub Pages

1. Go to **Settings → Pages**.
2. Under **Source**, choose **GitHub Actions**.
3. The action will deploy automatically; your site appears at
   `https://<you>.github.io/paper-gist/`.

### 4. Run once right away (optional)

Wait for the schedule, or trigger the **Update Papers** workflow manually from
the **Actions** tab.

## Running locally

```bash
pip install -r requirements.txt
export GROQ_API_KEY="gsk_..."
python pipeline.py --fetch 100 --new 10
cd site && python3 -m http.server 8000
```

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--fetch` | `100` | how many latest papers to pull from arXiv |
| `--new` | `10` | how many **new** papers to build notes for |
| `--groq-key` | `$GROQ_API_KEY` | Groq API key |
| `--s2-key` | — | optional Semantic Scholar key (OpenAlex is primary) |

## Notes on citation counts

Citation counts come from **OpenAlex** (free, no API key). Because the
pipeline targets the *newest* papers, most will legitimately report **0**
citations until the index catches up — running periodically populates them over
time.
