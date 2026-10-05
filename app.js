"use strict";

const OPEN_LIBRARY_BOOKS = "https://openlibrary.org/api/books";
const OPEN_LIBRARY_SEARCH = "https://openlibrary.org/search.json";
const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
const CACHE_KEY = "dewey-helper-cache-v2";
const COMPLETED_KEY = "dewey-helper-completed-v1";
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 20;
const REQUEST_DELAY_MS = 1100;
const PAGE_SIZE = 100;
let lastNetworkRequestAt = 0;
let sheetJsPromise = null;

const state = {
  headers: [],
  records: [],
  sourceName: "",
  delimiter: "\t",
  cancelled: false,
  running: false,
  page: 0,
  cache: loadCache(),
  completed: loadCompleted()
};

const els = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  isbnPaste: document.querySelector("#isbnPaste"),
  loadPasteButton: document.querySelector("#loadPasteButton"),
  loadMessage: document.querySelector("#loadMessage"),
  lookupButton: document.querySelector("#lookupButton"),
  cancelButton: document.querySelector("#cancelButton"),
  clearCacheButton: document.querySelector("#clearCacheButton"),
  progressArea: document.querySelector("#progressArea"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  bookCount: document.querySelector("#bookCount"),
  isbnCount: document.querySelector("#isbnCount"),
  currentDeweyCount: document.querySelector("#currentDeweyCount"),
  cachedCount: document.querySelector("#cachedCount"),
  filterSelect: document.querySelector("#filterSelect"),
  resultCount: document.querySelector("#resultCount"),
  resultsBody: document.querySelector("#resultsBody"),
  pagination: document.querySelector("#pagination"),
  prevPage: document.querySelector("#prevPage"),
  nextPage: document.querySelector("#nextPage"),
  pageLabel: document.querySelector("#pageLabel"),
  exportTsv: document.querySelector("#exportTsv"),
  exportCsv: document.querySelector("#exportCsv"),
  exportJson: document.querySelector("#exportJson")
};

els.fileInput.addEventListener("change", () => {
  const [file] = els.fileInput.files;
  if (file) loadFile(file);
});

["dragenter", "dragover"].forEach(type => {
  els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach(type => {
  els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
  });
});

els.dropZone.addEventListener("drop", event => {
  const [file] = event.dataTransfer.files;
  if (file) loadFile(file);
});

els.loadPasteButton.addEventListener("click", loadPastedIsbns);
els.lookupButton.addEventListener("click", runLookup);
els.cancelButton.addEventListener("click", () => {
  state.cancelled = true;
  setProgress("Cancelling after the current request…");
});
els.clearCacheButton.addEventListener("click", clearCache);
els.filterSelect.addEventListener("change", () => {
  state.page = 0;
  renderTable();
});
els.prevPage.addEventListener("click", () => {
  state.page = Math.max(0, state.page - 1);
  renderTable();
});
els.nextPage.addEventListener("click", () => {
  state.page += 1;
  renderTable();
});

els.exportTsv.addEventListener("click", () => exportDelimited("\t", "tsv"));
els.exportCsv.addEventListener("click", () => exportDelimited(",", "csv"));
els.exportJson.addEventListener("click", exportJson);

async function loadFile(file) {
  setLoadMessage("Reading file…");
  try {
    const lower = file.name.toLowerCase();
    let parsed;

    if (/\.(xlsx|xls|xlsb)$/.test(lower)) {
      setLoadMessage("Reading Excel export locally in your browser…");
      parsed = await parseExcelExport(file);
    } else {
      const text = await file.text();
      if (lower.endsWith(".json") || looksLikeJson(text)) {
        parsed = parseJsonExport(text);
      } else {
        const delimiter = detectDelimiter(text);
        parsed = parseDelimitedExport(text, delimiter);
        state.delimiter = delimiter;
      }
    }

    ingestRows(parsed.headers, parsed.rows, file.name);
    setLoadMessage(`Loaded ${state.records.length.toLocaleString()} records from ${file.name}.`, "success");
  } catch (error) {
    console.error(error);
    setLoadMessage(`Could not read that export: ${error.message}`, "error");
  }
}

function loadPastedIsbns() {
  const values = extractIsbnCandidates(els.isbnPaste.value);
  const unique = [...new Set(values.filter(isValidIsbn))];

  if (!unique.length) {
    setLoadMessage("I could not find any valid ISBN-10 or ISBN-13 values in that text.", "error");
    return;
  }

  const headers = ["ISBN"];
  const rows = unique.map(isbn => ({ ISBN: isbn }));
  ingestRows(headers, rows, "pasted-isbns");
  setLoadMessage(`Loaded ${unique.length.toLocaleString()} valid ISBNs.`, "success");
}

