const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5000"
    : "";

const state = {
    papers: [],
    query: "",
    fields: new Set(),
    activeField: "All",
    sort: "newest",
    loading: true,
    error: null,
};

const listEl = document.getElementById("paper-list");
const countEl = document.getElementById("result-count");
const filtersEl = document.getElementById("filters");
const searchEl = document.getElementById("search-input");
const sortEl = document.getElementById("sort-select");
const emptyEl = document.getElementById("empty-state");
const modal = document.getElementById("modal");
const modalContent = document.getElementById("modal-content");
const backdrop = document.getElementById("modal-backdrop");
const toast = document.getElementById("toast");
const navCount = document.getElementById("nav-count");
const statPapers = document.getElementById("stat-papers");
const statNotes = document.getElementById("stat-notes");
const loadingEl = document.getElementById("loading-state");
const errorEl = document.getElementById("error-state");
const themeToggle = document.getElementById("theme-toggle");

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/* ---- theme ---- */
function initTheme() {
    if (!themeToggle) return;
    themeToggle.addEventListener("click", () => {
        const dark = document.documentElement.classList.toggle("dark");
        try { localStorage.setItem("papergist-theme", dark ? "dark" : "light"); } catch (e) {}
    });
}

/* ---- per-category accent colour ---- */
const CAT_PALETTE = ["#bd4f1c", "#477059", "#b3872a", "#3f6f8c", "#8a5a9c", "#6b7f3a"];
function catColor(str) {
    if (!str) return CAT_PALETTE[0];
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return CAT_PALETTE[h % CAT_PALETTE.length];
}

/* ---- nav status pill ---- */
function setNavStatus(ok, text) {
    const dotClass = ok ? "ok" : "err";
    navCount.innerHTML = `<span class="dot ${dotClass}"></span>${escapeHtml(text)}`;
}

/* ---- animated number ---- */
function animateNumber(el, to) {
    if (!el) return;
    const from = Number(el.dataset.val || "0") || 0;
    if (from === to) { el.textContent = formatComma(to); return; }
    const dur = 650;
    const t0 = performance.now();
    function frame(t) {
        const k = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        el.textContent = formatComma(Math.round(from + (to - from) * eased));
        if (k < 1) requestAnimationFrame(frame);
        else el.dataset.val = String(to);
    }
    el.dataset.val = String(from);
    requestAnimationFrame(frame);
}

const isTableRow = (l) => /^\s*\|/.test(l);
const isListRow = (l) => /^\s*(?:[-*]|\d+\.)\s/.test(l);
const isHeadingRow = (l) => /^#{1,6}\s/.test(l);

