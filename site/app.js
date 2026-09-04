const state = {
    papers: [],
    query: "",
    fields: new Set(),
    activeField: "All",
    sort: "newest",
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
const statCites = document.getElementById("stat-cites");

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Very small, safe Markdown renderer: headings, bold/italic, lists,
// tables, hr, code spans and links. Line-group based so headings glued
// directly onto tables (no blank line) still parse correctly.
const isTableRow = (l) => /^\s*\|/.test(l);
const isListRow = (l) => /^\s*(?:[-*]|\d+\.)\s/.test(l);
const isHeadingRow = (l) => /^#{1,6}\s/.test(l);

function tableHtml(rows) {
    const toCells = (row) =>
        row
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());
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

        if (line === "") {
            i++;
            continue;
        }

        if (line === "---") {
            blocks.push("<hr>");
            i++;
            continue;
        }

        if (isHeadingRow(line)) {
            const level = line.match(/^(#{1,6})/)[1].length;
            const content = inline(line.replace(/^#{1,6}\s*/, ""));
            blocks.push(`<h${Math.min(level, 4)}>${content}</h${Math.min(level, 4)}>`);
            i++;
            continue;
        }

        // Collect a contiguous table group
        if (isTableRow(line)) {
            const rows = [];
            while (i < lines.length && isTableRow(lines[i].trim())) {
                rows.push(lines[i].trim());
                i++;
            }
            if (rows.length >= 2) {
                blocks.push(tableHtml(rows));
            } else {
                blocks.push(`<p>${inline(rows.join("<br>"))}</p>`);
            }
            continue;
        }

        // Collect a contiguous list group
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

        // Plain paragraph line(s)
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
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
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

const CAT_ACCENTS = ["#d98e24", "#a63d24", "#2e7568", "#3a6ca3", "#77517f", "#5c7a38"];

function accentFor(field) {
    const key = String(field || "Research").toLowerCase();
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return CAT_ACCENTS[h % CAT_ACCENTS.length];
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
            sorted.sort((a, b) => {
                const ca = a.citations || 0;
                const cb = b.citations || 0;
                return cb - ca;
            });
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

function formatComma(n) {
    return Number(n || 0).toLocaleString();
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 1800);
}

function visiblePapers() {
    const q = state.query.toLowerCase();
    return state.papers.filter((p) => {
        const inField = state.activeField === "All" || p.field === state.activeField;
        if (!inField) return false;
        if (!q) return true;
        const haystack = `${p.title} ${p.summary} ${p.gist || ""} ${p.field}`.toLowerCase();
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
        card.style.setProperty("--cat", accentFor(p.field));
        card.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
        const topics = topicsFromGist(p.gist);
        const cites = formatCitations(p.citations);
        const readMore = p.gist ? "Read learning note →" : "Abstract only →";
        card.innerHTML = `
            <div class="meta">
                <span class="field">${escapeHtml(p.field || "Research")}</span>
                <span class="date">${formatDate(p.published)}</span>
            </div>
            <h3>${escapeHtml(p.title)}</h3>
            <p class="abstract">${escapeHtml(p.summary)}</p>
            <div class="card-bottom">
                <div class="topics">
                    ${topics.map((t) => `<span class="topic">${escapeHtml(t)}</span>`).join("")}
                    ${cites ? `<span class="topic cite">⤴ ${escapeHtml(cites)}</span>` : ""}
                </div>
                <span class="read-more">${readMore}</span>
            </div>
        `;
        card.addEventListener("click", () => openModal(p));
        listEl.appendChild(card);
    });
}

function openModal(p) {
    const cites = formatCitations(p.citations);
    const body = p.gist
        ? `<div class="gist-body">${renderMarkdown(p.gist)}</div>`
        : `<div class="gist-body no-gist">
                <h2>No learning note yet</h2>
                <p>This paper has been pulled into the library but its learning
                resource hasn't been generated. Re-run the notebook to build
                gists for the newest unseen papers.</p>
           </div>`;
    modalContent.innerHTML = `
        <button class="close-btn" aria-label="Close">×</button>
        <h2>${escapeHtml(p.title)}</h2>
        <div class="meta-row">
            <span>${escapeHtml(p.field || "Research")}</span>
            <span>·</span>
            <span>Published ${formatDate(p.published)}</span>
            ${cites ? `<span>·</span><span class="citations-chip">${escapeHtml(cites)}</span>` : ""}
            ${
                p.url
                    ? `<span>·</span><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">ArXiv ↗</a>`
                    : ""
            }
        </div>
        <div class="abstract-box">${escapeHtml(p.summary)}</div>
        <div class="reader-toolbar">
            <button class="reader-btn" id="zoomin-btn" type="button">A +</button>
            <button class="reader-btn" id="zoomout-btn" type="button">A −</button>
            <span class="reader-sep"></span>
            <button class="reader-btn copy-btn" id="copy-btn" type="button">Copy note</button>
        </div>
        ${body}
    `;
    modal.classList.remove("hidden");
    modalContent.style.setProperty("--reader-scale", "1");
    modalContent.scrollTop = 0;
    openModal._lastFocus = document.activeElement;
    const closeBtn = modalContent.querySelector(".close-btn");
    closeBtn.addEventListener("click", closeModal);
    closeBtn.focus();

    const zoomIn = modalContent.querySelector("#zoomin-btn");
    const zoomOut = modalContent.querySelector("#zoomout-btn");
    const copyBtn = modalContent.querySelector("#copy-btn");
    let scale = 1;
    zoomIn.addEventListener("click", () => {
        scale = Math.min(1.35, +(scale + 0.05).toFixed(2));
        modalContent.style.setProperty("--reader-scale", scale);
    });
    zoomOut.addEventListener("click", () => {
        scale = Math.max(0.8, +(scale - 0.05).toFixed(2));
        modalContent.style.setProperty("--reader-scale", scale);
    });
    copyBtn.addEventListener("click", () => {
        navigator.clipboard
            .writeText(p.gist || `${p.title}\n\n${p.summary}`)
            .then(() => showToast(p.gist ? "Learning note copied" : "Abstract copied"))
            .catch(() => showToast("Could not copy"));
    });
}

function closeModal() {
    modal.classList.add("hidden");
    if (openModal._lastFocus && openModal._lastFocus.focus) openModal._lastFocus.focus();
}

async function init() {
    try {
        const res = await fetch("data.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.papers = Array.isArray(data) ? data : [];
        state.fields = new Set(state.papers.map((p) => p.field).filter(Boolean));
    } catch (err) {
        console.error("Failed to load data:", err);
        emptyEl.classList.remove("hidden");
        emptyEl.querySelector("p").textContent = "Could not load data.json.";
        return;
    }

    if (state.papers.length === 0) {
        emptyEl.classList.remove("hidden");
        emptyEl.querySelector("p").textContent = "No papers loaded. Add entries to data.json.";
    }

    // Update stat counters.
    const notes = state.papers.filter((p) => p.gist).length;
    const totalCites = state.papers.reduce((s, p) => s + (p.citations || 0), 0);
    navCount.textContent = `${state.papers.length} papers`;
    animateCount(statPapers, state.papers.length);
    animateCount(statNotes, notes);
    animateCount(statCites, totalCites);

    fillHeroArt();
    renderFilters();
    render();
}

function animateCount(el, target, duration = 800) {
    const start = performance.now();
    const from = 0;
    function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = formatComma(Math.round(from + (target - from) * eased));
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

function fillHeroArt() {
    const backs = document.querySelectorAll(".stack-back .stack-title, .stack-mid .stack-title");
    if (backs.length < 2 || state.papers.length < 2) return;
    backs[0].textContent = state.papers[0].title;
    backs[1].textContent = state.papers[1].title;
}

searchEl.addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
});

sortEl.addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
});

backdrop.addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    // Cmd/Ctrl+K focuses the search bar.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchEl.focus();
        searchEl.select();
    }
});

init();