function ingestRows(headers, rows, sourceName) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("No book rows were found.");

  state.headers = headers.length ? [...headers] : deriveHeaders(rows);
  state.sourceName = sourceName;
  state.records = rows.map((row, index) => normaliseRecord(row, index));
  state.page = 0;

  updateSummary();
  renderTable();
  setEnabled(true);
}

function normaliseRecord(row, index) {
  const headerMap = makeHeaderMap(Object.keys(row));
  const title = pickValue(row, headerMap, ["title", "booktitle"]);
  const author = pickValue(row, headerMap, ["primaryauthor", "author", "authorfirstlast", "authorlastfirst"]);
  const currentDewey = pickValue(row, headerMap, ["deweydecimal", "dewey", "ddc", "deweymelvil"]);
  const bookId = pickValue(row, headerMap, ["bookid", "id"]);
  const workId = pickValue(row, headerMap, ["workid"]);

  const isbnText = [
    pickValue(row, headerMap, ["isbn"]),
    pickValue(row, headerMap, ["isbns", "isbn13", "isbn10"])
  ].filter(Boolean).join(" ");

  const candidates = extractIsbnCandidates(isbnText);
  const valid = [...new Set(candidates.filter(isValidIsbn))];
  valid.sort((a, b) => b.length - a.length);

  return {
    index,
    original: { ...row },
    title: cleanText(title),
    author: cleanText(author),
    bookId: cleanText(bookId),
    workId: cleanText(workId),
    isbn: valid[0] || "",
    allIsbns: valid,
    currentDewey: cleanText(currentDewey),
    suggestedDewey: "",
    alternatives: [],
    confidence: "",
    status: valid.length ? "pending" : "missing-isbn",
    source: "",
    sourceUrl: "",
    sourceTitle: "",
    note: valid.length ? "Not looked up yet." : "No valid ISBN found in the export.",
    completed: isCompleted(cleanText(bookId), valid[0] || "")
  };
}

async function runLookup() {
  if (state.running || !state.records.length) return;

  state.running = true;
  state.cancelled = false;
  els.lookupButton.disabled = true;
  els.cancelButton.hidden = false;
  els.progressArea.hidden = false;
  els.progressBar.value = 0;

  const byIsbn = new Map();
  for (const record of state.records) {
    if (!record.isbn) continue;
    if (!byIsbn.has(record.isbn)) byIsbn.set(record.isbn, []);
    byIsbn.get(record.isbn).push(record);
  }

  const uniqueIsbns = [...byIsbn.keys()];
  let resolved = 0;
  const uncached = [];

  for (const isbn of uniqueIsbns) {
    const cached = getCached(isbn);
    if (cached) {
      applyResolution(byIsbn.get(isbn), cached, true);
      resolved += 1;
    } else {
      uncached.push(isbn);
    }
  }

  updateProgress(resolved, uniqueIsbns.length, "Using cached results…");
  renderTable();

  try {
    const batches = chunk(uncached, BATCH_SIZE);

    for (let i = 0; i < batches.length; i += 1) {
      if (state.cancelled) break;

      const batch = batches[i];
      setProgress(`Querying Open Library batch ${i + 1} of ${batches.length}…`);

      let resolutions;
      try {
        resolutions = await lookupBatch(batch);
      } catch (error) {
        if (error?.name === "AbortError") break;
        console.error(error);
        resolutions = new Map(batch.map(isbn => [isbn, {
          status: "error",
          suggestedDewey: "",
          alternatives: [],
          confidence: "",
          source: "Open Library",
          sourceUrl: "",
          sourceTitle: "",
          note: `Lookup error: ${error.message}`
        }]));
      }

      for (const isbn of batch) {
        const resolution = resolutions.get(isbn) || makeNotFoundResolution();
        applyResolution(byIsbn.get(isbn), resolution, false);
        if (resolution.status !== "error") putCached(isbn, resolution);
        resolved += 1;
      }

      persistCache();
      updateSummary();
      updateProgress(resolved, uniqueIsbns.length, `Processed ${resolved.toLocaleString()} of ${uniqueIsbns.length.toLocaleString()} unique ISBNs.`);
      renderTable();

    }

    if (state.cancelled) {
      setProgress("Lookup cancelled. Completed results have been kept.");
    } else {
      els.progressBar.value = 100;
      setProgress("Lookup complete.");
    }
  } finally {
    state.running = false;
    els.lookupButton.disabled = false;
    els.cancelButton.hidden = true;
    updateSummary();
    renderTable();
  }
}

