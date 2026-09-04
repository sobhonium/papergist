"""Paper Gist — API server and CLI pipeline.

Runs as a Flask API that serves arXiv papers on the fly and generates
learning gists via Groq when requested. Also supports the original CLI
batch mode for offline processing.

Usage (API server):
    python pipeline.py
    python pipeline.py --port 5000

Usage (CLI batch mode):
    python pipeline.py --cli --fetch 100 --new 10
"""

import argparse
import io
import json
import os
import re
import sys
import tarfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GROQ_MODEL = "qwen/qwen3.6-27b"
ARXIV_API_URL = "http://export.arxiv.org/api/query"
ARXIV_SEARCH_QUERY = 'all:"large language model"'

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

SITE_JSON = Path(__file__).resolve().parent / "site" / "data.json"

# ---------------------------------------------------------------------------
# arXiv fetching (Atom feed, no library needed)
# ---------------------------------------------------------------------------

ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def fetch_papers_from_arxiv(max_results=100, retries=3, delay=3):
    """Fetch latest papers from the arXiv Atom feed. Returns a list of dicts."""
    params = {
        "search_query": ARXIV_SEARCH_QUERY,
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    resp = None
    for attempt in range(retries):
        try:
            resp = requests.get(ARXIV_API_URL, params=params, timeout=30)
        except Exception as e:
            print(f"  arXiv request error: {e} (attempt {attempt+1}/{retries})")
            time.sleep(delay * (attempt + 1))
            continue
        if resp.status_code == 200:
            break
        if resp.status_code == 429:
            wait = delay * (attempt + 1)
            print(f"  arXiv rate-limited (429), waiting {wait}s...")
            time.sleep(wait)
            continue
        resp.raise_for_status()
    if resp is None or resp.status_code != 200:
        raise Exception(f"arXiv API failed after {retries} retries")

    root = ET.fromstring(resp.text)
    papers = []
    for entry in root.findall("atom:entry", ATOM_NS):
        title_el = entry.find("atom:title", ATOM_NS)
        summary_el = entry.find("atom:summary", ATOM_NS)
        published_el = entry.find("atom:published", ATOM_NS)
        id_el = entry.find("atom:id", ATOM_NS)

        if id_el is None or id_el.text is None:
            continue

        arxiv_url = id_el.text.strip()

        # Extract short_id from URL (e.g. http://arxiv.org/abs/2609.02859v1 -> 2609.02859v1)
        short_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else ""

        # Extract authors
        authors = []
        for author_el in entry.findall("atom:author", ATOM_NS):
            name_el = author_el.find("atom:name", ATOM_NS)
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())

        # Extract primary category
        primary_cat = ""
        cat_el = entry.find("{http://arxiv.org/schemas/atom}primary_category")
        if cat_el is not None:
            primary_cat = cat_el.get("term", "")

        # Clean up title (replace newlines, collapse whitespace)
        title = " ".join((title_el.text or "").split()) if title_el is not None else ""
        summary = " ".join((summary_el.text or "").split()) if summary_el is not None else ""
        published = published_el.text.strip() if published_el is not None and published_el.text else ""

        papers.append({
            "title": title,
            "field": "Large Language Models",
            "published": published,
            "url": arxiv_url,
            "short_id": short_id,
            "summary": summary,
            "authors": authors,
            "primary_category": primary_cat,
            "citations": None,
        })

    papers.sort(key=lambda p: p["published"], reverse=True)
    return papers


# ---------------------------------------------------------------------------
# TeX extraction and Groq gist generation
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
    source = download_arxiv_source(arxiv_id)
    try:
        tar = tarfile.open(fileobj=io.BytesIO(source), mode="r:*")
    except tarfile.TarError:
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


