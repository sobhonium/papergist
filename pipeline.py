"""Paper Gist pipeline.

Fetches the latest arXiv papers matching "large language model", dedupes
against the existing site/data.json by arXiv id, generates learning gists
for a configurable number of NEW papers, pulls citation counts from Semantic
Scholar, and merges the results into site/data.json.

Usage:
    python pipeline.py --fetch 100 --new 10
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import arxiv
import requests

SITE_JSON = Path(__file__).resolve().parent / "site" / "data.json"
GROQ_MODEL = "qwen/qwen3.6-27b"

SYSTEM_PROMPT = """You are an expert research tutor who writes for advanced undergraduates.

GOAL: Turn the paper's Introduction into a self-contained learning note
that teaches the reader the *research landscape* behind this work.
Do NOT summarize the paper's results or methodology.

Write the output in **Markdown** with exactly these sections:

# <Domain Label>
One short label (2-5 words) for the sub-field.

## Problem
The core technical question or engineering challenge.
State it in one sentence a non-specialist could parse.

## Prior Work
Major lines of research the Introduction cites.
For each line give: **name or label**, what it assumes, what it achieves,
and one key limitation (only if stated or clearly implied).
Use a sub-heading (###) for each line.

## How Approaches Differ
A comparison table (Markdown table) of at most 4-5 columns and as many
rows as needed. Columns: Approach | Core Idea | Strength | Weakness.
Skip rows whose info is not in the Introduction.

## Timeline of Progress
2-5 numbered steps showing how the field moved forward.
Each step: what changed, why it mattered, and what limitation remained.
Use arrows or dates when available.

## Open Questions
Bulleted list of unsolved problems or weaknesses the Introduction explicitly
mentions as motivation.

## Where This Paper Fits
One short paragraph: which gap(s) does it aim to close, and what is the
core idea of the proposed approach (high-level only).

---
STYLE RULES:
- Write for a reader who knows basic ML but NOT the specific sub-field.
- Explain jargon on first use (in parentheses or a short aside).
- Prefer concrete examples and analogies over abstract statements.
- Name methods, models, and authors when they appear in the text.
- Never invent facts not in the Introduction.
- Keep the total output under 800 words.
"""


# ---------------------------------------------------------------------------
# arXiv fetching
# ---------------------------------------------------------------------------

def arxiv_client():
    return arxiv.Client(page_size=100, delay_seconds=3, num_retries=3)


def fetch_latest_n(max_results=100):
    """Return the latest `max_results` papers matching 'large language model'."""
    client = arxiv_client()
    search = arxiv.Search(
        query='all:"large language model"',
        max_results=max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate,
        sort_order=arxiv.SortOrder.Descending,
    )
    papers = list(client.results(search))
    # arxiv returns newest first; be defensive and sort by published desc.
    papers.sort(key=lambda p: p.published, reverse=True)
    return papers


def paper_to_meta(paper):
    """Convert an arxiv Result into a site record (no gist yet)."""
    return {
        "title": paper.title.strip(),
        "field": "Large Language Models",
        "published": paper.published.isoformat(),
        "url": paper.entry_id,
        "short_id": paper.get_short_id(),
        "summary": paper.summary.strip(),
        "citations": None,
        "has_gist": False,
    }


# ---------------------------------------------------------------------------
# Gist generation (Groq)
# ---------------------------------------------------------------------------

def get_introduction(tex):
    pattern = r"\\section\{Introduction\}(.*?)(?=\\section\{|\Z)"
    match = re.search(pattern, tex, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else None


def download_arxiv_source(arxiv_id, timeout=60):
    url = f"https://export.arxiv.org/e-print/{arxiv_id}"
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def extract_tex_intro(arxiv_id):
    """Download a paper's source and pull its Introduction section."""
    import io
    import tarfile

    source = download_arxiv_source(arxiv_id)
    try:
        tar = tarfile.open(fileobj=io.BytesIO(source), mode="r:*")
    except tarfile.TarError:
        # Not a tar archive: maybe a single .tex file.
        text = source.decode("utf-8", errors="ignore")
        return get_introduction(text)

    for member in tar.getmembers():
        if member.isfile() and member.name.endswith(".tex"):
            try:
                content = tar.extractfile(member).read().decode("utf-8", errors="ignore")
            except Exception:
                continue
            intro = get_introduction(content)
            if intro:
                return intro
    return None


def generate_gist(paper_title, intro, api_key):
    from groq import Groq
    client = Groq(api_key=api_key)
    chat = client.chat.completions.create(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Paper title:\n{paper_title}\n\nIntroduction:\n{intro}"},
        ],
        model=GROQ_MODEL,
        reasoning_effort="none",
    )
    return chat.choices[0].message.content