async function lookupBatch(isbns) {
  const exact = await lookupExactEditionBatch(isbns);
  const unresolved = isbns.filter(isbn => {
    const result = exact.get(isbn);
    return !result || result.status === "not-found" || result.status === "no-dewey";
  });

  if (!unresolved.length) return exact;

  const workFallback = await lookupWorkBatch(unresolved);

  for (const isbn of unresolved) {
    const editionResult = exact.get(isbn);
    const workResult = workFallback.get(isbn);

    if (!workResult || workResult.status === "not-found" || workResult.status === "no-dewey") {
      if (!editionResult && workResult) exact.set(isbn, workResult);
      continue;
    }

    const exactEditionFound = editionResult?.status === "no-dewey";
    exact.set(isbn, {
      ...workResult,
      status: "review",
      confidence: "review",
      source: exactEditionFound
        ? "Open Library work-level fallback after exact edition match"
        : "Open Library work-level fallback",
      note: exactEditionFound
        ? "The exact edition was found, but it has no Dewey value in Open Library. These candidate values are aggregated from editions of the same work and need librarian review."
        : "No edition-level Dewey value was returned. These candidate values are aggregated from editions of the ISBN-matched work and need librarian review."
    });
  }

  return exact;
}

async function lookupExactEditionBatch(isbns) {
  const params = new URLSearchParams({
    bibkeys: isbns.map(isbn => `ISBN:${isbn}`).join(","),
    jscmd: "data",
    format: "json"
  });

  const response = await respectfulFetch(`${OPEN_LIBRARY_BOOKS}?${params.toString()}`);
  const data = await response.json();
  const result = new Map();

  for (const isbn of isbns) {
    const book = data[`ISBN:${isbn}`];

    if (!book) {
      result.set(isbn, makeNotFoundResolution());
      continue;
    }

    const rawDeweys = book.classifications?.dewey_decimal_class;
    const values = (Array.isArray(rawDeweys) ? rawDeweys : rawDeweys ? [rawDeweys] : [])
      .map(cleanDewey)
      .filter(Boolean);
    const deweys = [...new Set(values)];
    const sourceUrl = cleanText(book.url || book.info_url);

    if (!deweys.length) {
      result.set(isbn, {
        status: "no-dewey",
        suggestedDewey: "",
        alternatives: [],
        confidence: "",
        source: "Open Library exact edition",
        sourceUrl,
        sourceTitle: cleanText(book.title),
        note: "Exact ISBN edition found, but Open Library does not list a Dewey value for this edition."
      });
      continue;
    }

    result.set(isbn, {
      status: deweys.length === 1 ? "suggested" : "review",
      suggestedDewey: deweys[0],
      alternatives: deweys.slice(1),
      confidence: deweys.length === 1 ? "high" : "review",
      source: "Open Library exact edition",
      sourceUrl,
      sourceTitle: cleanText(book.title),
      note: deweys.length === 1
        ? "Dewey value returned for this exact ISBN edition."
        : "This exact edition has multiple Dewey values in Open Library; review before applying one."
    });
  }

  return result;
}

async function lookupWorkBatch(isbns) {
  const query = `isbn:(${isbns.map(isbn => `"${isbn}"`).join(" OR ")})`;
  const params = new URLSearchParams({
    q: query,
    fields: "key,title,author_name,isbn,ddc,first_publish_year",
    limit: "100"
  });

  const response = await respectfulFetch(`${OPEN_LIBRARY_SEARCH}?${params.toString()}`);
  const data = await response.json();
  const wanted = new Set(isbns);
  const docsByIsbn = new Map(isbns.map(isbn => [isbn, []]));

  for (const doc of data.docs || []) {
    const docIsbns = (Array.isArray(doc.isbn) ? doc.isbn : [doc.isbn])
      .filter(Boolean)
      .map(normalizeIsbn)
      .filter(Boolean);

    const matches = [...new Set(docIsbns.filter(isbn => wanted.has(isbn)))];
    for (const isbn of matches) docsByIsbn.get(isbn).push(doc);
  }

  const result = new Map();
  for (const isbn of isbns) {
    result.set(isbn, resolveWorkDocs(docsByIsbn.get(isbn) || []));
  }
  return result;
}