function tableHtml(rows) {
    const toCells = (row) =>
        row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const headRow = rows[0];
    const bodyRows = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).slice(1);
    const head = toCells(headRow).map((c) => `<th>${inline(c)}</th>`).join("");
    const trs = bodyRows
        .map((row) => `<tr>${toCells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function renderMarkdown(text) {
    const html = escapeHtml(text);
    const lines = html.split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();
        if (line === "") { i++; continue; }
        if (line === "---") { blocks.push("<hr>"); i++; continue; }

        if (isHeadingRow(line)) {
            const level = line.match(/^(#{1,6})/)[1].length;
            const content = inline(line.replace(/^#{1,6}\s*/, ""));
            blocks.push(`<h${Math.min(level, 4)}>${content}</h${Math.min(level, 4)}>`);
            i++;
            continue;
        }

        if (isTableRow(line)) {
            const rows = [];
            while (i < lines.length && isTableRow(lines[i].trim())) {
                rows.push(lines[i].trim());
                i++;
            }
            if (rows.length >= 2) blocks.push(tableHtml(rows));
            else blocks.push(`<p>${inline(rows.join("<br>"))}</p>`);
            continue;
        }

        if (isListRow(line)) {
            const ordered = /^\s*\d+\.\s/.test(line);
            const items = [];
            while (i < lines.length) {
                const l = lines[i].trim();
                if (!isListRow(l) || /^\s*\d+\.\s/.test(l) !== ordered) break;
                items.push(`<li>${inline(l.replace(/^\s*(?:[-*]|\d+\.)\s/, ""))}</li>`);
                i++;
            }
            blocks.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
            continue;
        }

        const para = [];
        while (i < lines.length) {
            const l = lines[i].trim();
            if (l === "" || isHeadingRow(l) || isTableRow(l) || isListRow(l)) break;
            para.push(l);
            i++;
        }
        blocks.push(`<p>${inline(para.join("<br>"))}</p>`);
    }
    return blocks.join("\n");
}

function inline(text) {
    return text
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`)
        .replace(/\n/g, "<br>");
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function topicsFromGist(gist) {
    if (!gist) return [];
    const matches = gist.match(/^##\s+(.+)$/gm) || [];
    const skip = ["problem", "open questions", "where this paper fits"];
    return matches
        .map((s) => s.replace(/^##\s+/, "").trim())
        .filter((t) => !skip.some((k) => t.toLowerCase().startsWith(k)))
        .slice(0, 3);
}

function formatCitations(n) {
    if (n === null || n === undefined) return null;
    return n === 0 ? "0 citations" : `${n} citation${n === 1 ? "" : "s"}`;
}

function formatComma(n) {
    return Number(n || 0).toLocaleString();
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2500);
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function fetchPapers() {
    state.loading = true;
    state.error = null;
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    listEl.innerHTML = "";

    try {
        const res = await fetch(`${API_BASE}/api/papers?max=100`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        state.papers = Array.isArray(data) ? data : [];
        state.fields = new Set(state.papers.map((p) => p.field).filter(Boolean));
    } catch (err) {
        console.error("Failed to fetch papers:", err);
        state.error = err.message;
        state.papers = [];
        loadingEl.classList.add("hidden");
        errorEl.classList.remove("hidden");
        errorEl.querySelector("p").textContent = `Failed to load papers: ${err.message}`;
        setNavStatus(false, "API offline");
        return;
    }

    state.loading = false;
    loadingEl.classList.add("hidden");

    if (state.papers.length === 0) {
        setNavStatus(false, "no papers");
        emptyEl.classList.remove("hidden");
        emptyEl.querySelector("p").textContent = "No papers found.";
        return;
    }

    setNavStatus(true, `${state.papers.length} papers`);
    animateNumber(statPapers, state.papers.length);
    statNotes.textContent = "0";

    renderFilters();
    render();
}

async function generateGist(arxivId, paperTitle, cardEl, btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="spinner"></span> Generating...';

    try {
        const res = await fetch(`${API_BASE}/api/gist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ arxiv_id: arxivId, title: paperTitle }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // Update the paper in state
        const paper = state.papers.find((p) => p.short_id === arxivId);
        if (paper) {
            paper.gist = data.gist;
            paper.has_gist = true;
        }

        // Update the card UI
        const gistCount = state.papers.filter((p) => p.gist).length;
        animateNumber(statNotes, gistCount);

        // Replace the learn button with "Read note"
        const bottomEl = cardEl.querySelector(".card-bottom");
        const readMoreEl = cardEl.querySelector(".read-more");
        if (readMoreEl) readMoreEl.textContent = "Read learning note →";

        // Add topic tags from the gist
        const topics = topicsFromGist(data.gist);
        if (topics.length > 0) {
            const topicsEl = cardEl.querySelector(".topics");
            if (topicsEl) {
                topicsEl.innerHTML = topics.map((t) => `<span class="topic">${escapeHtml(t)}</span>`).join("");
            }
        }

        showToast("Learning note generated!");
    } catch (err) {
        console.error("Gist generation failed:", err);
        btnEl.disabled = false;
        btnEl.innerHTML = "Learn";
        showToast(`Error: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function fetchIntro(arxivId, paperTitle, btn) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Loading...';

    try {
        const res = await fetch(`${API_BASE}/api/intro`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ arxiv_id: arxivId, title: paperTitle }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const paper = state.papers.find((p) => p.short_id === arxivId);
        openIntroModal(paper || { title: paperTitle, url: null, short_id: arxivId }, data.clean);
    } catch (err) {
        console.error("Intro fetch failed:", err);
        showToast(`Error: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

function renderParagraphs(text) {
    const html = escapeHtml(text);
    return html
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => `<p>${p.replace(/\n/g, " ")}</p>`)
        .join("");
}

function openIntroModal(p, cleanIntro) {
    const body = `
        <div class="intro-section">
            <div class="intro-heading">
                <span class="intro-mark">✻</span>
                <div>
                    <h3>Introduction</h3>
                    <p>The paper's Introduction section, as-is from its source.</p>
                </div>
            </div>
            <div class="intro-body">${renderParagraphs(cleanIntro || "Introduction not available.")}</div>
        </div>
    `;

    modalContent.innerHTML = `
        <button class="close-btn" aria-label="Close">×</button>
        <h2>${escapeHtml(p.title || "")}</h2>
        <div class="meta-row">
            <span>Literature Review</span>
            <span>·</span>
            <span>Introduction section</span>
            ${p.url ? `<span>·</span><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">ArXiv ↗</a>` : ""}
        </div>
        ${p.authors && p.authors.length ? `<p class="authors">${escapeHtml(p.authors.join(", "))}</p>` : ""}
        ${readerToolbar()}
        ${body}
    `;
    openModalFocus();
    wireReaderToolbar(cleanIntro || "");
    modalContent.querySelector(".close-btn").addEventListener("click", closeModal);
}

function renderFilters() {
    filtersEl.innerHTML = "";
    ["All", ...[...state.fields].sort()].forEach((field) => {
        const chip = document.createElement("button");
        chip.className = "filter-chip" + (field === state.activeField ? " active" : "");
        chip.textContent = field;
        chip.dataset.field = field;
        chip.addEventListener("click", () => {
            state.activeField = field;
            renderFilters();
            render();
        });
        filtersEl.appendChild(chip);
    });
}

function sortPapers(papers) {
    const sorted = [...papers];
    switch (state.sort) {
        case "newest":
            sorted.sort((a, b) => new Date(b.published) - new Date(a.published));
            break;
        case "oldest":
            sorted.sort((a, b) => new Date(a.published) - new Date(b.published));
            break;
        case "cites":
            sorted.sort((a, b) => (b.citations || 0) - (a.citations || 0));
            break;
        case "az":
            sorted.sort((a, b) => a.title.localeCompare(b.title));
            break;
        case "za":
            sorted.sort((a, b) => b.title.localeCompare(a.title));
            break;
    }
    return sorted;
}

function visiblePapers() {
    const q = state.query.toLowerCase();
    return state.papers.filter((p) => {
        const inField = state.activeField === "All" || p.field === state.activeField;
        if (!inField) return false;
        if (!q) return true;
        const haystack = `${p.title} ${p.summary} ${p.field} ${(p.authors || []).join(" ")}`.toLowerCase();
        return haystack.includes(q);
    });
}

function render() {
    const papers = sortPapers(visiblePapers());
    listEl.innerHTML = "";
    countEl.textContent = `${papers.length} paper${papers.length === 1 ? "" : "s"}`;
    emptyEl.classList.toggle("hidden", papers.length > 0);

    papers.forEach((p, i) => {
        const card = document.createElement("article");
        card.className = "paper-card";
        card.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
        card.style.setProperty("--cat", catColor(p.primary_category || p.field));
        const topics = topicsFromGist(p.gist);
        const cites = formatCitations(p.citations);
        const readMore = p.gist ? "Read learning note →" : "";

        card.innerHTML = `
            <span class="card-index">${String(i + 1).padStart(2, "0")}</span>
            <div class="meta">
                <div class="meta-left">
                    <span class="badge">${escapeHtml(p.primary_category || p.field || "Research")}</span>
                    <span class="field-text">${escapeHtml(p.field || "Research")}</span>
                </div>
                <span class="date">${formatDate(p.published)}</span>
            </div>
            <h3>${escapeHtml(p.title)}</h3>
            ${p.authors && p.authors.length ? `<p class="card-authors">${escapeHtml(p.authors.slice(0, 3).join(", "))}${p.authors.length > 3 ? " et al." : ""}</p>` : ""}
            <p class="abstract">${escapeHtml(p.summary)}</p>
            <div class="card-bottom">
                <div class="topics">
                    ${topics.map((t) => `<span class="topic">${escapeHtml(t)}</span>`).join("")}
                    ${cites ? `<span class="topic cite">⤴ ${escapeHtml(cites)}</span>` : ""}
                </div>
                <div class="card-actions">
                    ${readMore ? `<span class="read-more">${readMore}</span>` : ""}
                    <button class="lit-btn" data-id="${escapeHtml(p.short_id)}" data-title="${escapeHtml(p.title)}">
                        <span class="btn-icon">☍</span>Lit. Review
                    </button>
                    <button class="learn-btn" data-id="${escapeHtml(p.short_id)}" data-title="${escapeHtml(p.title)}">
                        <span class="btn-icon">${p.gist ? "✦" : "△"}</span>${p.gist ? "View note" : "Learn"}
                    </button>
                </div>
            </div>
        `;

        // Lit. Review button click — fetch and show the paper's real Introduction
        const litBtn = card.querySelector(".lit-btn");
        litBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            fetchIntro(p.short_id, p.title, litBtn);
        });

        // Learn button click — stops propagation so card click doesn't fire
        const learnBtn = card.querySelector(".learn-btn");
        learnBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (p.gist) {
                openModal(p);
            } else {
                generateGist(p.short_id, p.title, card, learnBtn);
            }
        });

        // Card click opens modal (only if gist exists)
        card.addEventListener("click", () => {
            if (p.gist) openModal(p);
        });

        listEl.appendChild(card);
    });
}

function openModal(p) {
    const cites = formatCitations(p.citations);
    const body = p.gist
        ? `<div class="gist-body">${renderMarkdown(p.gist)}</div>`
        : `<div class="gist-body no-gist">
                <h2>No learning note yet</h2>
                <p>Click the "Learn" button on the paper card to generate one on the fly.</p>
           </div>`;
    modalContent.innerHTML = `
        <button class="close-btn" aria-label="Close">×</button>
        <h2>${escapeHtml(p.title)}</h2>
        <div class="meta-row">
            <span>${escapeHtml(p.field || "Research")}</span>
            <span>·</span>
            <span>Published ${formatDate(p.published)}</span>
            ${cites ? `<span>·</span><span class="citations-chip">${escapeHtml(cites)}</span>` : ""}
            ${p.url ? `<span>·</span><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">ArXiv ↗</a>` : ""}
        </div>
        ${p.authors && p.authors.length ? `<p class="authors">${escapeHtml(p.authors.join(", "))}</p>` : ""}
        <div class="abstract-box">${escapeHtml(p.summary)}</div>
        ${p.gist ? readerToolbar() : ""}
        ${body}
    `;
    openModalFocus();
    wireReaderToolbar(p.gist || "");
    modalContent.querySelector(".close-btn").addEventListener("click", closeModal);
}

function readerToolbar() {
    return `
    <div class="reader-toolbar" role="group" aria-label="Reading controls">
        <span class="reader-label">Reader</span>
        <button class="reader-btn" data-size="-1" aria-label="Decrease text size">A−</button>
        <button class="reader-btn" data-size="1" aria-label="Increase text size">A+</button>
        <button class="reader-btn copy-btn" aria-label="Copy text">Copy</button>
    </div>`;
}

function wireReaderToolbar(copyText) {
    modalContent.querySelectorAll("[data-size]").forEach((btn) => {
        btn.addEventListener("click", () => {
            readerScale = Math.max(0.85, Math.min(1.4, readerScale + Number(btn.dataset.size) * 0.1));
            modalContent.style.setProperty("--reader-scale", String(readerScale));
        });
    });
    const copyBtn = modalContent.querySelector(".copy-btn");
    if (copyBtn) {
        copyBtn.addEventListener("click", () => {
            if (!navigator.clipboard || !copyText) {
                showToast("Nothing to copy");
                return;
            }
            navigator.clipboard.writeText(copyText)
                .then(() => showToast("Copied to clipboard"))
                .catch(() => showToast("Copy failed"));
        });
    }
}

function openModalFocus() {
    lastFocused = document.activeElement;
    modal.classList.remove("hidden");
    modalContent.scrollTop = 0;
    modal.setAttribute("aria-hidden", "false");
    const closeBtn = modalContent.querySelector(".close-btn");
    if (closeBtn) closeBtn.focus();
}

function closeModal() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
}

let lastFocused = null;
let readerScale = 1;

modalContent.addEventListener("keydown", (e) => {
    if (modal.classList.contains("hidden") || e.key !== "Tab") return;
    const focusables = modalContent.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

searchEl.addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
});

const searchForm = document.getElementById("search-form");
if (searchForm) {
    searchForm.addEventListener("submit", (e) => e.preventDefault());
}

sortEl.addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
});

initTheme();

backdrop.addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchEl.focus();
        searchEl.select();
    }
});

fetchPapers();