def clean_latex(text):
    """Strip LaTeX markup so the Introduction reads as plain prose."""
    t = text
    # drop full-line comments
    t = re.sub(r"(?m)^\s*%.*?$", "", t)
    # drop inline comments (\foo%comment)
    t = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?\{[^{}]*\}\s*%.*?$", "", t, flags=re.MULTILINE)
    # paragraph breaks
    t = re.sub(r"\\(?:par|newline)\b", "\n\n", t)
    t = re.sub(r"\\\\", "\n\n", t)
    # environments -> drop display-math environments entirely, keep prose envs' content
    t = re.sub(
        r"\\begin\{([a-zA-Z]*equation\*?|displaymath|multline\*?|"
        r"align[a-zA-Z]*\*?|alignat[a-zA-Z]*\*?|gather[a-zA-Z]*\*?|"
        r"eqnarray[a-zA-Z]*\*?|math\*?)\}"
        r".*?\\end\{\1\}",
        " ",
        t,
        flags=re.DOTALL,
    )
    t = re.sub(r"\\begin\{[^}]*\}\s*(\[[^\]]*\])?", " ", t)
    t = re.sub(r"\\end\{[^}]*\}", " ", t)
    # citations / references / labels -> drop entirely
    t = re.sub(r"\\cite[a-z]*\*?(?:\[[^\]]*\])*\{[^}]*\}", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\\(?:footnote|endnote)\{", " (", t)
    t = re.sub(r"\\footnote[^\{]", "", t)
    t = re.sub(r"\\(?:footnotemark|thanks)\{", "", t)
    t = re.sub(r"\\(?:ref|label|eqref|autoref|pageref)\*?\{[^}]*\}", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\\url\{([^}]*)\}", r"\1", t, flags=re.IGNORECASE)
    t = re.sub(r"\\href\{[^}]*\}\{([^}]*)\}", r"\1", t, flags=re.IGNORECASE)
    # formatting commands -> keep inner text
    t = re.sub(
        r"\\(?:textbf|emph|textit|texttt|textrm|textsc|textsf|textnormal|"
        r"mbox|underline|mathrm|mathbf|mathcal|mathit|operatorname|footnote)\*?\{([^{}]*)\}",
        r"\1",
        t,
    )
    # math: strip inline and display math entirely (may span lines)
    t = re.sub(r"\$\$.*?\$\$", "", t, flags=re.DOTALL)
    t = re.sub(r"\\\[.*?\\\]", "", t, flags=re.DOTALL)
    t = re.sub(r"\$[^$]*\$", "", t, flags=re.DOTALL)
    # spacing / layout commands -> drop completely
    t = re.sub(
        r"\\(?:hspace|vspace|hphantom|vphantom|phantom|enspace|quad|qquad|"
        r"smallskip|medskip|bigskip|linebreak|pagebreak|columnsep|parskip)\*?"
        r"(\[[^\]]*\])?(\{[^{}]*\})?",
        " ",
        t,
    )
    t = re.sub(r"\\[,;! ]", " ", t)
    # escaped symbols -> unescape
    t = re.sub(r"\\\$", "$", t)
    t = re.sub(r"\\%", "%", t)
    t = re.sub(r"\\#", "#", t)
    t = re.sub(r"\\_", "_", t)
    t = re.sub(r"\\&", "&", t)
    t = re.sub(r"\\~", "~", t)
    t = re.sub(r"\\\^", "^", t)
    # commands with a single-level argument -> keep the argument text
    t = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?\{([^{}]*)\}", r"\2", t)
    # any residual named commands without arguments -> drop
    t = re.sub(r"\\([a-zA-Z@])+", " ", t)
    # any other braces and \left / \right
    t = re.sub(r"[{}]", "", t)
    t = re.sub(r"\\(?:left|right)\b", "", t)

    # final whitespace polish
    t = t.replace("~", " ")
    t = re.sub(r"\s+\.", ".", t)
    t = re.sub(r"\.\s*\.", ".", t)
    t = re.sub(r"\s+,", ",", t)
    t = re.sub(r"\s+;", ";", t)
    t = re.sub(r"\s{3,}", "  ", t)

    # collapse whitespace per line, preserve paragraph breaks
    lines = [" ".join(ln.split()) for ln in t.split("\n")]
    out = []
    was_blank = False
    for ln in lines:
        if not ln:
            was_blank = True
            continue
        if was_blank and out and out[-1]:
            out.append("")
        out.append(ln)
        was_blank = False
    return "\n".join(out).strip()


def generate_gist(paper_title, intro):
    from groq import Groq
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY environment variable not set")
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
# Citations (OpenAlex — free, no API key)
# ---------------------------------------------------------------------------

def fetch_citations(arxiv_ids, delay=0.5):
    """Fetch citation counts for a list of arXiv ids via OpenAlex."""
    ids = [i for i in arxiv_ids if i]
    if not ids:
        return {}
    counts = {}
    for aid in ids:
        try:
            url = f"https://api.openalex.org/works/https://doi.org/10.48550/arxiv.{aid}"
            resp = requests.get(url, timeout=30)
            if resp.status_code == 200:
                counts[aid] = resp.json().get("cited_by_count", 0)
            else:
                counts[aid] = 0
        except Exception:
            counts[aid] = None
        time.sleep(delay)
    return counts


# ---------------------------------------------------------------------------
# CLI batch mode (original pipeline)
# ---------------------------------------------------------------------------

def canonical_id(paper_or_rec):
    if isinstance(paper_or_rec, str):
        sid = paper_or_rec
    elif isinstance(paper_or_rec, dict):
        u = (paper_or_rec.get("url") or "").lower()
        if "arxiv.org/abs/" in u:
            sid = u.split("/abs/")[-1]
        else:
            sid = paper_or_rec.get("short_id") or ""
    else:
        sid = ""
    sid = sid.lower().strip()
    return re.sub(r"v\d+$", "", sid) if re.search(r"v\d+$", sid) else sid


def run_cli(args):
    """Original batch pipeline: fetch papers, build gists, write data.json."""
    import arxiv as arxiv_lib

    groq_key = args.groq_key or os.environ.get("GROQ_API_KEY")
    if not groq_key:
        print("ERROR: no GROQ_API_KEY provided (use --groq-key or env var).")
        sys.exit(1)

    def arxiv_client():
        return arxiv_lib.Client(page_size=100, delay_seconds=3, num_retries=3)

    def fetch_latest_n(max_results=100):
        client = arxiv_client()
        search = arxiv_lib.Search(
            query=ARXIV_SEARCH_QUERY,
            max_results=max_results,
            sort_by=arxiv_lib.SortCriterion.SubmittedDate,
            sort_order=arxiv_lib.SortOrder.Descending,
        )
        papers = list(client.results(search))
        papers.sort(key=lambda p: p.published, reverse=True)
        return papers

    def paper_to_meta(paper):
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

    def load_store():
        if SITE_JSON.exists():
            try:
                return json.loads(SITE_JSON.read_text())
            except json.JSONDecodeError:
                return []
        return []

    def save_store(store):
        SITE_JSON.parent.mkdir(parents=True, exist_ok=True)
        SITE_JSON.write_text(json.dumps(store, indent=2, ensure_ascii=False))
        print(f"Wrote {len(store)} records to {SITE_JSON}")

    def known_ids(store):
        ids = set()
        for rec in store:
            cid = canonical_id(rec)
            if cid:
                ids.add(cid)
        return ids

    print(f"Fetching latest {args.fetch} 'large language model' papers...")
    fetched = fetch_latest_n(args.fetch)
    print(f"Fetched {len(fetched)} papers.")

    store = load_store()
    existing = known_ids(store)
    print(f"Existing processed ids in data.json: {len(existing)}")

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

        cites = fetch_citations([sid])
        record["citations"] = cites.get(sid)

        intro = None
        try:
            intro = extract_tex_intro(sid)
        except Exception as e:
            print(f"  could not download source: {e}")

        if intro:
            try:
                chat = __import__("groq").Groq(api_key=groq_key).chat.completions.create(
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": f"Paper title:\n{paper.title.strip()}\n\nIntroduction:\n{intro}"},
                    ],
                    model=GROQ_MODEL,
                    reasoning_effort="none",
                )
                record["gist"] = chat.choices[0].message.content
                record["has_gist"] = True
            except Exception as e:
                print(f"  gist failed: {e}")
                record["gist"] = None
        else:
            print("  no Introduction extracted; no gist")

        newly_built.append(record)
        existing.add(sid)

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
            rec.setdefault("url", p.entry_id)
            rec.setdefault("short_id", p.get_short_id())

    merged = list(unified.values())
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


# ---------------------------------------------------------------------------
# Flask API server
# ---------------------------------------------------------------------------

app = Flask(__name__)
CORS(app)

_papers_cache = None


@app.route("/api/papers", methods=["GET"])
def api_papers():
    """Return the latest arXiv papers as JSON. Fetched live from arXiv."""
    global _papers_cache
    try:
        max_results = request.args.get("max", 100, type=int)
        max_results = min(max_results, 200)

        _papers_cache = fetch_papers_from_arxiv(max_results)
        return jsonify(_papers_cache)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/gist", methods=["POST"])
def api_gist():
    """Generate a learning gist for a paper on the fly via Groq."""
    data = request.get_json()
    if not data or "arxiv_id" not in data:
        return jsonify({"error": "Missing arxiv_id"}), 400

    arxiv_id = data["arxiv_id"]
    paper_title = data.get("title", "Unknown Paper")

    # Download TeX source and extract Introduction
    try:
        intro = extract_tex_intro(arxiv_id)
    except Exception as e:
        return jsonify({"error": f"Failed to download/parse source: {e}"}), 500

    if not intro:
        return jsonify({"error": "Could not extract Introduction from the paper's TeX source."}), 404

    # Generate gist via Groq
    try:
        gist = generate_gist(paper_title, intro)
        return jsonify({"gist": gist})
    except Exception as e:
        return jsonify({"error": f"Groq API error: {e}"}), 500


@app.route("/api/intro", methods=["POST"])
def api_intro():
    """Fetch a paper's actual \\section{Introduction} verbatim from its TeX source."""
    data = request.get_json()
    if not data or "arxiv_id" not in data:
        return jsonify({"error": "Missing arxiv_id"}), 400

    arxiv_id = data["arxiv_id"]

    try:
        intro = extract_tex_intro(arxiv_id)
    except Exception as e:
        return jsonify({"error": f"Failed to download/parse source: {e}"}), 500

    if not intro:
        return jsonify({"error": "Could not extract Introduction from the paper's TeX source."}), 404

    return jsonify({"intro": intro, "clean": clean_latex(intro)})


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Paper Gist server or CLI pipeline")
    parser.add_argument("--cli", action="store_true", help="Run in CLI batch mode instead of API server")
    parser.add_argument("--port", type=int, default=5000, help="Port for the API server (default: 5000)")
    parser.add_argument("--host", default="127.0.0.1", help="Host for the API server (default: 127.0.0.1)")
    parser.add_argument("--fetch", type=int, default=100, help="[CLI] number of latest papers to fetch")
    parser.add_argument("--new", type=int, default=10, help="[CLI] number of new papers to process with gists")
    parser.add_argument("--groq-key", default=None, help="[CLI] GROQ_API_KEY")
    parser.add_argument("--s2-key", default=None, help="[CLI] Semantic Scholar API key (optional)")
    args = parser.parse_args()

    if args.cli:
        run_cli(args)
    else:
        print(f"Starting Paper Gist API on http://{args.host}:{args.port}")
        print("Endpoints:")
        print(f"  GET  http://{args.host}:{args.port}/api/papers")
        print(f"  POST http://{args.host}:{args.port}/api/gist")
        print(f"  POST http://{args.host}:{args.port}/api/intro")
        app.run(host=args.host, port=args.port)