async function respectfulFetch(url) {
  const elapsed = Date.now() - lastNetworkRequestAt;
  const waitMs = Math.max(0, REQUEST_DELAY_MS - elapsed);
  if (waitMs) await sleep(waitMs);

  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });
  lastNetworkRequestAt = Date.now();

  if (response.status === 429) {
    throw new Error("Open Library rate limit reached. Wait a little and try again.");
  }
  if (!response.ok) {
    throw new Error(`Open Library returned HTTP ${response.status}`);
  }
  return response;
}

function resolveWorkDocs(docs) {
  if (!docs.length) return makeNotFoundResolution();

  const ddcValues = [];
  for (const doc of docs) {
    const values = Array.isArray(doc.ddc) ? doc.ddc : doc.ddc ? [doc.ddc] : [];
    for (const value of values) {
      const cleaned = cleanDewey(value);
      if (cleaned) ddcValues.push(cleaned);
    }
  }

  const bestDoc = docs[0];
  const sourceUrl = bestDoc?.key
    ? `https://openlibrary.org${String(bestDoc.key).startsWith("/") ? "" : "/works/"}${bestDoc.key}`
    : "";
  const unique = [...new Set(ddcValues)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!unique.length) {
    return {
      status: "no-dewey",
      suggestedDewey: "",
      alternatives: [],
      confidence: "",
      source: "Open Library ISBN-matched work",
      sourceUrl,
      sourceTitle: cleanText(bestDoc?.title),
      note: "Book work found by ISBN, but Open Library did not return a Dewey value."
    };
  }

  if (unique.length === 1) {
    return {
      status: "review",
      suggestedDewey: unique[0],
      alternatives: [],
      confidence: "review",
      source: "Open Library work-level DDC",
      sourceUrl,
      sourceTitle: cleanText(bestDoc?.title),
      note: "One work-level Dewey candidate was found. Open Library aggregates work DDC values across editions, so review it before applying it to this edition."
    };
  }

  return {
    status: "review",
    suggestedDewey: "",
    alternatives: unique,
    confidence: "review",
    source: "Open Library work-level DDC",
    sourceUrl,
    sourceTitle: cleanText(bestDoc?.title),
    note: "Multiple work-level Dewey candidates were found. Open Library aggregates DDC values across editions, so no single candidate was selected automatically."
  };
}

function makeNotFoundResolution() {
  return {
    status: "not-found",
    suggestedDewey: "",
    alternatives: [],
    confidence: "",
    source: "Open Library exact ISBN search",
    sourceUrl: "",
    sourceTitle: "",
    note: "No matching Open Library work was returned for this ISBN."
  };
}

function applyResolution(records, resolution, fromCache) {
  if (!records) return;
  for (const record of records) {
    record.suggestedDewey = resolution.suggestedDewey || "";
    record.alternatives = Array.isArray(resolution.alternatives) ? [...resolution.alternatives] : [];
    record.confidence = resolution.confidence || "";
    record.status = resolution.status || "not-found";
    record.source = resolution.source || "";
    record.sourceUrl = resolution.sourceUrl || "";
    record.sourceTitle = resolution.sourceTitle || "";
    record.note = `${resolution.note || ""}${fromCache ? " (cached)" : ""}`.trim();
  }
}

function updateSummary() {
  const withIsbn = state.records.filter(record => record.isbn).length;
  const withDewey = state.records.filter(record => record.currentDewey).length;
  const unique = [...new Set(state.records.map(record => record.isbn).filter(Boolean))];
  const cached = unique.filter(isbn => Boolean(getCached(isbn))).length;

  els.bookCount.textContent = state.records.length.toLocaleString();
  els.isbnCount.textContent = withIsbn.toLocaleString();
  els.currentDeweyCount.textContent = withDewey.toLocaleString();
  els.cachedCount.textContent = cached.toLocaleString();
}