# ---------------------------------------------------------------------------
# Citations (OpenAlex — free, no API key; fallback to Semantic Scholar)
# ---------------------------------------------------------------------------

def fetch_citations(arxiv_ids, api_key=None, delay=0.5):
    """Fetch citation counts for a list of arXiv ids.

    Uses OpenAlex (no key needed) via the arXiv DOI; falls back to Semantic
    Scholar if a key is provided. Newly submitted papers are usually not yet
    indexed anywhere, so a 0/None result for very fresh papers is expected.
    """
    ids = [i for i in arxiv_ids if i]
    if not ids:
        return {}
    counts = {}

    # Primary: OpenAlex by arXiv DOI.
    for aid in ids:
        try:
            url = f"https://api.openalex.org/works/https://doi.org/10.48550/arxiv.{aid}"
            resp = requests.get(url, timeout=30)
            if resp.status_code == 200:
                counts[aid] = resp.json().get("cited_by_count", 0)
            else:
                counts[aid] = 0
        except Exception as e:
            print(f"  openalex error {aid}: {e}")
            counts[aid] = None
        time.sleep(delay)

    # Fallback: Semantic Scholar for any id OpenAlex did not resolve.
    missing = [aid for aid, c in counts.items() if c is None]
    if missing and api_key:
        for aid in missing:
            try:
                resp = requests.get(
                    f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{aid}",
                    headers={"x-api-key": api_key},
                    params={"fields": "citationCount"},
                    timeout=30,
                )
                if resp.status_code == 200:
                    counts[aid] = resp.json().get("citationCount")
                elif resp.status_code == 429:
                    print(f"  rate-limited (429) for {aid}; sleeping 4s")
                    time.sleep(4)
                    counts[aid] = None
                else:
                    counts[aid] = None
            except Exception as e:
                print(f"  semantic scholar error {aid}: {e}")
                counts[aid] = None
            time.sleep(delay)
    elif missing:
        for aid in missing:
            counts[aid] = 0

    return counts


# ---------------------------------------------------------------------------
# Data store
# ---------------------------------------------------------------------------

def load_store():
    if SITE_JSON.exists():
        try:
            return json.loads(SITE_JSON.read_text())
        except json.JSONDecodeError:
            return []
    return []


def canonical_id(paper_or_rec):
    """Return a version-stripped arXiv id for a Result or a site record."""
    if isinstance(paper_or_rec, str):
        sid = paper_or_rec
    elif hasattr(paper_or_rec, "get_short_id"):
        sid = paper_or_rec.get_short_id()
    else:
        rec = paper_or_rec
        u = (rec.get("url") or "").lower()
        if "arxiv.org/abs/" in u:
            sid = u.split("/abs/")[-1]
        else:
            sid = rec.get("short_id") or ""
    sid = sid.lower().strip()
    # strip trailing version like v1, v2
    return re.sub(r"v\d+$", "", sid) if re.search(r"v\d+$", sid) else sid


def known_ids(store):
    """Set of canonical arXiv ids already present."""
    ids = set()
    for rec in store:
        cid = canonical_id(rec)
        if cid:
            ids.add(cid)
    return ids