function renderTable() {
  if (!state.records.length) {
    els.resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state">Load a catalogue to begin.</td></tr>';
    els.resultCount.textContent = "";
    els.pagination.hidden = true;
    return;
  }

  const filter = els.filterSelect.value;
  const filtered = state.records.filter(record => {
    if (filter === "all") return true;
    if (filter === "suggested") return Boolean(record.suggestedDewey);
    if (filter === "completed") return record.completed;
    if (filter === "exact-changed") {
      return !record.completed &&
        record.source === "Open Library exact edition" &&
        Boolean(record.suggestedDewey) &&
        !deweyValuesEqual(record.currentDewey, record.suggestedDewey);
    }
    if (filter === "missing-current") {
      return !record.completed &&
        !cleanDewey(record.currentDewey) &&
        Boolean(record.suggestedDewey);
    }
    if (filter === "already-correct") {
      return !record.completed &&
        Boolean(record.currentDewey) &&
        Boolean(record.suggestedDewey) &&
        deweyValuesEqual(record.currentDewey, record.suggestedDewey);
    }
    return record.status === filter;
  });

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * PAGE_SIZE;
  const pageRecords = filtered.slice(start, start + PAGE_SIZE);

  els.resultCount.textContent = `${filtered.length.toLocaleString()} shown`;
  els.resultsBody.innerHTML = "";

  if (!pageRecords.length) {
    els.resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state">No records match this filter.</td></tr>';
  } else {
    const fragment = document.createDocumentFragment();
    for (const record of pageRecords) fragment.appendChild(renderRow(record));
    els.resultsBody.appendChild(fragment);
  }

  els.pagination.hidden = pages <= 1;
  els.pageLabel.textContent = `Page ${state.page + 1} of ${pages}`;
  els.prevPage.disabled = state.page === 0;
  els.nextPage.disabled = state.page >= pages - 1;
}

function renderRow(record) {
  const tr = document.createElement("tr");

  const statusTd = document.createElement("td");
  statusTd.appendChild(makeBadge(record));

  const titleTd = document.createElement("td");
  const titleDiv = document.createElement("div");
  titleDiv.className = "book-title";
  titleDiv.textContent = record.title || "(No title in export)";
  titleTd.appendChild(titleDiv);
  if (record.bookId) {
    const idDiv = document.createElement("div");
    idDiv.className = "subtle";
    idDiv.textContent = `ID ${record.bookId}`;
    titleTd.appendChild(idDiv);
  }

  const authorTd = document.createElement("td");
  authorTd.textContent = record.author || "—";

  const isbnTd = document.createElement("td");
  isbnTd.textContent = record.isbn || "—";

  const currentTd = document.createElement("td");
  currentTd.textContent = record.currentDewey || "—";

  const suggestedTd = document.createElement("td");
  const input = document.createElement("input");
  input.className = "ddc-input";
  input.type = "text";
  input.value = record.suggestedDewey;
  input.placeholder = "—";
  input.setAttribute("aria-label", `Suggested Dewey for ${record.title || record.isbn || "book"}`);
  input.addEventListener("input", () => {
    record.suggestedDewey = input.value.trim();
  });
  suggestedTd.appendChild(input);
  if (record.alternatives.length) {
    const alt = document.createElement("div");
    alt.className = "subtle";
    alt.textContent = `${record.suggestedDewey ? "Also" : "Candidates"}: ${record.alternatives.join(", ")}`;
    suggestedTd.appendChild(alt);
  }

  const evidenceTd = document.createElement("td");
  evidenceTd.className = "evidence";
  const note = document.createElement("div");
  note.textContent = record.note || "Not looked up yet.";
  evidenceTd.appendChild(note);
  if (record.sourceUrl) {
    const link = document.createElement("a");
    link.href = record.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open Library record";
    evidenceTd.appendChild(link);
  }

  const libraryThingTd = document.createElement("td");
  libraryThingTd.className = "librarything-actions";
  const editUrl = getLibraryThingEditUrl(record);

  if (record.suggestedDewey && editUrl) {
    const writebackButton = document.createElement("button");
    writebackButton.type = "button";
    writebackButton.className = "button primary small";
    writebackButton.textContent = "Copy DDC + Edit";
    writebackButton.addEventListener("click", () => copyAndOpenLibraryThing(record, writebackButton));
    libraryThingTd.appendChild(writebackButton);
  } else if (editUrl) {
    const editLink = document.createElement("a");
    editLink.className = "button quiet small link-button";
    editLink.href = editUrl;
    editLink.target = "_blank";
    editLink.rel = "noopener noreferrer";
    editLink.textContent = "Edit in LibraryThing";
    libraryThingTd.appendChild(editLink);
  }

  const completedLabel = document.createElement("label");
  completedLabel.className = "completed-toggle";
  const completedBox = document.createElement("input");
  completedBox.type = "checkbox";
  completedBox.checked = record.completed;
  completedBox.addEventListener("change", () => {
    record.completed = completedBox.checked;
    setCompleted(record, completedBox.checked);
    renderTable();
  });
  const completedText = document.createElement("span");
  completedText.textContent = "Completed";
  completedLabel.appendChild(completedBox);
  completedLabel.appendChild(completedText);
  libraryThingTd.appendChild(completedLabel);

  [statusTd, titleTd, authorTd, isbnTd, currentTd, suggestedTd, evidenceTd, libraryThingTd]
    .forEach(td => tr.appendChild(td));

  return tr;
}

function deweyValuesEqual(a, b) {
  const left = cleanDewey(a);
  const right = cleanDewey(b);
  return Boolean(left && right && left === right);
}

function getLibraryThingEditUrl(record) {
  const bookId = String(record.bookId || "").trim();
  const workId = String(record.workId || "").trim();

  if (!bookId) return "";
  if (workId) {
    return `https://www.librarything.com/work/${encodeURIComponent(workId)}/edit/${encodeURIComponent(bookId)}`;
  }
  return `https://www.librarything.com/work/edit/${encodeURIComponent(bookId)}`;
}

async function copyAndOpenLibraryThing(record, button) {
  const value = cleanDewey(record.suggestedDewey) || String(record.suggestedDewey || "").trim();
  const url = getLibraryThingEditUrl(record);
  if (!value || !url) return;

  const popup = window.open(url, "_blank", "noopener,noreferrer");
  let copied = false;

  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch (error) {
    console.warn("Clipboard API unavailable", error);
    copied = fallbackCopy(value);
  }

  if (!popup) {
    window.location.href = url;
  }

  const original = button.textContent;
  button.textContent = copied ? "Copied · LibraryThing opened" : "LibraryThing opened";
  setTimeout(() => { button.textContent = original; }, 1800);
}

function fallbackCopy(value) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function completionKey(recordOrBookId, isbn = "") {
  const bookId = typeof recordOrBookId === "object"
    ? String(recordOrBookId.bookId || "").trim()
    : String(recordOrBookId || "").trim();
  const itemIsbn = typeof recordOrBookId === "object"
    ? String(recordOrBookId.isbn || "").trim()
    : String(isbn || "").trim();
  return bookId ? `book:${bookId}` : itemIsbn ? `isbn:${itemIsbn}` : "";
}

function loadCompleted() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPLETED_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isCompleted(bookId, isbn) {
  const key = completionKey(bookId, isbn);
  return Boolean(key && state?.completed?.[key]);
}

function setCompleted(record, value) {
  const key = completionKey(record);
  if (!key) return;
  if (value) state.completed[key] = true;
  else delete state.completed[key];

  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(state.completed));
  } catch (error) {
    console.warn("Could not persist completed state", error);
  }
}

function makeBadge(record) {
  const span = document.createElement("span");
  span.className = "badge neutral";

  if (record.status === "suggested") {
    span.textContent = record.confidence === "high" ? "High confidence" : "Suggested";
    span.className = "badge good";
  } else if (record.status === "review") {
    span.textContent = "Review";
    span.className = "badge warn";
  } else if (record.status === "no-dewey") {
    span.textContent = "No Dewey";
    span.className = "badge warn";
  } else if (record.status === "not-found") {
    span.textContent = "No match";
    span.className = "badge bad";
  } else if (record.status === "error") {
    span.textContent = "Error";
    span.className = "badge bad";
  } else if (record.status === "missing-isbn") {
    span.textContent = "No ISBN";
  } else {
    span.textContent = "Pending";
  }
  return span;
}

function exportDelimited(delimiter, extension) {
  if (!state.records.length) return;

  const helperHeaders = [
    "Dewey_Helper_ISBN",
    "Dewey_Helper_Suggested_Dewey",
    "Dewey_Helper_Alternatives",
    "Dewey_Helper_Status",
    "Dewey_Helper_Confidence",
    "Dewey_Helper_Source",
    "Dewey_Helper_Source_URL",
    "Dewey_Helper_Note",
    "Dewey_Helper_LibraryThing_Edit_URL",
    "Dewey_Helper_Completed"
  ];

  const originalHeaders = state.headers.length ? state.headers : deriveHeaders(state.records.map(r => r.original));
  const headers = [...originalHeaders, ...helperHeaders];

  const lines = [headers.map(value => escapeDelimited(value, delimiter)).join(delimiter)];

  for (const record of state.records) {
    const helper = {
      Dewey_Helper_ISBN: record.isbn,
      Dewey_Helper_Suggested_Dewey: record.suggestedDewey,
      Dewey_Helper_Alternatives: record.alternatives.join(" | "),
      Dewey_Helper_Status: record.status,
      Dewey_Helper_Confidence: record.confidence,
      Dewey_Helper_Source: record.source,
      Dewey_Helper_Source_URL: record.sourceUrl,
      Dewey_Helper_Note: record.note,
      Dewey_Helper_LibraryThing_Edit_URL: getLibraryThingEditUrl(record),
      Dewey_Helper_Completed: record.completed ? "yes" : "no"
    };

    const row = headers.map(header => {
      const value = Object.prototype.hasOwnProperty.call(record.original, header)
        ? record.original[header]
        : helper[header] ?? "";
      return escapeDelimited(value, delimiter);
    });
    lines.push(row.join(delimiter));
  }

  downloadBlob(lines.join("\r\n"), `dewey-helper-results.${extension}`, "text/plain;charset=utf-8");
}