def save_store(store):
    SITE_JSON.parent.mkdir(parents=True, exist_ok=True)
    SITE_JSON.write_text(json.dumps(store, indent=2, ensure_ascii=False))
    print(f"Wrote {len(store)} records to {SITE_JSON}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", type=int, default=100, help="number of latest papers to fetch")
    parser.add_argument("--new", type=int, default=10, help="number of new papers to process with gists")
    parser.add_argument("--groq-key", default=None, help="GROQ_API_KEY")
    parser.add_argument("--s2-key", default=None, help="Semantic Scholar API key (optional)")
    args = parser.parse_args()

    groq_key = args.groq_key or __import__("os").environ.get("GROQ_API_KEY")
    if not groq_key:
        print("ERROR: no GROQ_API_KEY provided (use --groq-key or env var).")
        sys.exit(1)

    print(f"Fetching latest {args.fetch} 'large language model' papers...")
    fetched = fetch_latest_n(args.fetch)
    print(f"Fetched {len(fetched)} papers.")

    store = load_store()
    existing = known_ids(store)
    print(f"Existing processed ids in data.json: {len(existing)}")

    # Determine NEW candidates (not yet in store), newest first.
    new_candidates = []
    for p in fetched:
        base = canonical_id(p)
        if base not in existing:
            new_candidates.append((p, base))
    print(f"New papers not in store: {len(new_candidates)}")

    to_process = new_candidates[: args.new]
    print(f"Processing {len(to_process)} new papers with gists + citations.")

    newly_built = []
    for idx, (paper, sid) in enumerate(to_process, 1):
        print(f"\n[{idx}/{len(to_process)}] {paper.title.strip()[:70]}")
        record = paper_to_meta(paper)

        # Citation count first (best-effort).
        cites = fetch_citations([sid], api_key=args.s2_key)
        record["citations"] = cites.get(sid)

        # Gist from the Introduction.
        intro = None
        try:
            intro = extract_tex_intro(sid)
        except Exception as e:
            print(f"  could not download source: {e}")

        if intro:
            try:
                gist = generate_gist(paper.title.strip(), intro, groq_key)
                record["gist"] = gist
                record["has_gist"] = True
            except Exception as e:
                print(f"  gist failed: {e}")
                record["gist"] = None
        else:
            print("  no Introduction extracted; no gist")

        newly_built.append(record)
        existing.add(sid)

    # Merge strategy:
    #   1. Build a map of canonical id -> best record from the existing store.
    #      Prefer records that already carry a gist.
    #   2. Fold in the newly built records (they should win for their ids).
    #   3. For every fetched paper, guarantee one metadata record exists
    #      (so the site lists all 100), merging any existing gist in.
    #   4. Keep store records whose ids are not among the fetched ones too.
    unified = {}
    for rec in store:
        cid = canonical_id(rec)
        if not cid:
            continue
        cur = unified.get(cid)
        if cur is None or (rec.get("gist") and not cur.get("gist")):
            unified[cid] = rec

    for rec in newly_built:
        cid = canonical_id(rec)
        if cid:
            if rec.get("gist"):
                unified[cid] = rec
            else:
                unified.setdefault(cid, rec)

    for p in fetched:
        cid = canonical_id(p)
        rec = unified.get(cid)
        if rec is None:
            rec = paper_to_meta(p)
            rec["short_id"] = p.get_short_id()
            rec["url"] = p.entry_id
            rec["published"] = p.published.isoformat()
            rec["summary"] = p.summary.strip()
            unified[cid] = rec
        else:
            # Ensure canonical url/id even for gist records.
            rec.setdefault("url", p.entry_id)
            rec.setdefault("short_id", p.get_short_id())

    merged = list(unified.values())

    # Sort newest first, keyed on whichever date is present.
    def parsed(rec):
        try:
            return __import__("datetime").datetime.fromisoformat(rec["published"])
        except Exception:
            return __import__("datetime").datetime.min
    merged.sort(key=parsed, reverse=True)

    save_store(merged)
    print(f"\nDone. Total unique records in data.json: {len(merged)}")
    print(f"Records with gists: {sum(1 for r in merged if r.get('gist'))}")
    print(f"New papers processed this run: {len(newly_built)}")


if __name__ == "__main__":
    main()