function exportJson() {
  if (!state.records.length) return;

  const output = state.records.map(record => ({
    ...record.original,
    Dewey_Helper_ISBN: record.isbn,
    Dewey_Helper_Suggested_Dewey: record.suggestedDewey,
    Dewey_Helper_Alternatives: record.alternatives,
    Dewey_Helper_Status: record.status,
    Dewey_Helper_Confidence: record.confidence,
    Dewey_Helper_Source: record.source,
    Dewey_Helper_Source_URL: record.sourceUrl,
    Dewey_Helper_Note: record.note,
    Dewey_Helper_LibraryThing_Edit_URL: getLibraryThingEditUrl(record),
    Dewey_Helper_Completed: record.completed
  }));

  downloadBlob(JSON.stringify(output, null, 2), "dewey-helper-results.json", "application/json;charset=utf-8");
}

async function parseExcelExport(file) {
  const XLSX = await loadSheetJs();
  const bytes = await file.arrayBuffer();
  const workbook = XLSX.read(bytes, {
    type: "array",
    dense: true,
    cellDates: false
  });

  if (!workbook.SheetNames?.length) {
    throw new Error("The Excel workbook does not contain any worksheets.");
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false
    });

    const rows = matrix.filter(row =>
      Array.isArray(row) && row.some(cell => cleanText(cell) !== "")
    );
    if (rows.length < 2) continue;

    const headerIndex = findLibraryThingHeaderRow(rows);
    const headers = dedupeHeaders(
      rows[headerIndex].map((value, index) => cleanText(value) || `Column_${index + 1}`)
    );

    const objects = rows.slice(headerIndex + 1)
      .filter(cells => cells.some(cell => cleanText(cell) !== ""))
      .map(cells => {
        const row = {};
        headers.forEach((header, index) => {
          row[header] = cells[index] == null ? "" : cleanText(cells[index]);
        });
        return row;
      });

    if (objects.length) {
      return { headers, rows: objects };
    }
  }

  throw new Error("I could not find catalogue rows in this Excel workbook.");
}

function findLibraryThingHeaderRow(matrix) {
  const maxRows = Math.min(matrix.length, 15);

  for (let i = 0; i < maxRows; i += 1) {
    const names = new Set(matrix[i].map(normalizeHeader));
    const hasTitle = names.has("title");
    const hasIsbn = names.has("isbn") || names.has("isbns");
    const hasCatalogueField =
      names.has("bookid") ||
      names.has("deweydecimal") ||
      names.has("primaryauthor");

    if (hasTitle && hasIsbn && hasCatalogueField) return i;
  }

  return 0;
}

function loadSheetJs() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  if (sheetJsPromise) return sheetJsPromise;

  sheetJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SHEETJS_URL;
    script.async = true;
    script.crossOrigin = "anonymous";

    script.addEventListener("load", () => {
      if (globalThis.XLSX) {
        resolve(globalThis.XLSX);
      } else {
        sheetJsPromise = null;
        reject(new Error("The Excel reader loaded but did not initialise."));
      }
    });

    script.addEventListener("error", () => {
      sheetJsPromise = null;
      reject(new Error("Could not load the Excel reader. Check your internet connection, or export Tab-Delimited Text from LibraryThing instead."));
    });

    document.head.appendChild(script);
  });

  return sheetJsPromise;
}

function parseDelimitedExport(text, delimiter) {
  const matrix = parseDelimited(text.replace(/^\uFEFF/, ""), delimiter)
    .filter(row => row.some(cell => String(cell).trim() !== ""));

  if (matrix.length < 2) throw new Error("The file does not appear to contain a header row and book records.");

  const headers = dedupeHeaders(matrix[0].map(value => cleanText(value) || "Column"));
  const rows = matrix.slice(1).map(cells => {
    const row = {};
    headers.forEach((header, i) => { row[header] = cells[i] ?? ""; });
    return row;
  });

  return { headers, rows };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

function parseJsonExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rows = lines.map(line => JSON.parse(line));
    const headers = deriveHeaders(rows);
    return { headers, rows };
  }

  let rows;
  if (Array.isArray(data)) {
    rows = data;
  } else if (Array.isArray(data.books)) {
    rows = data.books;
  } else if (Array.isArray(data.records)) {
    rows = data.records;
  } else {
    const values = Object.values(data);
    if (values.length && values.every(value => value && typeof value === "object" && !Array.isArray(value))) {
      rows = values;
    } else {
      throw new Error("JSON was valid, but I could not find an array of book records.");
    }
  }

  rows = rows.filter(row => row && typeof row === "object" && !Array.isArray(row));
  return { headers: deriveHeaders(rows), rows };
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs >= commas ? "\t" : ",";
}

function looksLikeJson(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{");
}

function makeHeaderMap(headers) {
  const map = new Map();
  headers.forEach(header => map.set(normalizeHeader(header), header));
  return map;
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pickValue(row, headerMap, candidates) {
  for (const candidate of candidates) {
    const actual = headerMap.get(candidate);
    if (actual && row[actual] != null) return row[actual];
  }
  return "";
}

function extractIsbnCandidates(value) {
  const text = String(value || "").toUpperCase();
  const pattern = /(^|[^0-9X])((?:97[89](?:[-\s]?\d){10})|(?:\d(?:[-\s]?\d){8}[-\s]?[\dX]))(?=$|[^0-9X])/g;
  const candidates = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    candidates.push(normalizeIsbn(match[2]));
  }

  return candidates.filter(isbn => isbn.length === 10 || isbn.length === 13);
}

function normalizeIsbn(value) {
  return String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
}

function isValidIsbn(isbn) {
  if (/^\d{13}$/.test(isbn)) {
    const sum = isbn.slice(0, 12).split("").reduce((acc, digit, i) => acc + Number(digit) * (i % 2 ? 3 : 1), 0);
    const check = (10 - (sum % 10)) % 10;
    return check === Number(isbn[12]);
  }

  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = isbn.split("").reduce((acc, char, i) => {
      const value = char === "X" ? 10 : Number(char);
      return acc + value * (10 - i);
    }, 0);
    return sum % 11 === 0;
  }

  return false;
}

function cleanDewey(value) {
  const cleaned = cleanText(value)
    .replace(/^DDC\s*/i, "")
    .replace(/\//g, "")
    .replace(/\s+/g, "");

  return /^\d{3}(?:\.\d+)?$/.test(cleaned) ? cleaned : "";
}

function cleanText(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(" | ");
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function deriveHeaders(rows) {
  const seen = new Set();
  const headers = [];
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

function dedupeHeaders(headers) {
  const counts = new Map();
  return headers.map(header => {
    const n = (counts.get(header) || 0) + 1;
    counts.set(header, n);
    return n === 1 ? header : `${header}_${n}`;
  });
}

function escapeDelimited(value, delimiter) {
  const text = cleanText(value);
  const mustQuote = text.includes('"') || text.includes("\n") || text.includes("\r") || text.includes(delimiter);
  return mustQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setEnabled(enabled) {
  els.lookupButton.disabled = !enabled;
  els.exportTsv.disabled = !enabled;
  els.exportCsv.disabled = !enabled;
  els.exportJson.disabled = !enabled;
}

function setLoadMessage(message, kind = "") {
  els.loadMessage.textContent = message;
  els.loadMessage.className = `status-line ${kind}`.trim();
}

function setProgress(message) {
  els.progressText.textContent = message;
}

function updateProgress(done, total, message) {
  const pct = total ? Math.round((done / total) * 100) : 100;
  els.progressBar.value = pct;
  setProgress(message);
}

function loadCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getCached(isbn) {
  const entry = state.cache[isbn];
  if (!entry || !entry.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS) {
    delete state.cache[isbn];
    return null;
  }
  return entry.value || null;
}

function putCached(isbn, value) {
  state.cache[isbn] = { fetchedAt: Date.now(), value };
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state.cache));
  } catch (error) {
    console.warn("Could not persist lookup cache", error);
  }
}

function clearCache() {
  state.cache = {};
  localStorage.removeItem(CACHE_KEY);
  updateSummary();
  setLoadMessage("Lookup cache cleared.", "success");
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
