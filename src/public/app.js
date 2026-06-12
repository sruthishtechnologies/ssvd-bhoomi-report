const controls = {
  district: document.querySelector("#district"),
  taluk: document.querySelector("#taluk"),
  hobli: document.querySelector("#hobli"),
  village: document.querySelector("#village"),
  survey: document.querySelector("#survey"),
  surnoc: document.querySelector("#surnoc"),
  hissa: document.querySelector("#hissa"),
  period: document.querySelector("#period"),
  go: document.querySelector("#go"),
  fetch: document.querySelector("#fetch"),
  report: document.querySelector("#report"),
  print: document.querySelector("#print"),
  restart: document.querySelector("#restart"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  resultHtml: document.querySelector("#resultHtml"),
  reportOutput: document.querySelector("#reportOutput"),
  form: document.querySelector("#recordForm"),
  selectAllSections: document.querySelector("#selectAllSections"),
  clearAllSections: document.querySelector("#clearAllSections"),
  reportSections: [...document.querySelectorAll('input[name="reportSection"]')],
};

const disabledReportSections = new Set();

let sessionId = "";
let loading = false;
let currentState = null;

const sequenceAfter = {
  district: ["taluk", "hobli", "village", "surnoc", "hissa", "period"],
  taluk: ["hobli", "village", "surnoc", "hissa", "period"],
  hobli: ["village", "surnoc", "hissa", "period"],
  village: ["surnoc", "hissa", "period"],
  surnoc: ["hissa", "period"],
  hissa: ["period"],
  period: [],
};

function values() {
  const selectedText = (control) => control.options?.[control.selectedIndex]?.textContent || "";
  const selectedSections = controls.reportSections
    .filter((control) => control.checked && !disabledReportSections.has(control.value))
    .map((control) => control.value);
  return {
    district: controls.district.value,
    districtLabel: selectedText(controls.district),
    taluk: controls.taluk.value,
    talukLabel: selectedText(controls.taluk),
    hobli: controls.hobli.value,
    hobliLabel: selectedText(controls.hobli),
    village: controls.village.value,
    villageLabel: selectedText(controls.village),
    survey: controls.survey.value.trim(),
    surnoc: controls.surnoc.value,
    surnocLabel: selectedText(controls.surnoc),
    hissa: controls.hissa.value,
    hissaLabel: selectedText(controls.hissa),
    period: controls.period.value,
    periodLabel: selectedText(controls.period),
    sections: selectedSections,
  };
}

function setStatus(message) {
  controls.status.textContent = message;
}

function isPlaceholderValue(value = "") {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "0" || /^select\b/i.test(normalized) || /ಆಯ್ಕೆ/.test(normalized);
}

function selectedEnabledReportSections() {
  return controls.reportSections
    .filter((control) => control.checked && !control.disabled && !disabledReportSections.has(control.value))
    .map((control) => control.value);
}

function hasRequiredReportInputs() {
  return Boolean(
    sessionId
    && !isPlaceholderValue(controls.district.value)
    && !isPlaceholderValue(controls.taluk.value)
    && !isPlaceholderValue(controls.hobli.value)
    && !isPlaceholderValue(controls.village.value)
    && controls.survey.value.trim()
    && !isPlaceholderValue(controls.surnoc.value)
    && !isPlaceholderValue(controls.hissa.value)
    && selectedEnabledReportSections().length,
  );
}

function setBusy(isBusy) {
  loading = isBusy;
  document.body.classList.toggle("is-loading", isBusy);
  if (isBusy) {
    for (const element of Object.values(controls)) {
      if (element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLInputElement) {
        if (element === controls.restart || element === controls.print || element === controls.selectAllSections || element === controls.clearAllSections) continue;
        element.disabled = true;
      }
    }
    for (const element of controls.reportSections) element.disabled = true;
    return;
  }
  for (const element of controls.reportSections) {
    const disabled = disabledReportSections.has(element.value);
    element.disabled = disabled;
    if (disabled) element.checked = false;
  }
  controls.selectAllSections.disabled = false;
  controls.clearAllSections.disabled = false;
  if (currentState) {
    restoreDisabled(currentState);
  } else {
    controls.restart.disabled = false;
  }
}

function restoreDisabled(state) {
  for (const [key, selectState] of Object.entries(state.selects)) {
    if (controls[key]) controls[key].disabled = selectState.disabled;
  }
  controls.survey.disabled = state.survey.disabled;
  controls.go.disabled = state.survey.disabled || !controls.survey.value.trim();
  controls.fetch.disabled = !state.canFetch;
  controls.report.disabled = false;
  controls.print.disabled = false;
}

function renderSelect(key, state) {
  const select = controls[key];
  const current = select.value;
  select.innerHTML = "";
  for (const option of state.options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    node.selected = option.selected;
    select.append(node);
  }
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function render(state) {
  currentState = state;
  sessionId = state.sessionId;
  for (const key of ["district", "taluk", "hobli", "village", "surnoc", "hissa", "period"]) {
    renderSelect(key, state.selects[key]);
  }
  if (state.survey.value && !controls.survey.value) controls.survey.value = state.survey.value;
  restoreDisabled(state);
}

async function api(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Request failed");
  return data;
}

async function start() {
  setBusy(true);
  setStatus("Connecting...");
  controls.summary.innerHTML = "";
  controls.resultHtml.innerHTML = "";
  controls.reportOutput.innerHTML = "";
  try {
    const state = await api("/api/start");
    render(state);
    setStatus("Ready");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function selectField(field) {
  if (loading || !sessionId) return;
  const value = controls[field].value;
  if (!value || value.startsWith("Select ")) return;
  for (const key of sequenceAfter[field]) {
    if (controls[key]) controls[key].innerHTML = "";
  }
  setBusy(true);
  setStatus(`Loading ${field === "district" ? "taluks" : field === "taluk" ? "hoblis" : field === "hobli" ? "villages" : "options"}...`);
  try {
    const state = await api("/api/select", { sessionId, field, value, values: values() });
    render(state);
    setStatus("Ready");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function loadSurnoc() {
  if (!sessionId || !controls.survey.value.trim()) {
    setStatus("Enter a survey number");
    return;
  }
  setBusy(true);
  setStatus("Loading Surnoc...");
  try {
    const state = await api("/api/go", { sessionId, values: values() });
    render(state);
    setStatus("Choose Surnoc and Hissa");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

function renderSummary(summary) {
  controls.summary.innerHTML = "";
  const labels = {
    district: "District",
    taluk: "Taluk",
    hobli: "Hobli",
    village: "Village",
    survey: "Survey",
    surnoc: "Surnoc",
    hissa: "Hissa",
    owner: "Owner",
    year: "Year",
  };
  for (const [label, value] of Object.entries(summary || {})) {
    if (label.toLowerCase() === "period") continue;
    const row = document.createElement("div");
    row.className = "summary-row";
    row.innerHTML = `<span>${labels[label] || label}</span><strong>${value || "-"}</strong>`;
    controls.summary.append(row);
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function escapeAttr(value = "") {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function renderReport(report) {
  const overview = report.overview || {};
  const chips = [
    ["District", overview.district],
    ["Taluk", overview.taluk],
    ["Hobli", overview.hobli],
    ["Village", overview.village],
    ["Survey", overview.survey],
    ["Surnoc", overview.surnoc],
    ["Hissa", overview.hissa],
  ];

  const rtcRows = (report.rtcRows || []).map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.period)}</td>
      <td>${escapeHtml(row.year || "-")}</td>
      <td>${escapeHtml(row.village)}</td>
      <td>${escapeHtml([row.survey, row.surnoc, row.hissa].filter(Boolean).join(" / "))}</td>
      <td>${escapeHtml(row.khataNumber || "-")}</td>
      <td>${escapeHtml((row.owners || []).join("; "))}</td>
      <td>${escapeHtml((row.extents || []).join("; "))}</td>
      <td>${escapeHtml((row.ownerCategories || []).join(", "))}</td>
      <td>${escapeHtml((row.govRestrictions || []).join(", ") || "-")}</td>
      <td>${escapeHtml((row.courtStays || []).join(", ") || "-")}</td>
      <td>${escapeHtml((row.alienated || []).join(", ") || "-")}</td>
      <td>${escapeHtml(row.ongoingMutation || "-")}</td>
      <td>${escapeHtml(row.landId || "-")}</td>
    </tr>
  `).join("");

  const hasRtcSection = (report.sections || []).some((section) => /RTC/i.test(section.title));
  const rtcErrors = (report.sections || [])
    .filter((section) => /RTC/i.test(section.title) && section.error)
    .map((section) => `<p class="error">${escapeHtml(section.title)}: ${escapeHtml(section.error)}</p>`)
    .join("");
  const rtcSection = hasRtcSection ? `
    <section class="report-section">
      <div class="section-title"><h3>Complete RTC Details</h3><span>${(report.rtcRows || []).length} RTC row(s)</span></div>
      <div class="table-scroll">
        <table class="rtc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>RTC</th>
              <th>Period</th>
              <th>Year</th>
              <th>Village</th>
              <th>Survey / Surnoc / Hissa</th>
              <th>Khata Number</th>
              <th>Owner(s)</th>
              <th>Extent(s)</th>
              <th>Owner Category</th>
              <th>Gov Restriction</th>
              <th>Court Stay</th>
              <th>Alienated</th>
              <th>Ongoing Mutation</th>
              <th>Land ID</th>
            </tr>
          </thead>
          <tbody>${rtcRows || `<tr><td colspan="15">No RTC rows were returned for this selection.</td></tr>`}</tbody>
        </table>
      </div>
      ${rtcErrors}
    </section>
  ` : "";

  const currentRtcPageRecords = (report.sections || [])
    .filter((section) => section.title === "Current Year RTC")
    .flatMap((section) => section.records || [])
    .filter((record) => record.imageUrl);
  const currentRtcPageSection = currentRtcPageRecords.length ? `
    <section class="report-section current-rtc-report-section">
      <div class="section-title"><h3>Current RTC Official Page</h3><span>Official page copy</span></div>
      ${currentRtcPageRecords.map((record) => `
        <article class="report-record certificate-record">
          <header>
            <strong>${escapeHtml(record.label || "Current RTC official page")}</strong>
            <span>${record.summary?.hasData ? "Information found" : "No structured rows found"}</span>
          </header>
          <table>
            ${(record.summary?.rows || [["Status", "Current RTC official page attached"]]).slice(0, 12).map((row) => (
              `<tr>${row.slice(0, 8).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
            )).join("")}
          </table>
          <img class="${escapeAttr(record.imageClass || "current-rtc-page")}" alt="${escapeAttr(record.label || "Current RTC official page")}" src="${escapeAttr(record.imageUrl)}">
        </article>
      `).join("")}
    </section>
  ` : "";

  const sectionCards = (report.sections || []).filter((section) => !/RTC/i.test(section.title)).map((section) => {
    const records = (section.records || []).map((record) => {
      const rows = record.summary?.rows?.map((row) => (
        `<tr class="${row[0] === "YES" ? "survey-match-row" : ""}">${row.slice(0, 8).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
      )).join("") || "";
      const attachmentBlock = (record.pdfUrl || record.imageUrl) ? `
        ${record.imageUrl
          ? `<img class="${escapeAttr(record.imageClass || "akarband-page")}" alt="${escapeAttr(record.label || "Attached report page")}" src="${escapeAttr(record.imageUrl)}">`
          : `<p>Akarband PDF fetched. Preview image could not be prepared.</p>
            <div class="certificate-actions">
              <a href="${escapeAttr(record.pdfUrl)}" download="${escapeAttr(record.filename || "akarband.pdf")}">Download Akarband certificate</a>
            </div>`}
      ` : "";
      return `
        <article class="report-record${record.pdfUrl || record.imageUrl ? " certificate-record" : ""}">
          <header>
            <strong>${escapeHtml(record.label || "Record")}</strong>
            <span>${record.summary?.hasData ? "Information found" : "No structured rows found"}</span>
          </header>
          ${rows ? `<table>${rows}</table>` : `<p>No structured table was returned for this section.</p>`}
          ${attachmentBlock}
        </article>
      `;
    }).join("");

    const sectionClass = [
      "report-section",
      section.title === "Khatha Number" ? "khatha-report-section" : "",
      section.title === "Akarband" ? "akarband-report-section" : "",
      section.title === "Ownership Map" ? "ownership-map-report-section" : "",
    ].filter(Boolean).join(" ");
    return `
      <section class="${sectionClass}">
        <div class="section-title">
          <h3>${escapeHtml(section.title)}</h3>
          <span>${escapeHtml(section.status || "")}</span>
        </div>
        ${section.error ? `<p class="error">${escapeHtml(section.error)}</p>` : ""}
        ${records || "<p>No records were returned.</p>"}
      </section>
    `;
  }).join("");

  const links = (report.relatedServices || []).map((service) => (
    `<a href="${escapeHtml(service.url)}" target="_blank" rel="noreferrer">${escapeHtml(service.name)}</a>`
  )).join("");

  controls.reportOutput.innerHTML = `
    <div class="report-kpis">
      ${chips.map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value || "-")}</strong></div>`).join("")}
    </div>
    ${rtcSection}
    ${currentRtcPageSection}
    ${sectionCards}
    <section class="report-section related-services-section">
      <div class="section-title"><h3>Other Bhoomi Options</h3><span>Official links</span></div>
      <div class="service-links">${links}</div>
    </section>
  `;
}

async function fetchDetails(event) {
  event.preventDefault();
  if (!sessionId) return;
  setBusy(true);
  setStatus("Fetching record...");
  try {
    const state = await api("/api/fetch", { sessionId, values: values() });
    render(state);
    renderSummary(state.summary);
    controls.resultHtml.innerHTML = "<p>Quick details fetched. Use Build dashboard report for the clean Report Creation</p>";
    setStatus("Record fetched");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function buildDashboardReport() {
  if (!sessionId) {
    setStatus("Page is still connecting. Please wait a moment.");
    return;
  }
  if (!selectedEnabledReportSections().length) {
    setStatus("Select at least one report section");
    return;
  }
  if (!hasRequiredReportInputs()) {
    setStatus("Select district, taluk, hobli, village, survey, surnoc and hissa first");
    return;
  }
  const reportValues = values();
  setBusy(true);
  setStatus("Building dashboard report...");
  try {
    const report = await api("/api/report", { sessionId, values: reportValues });
    renderReport(report);
    setStatus("Dashboard report ready");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

for (const field of ["district", "taluk", "hobli", "village", "surnoc", "hissa", "period"]) {
  controls[field].addEventListener("change", () => selectField(field));
}

controls.survey.addEventListener("input", () => {
  controls.survey.value = controls.survey.value.replace(/\D/g, "").slice(0, 4);
  if (currentState) restoreDisabled(currentState);
});
controls.go.addEventListener("click", loadSurnoc);
controls.form.addEventListener("submit", fetchDetails);
controls.report.addEventListener("click", buildDashboardReport);
controls.selectAllSections.addEventListener("click", () => {
  for (const control of controls.reportSections) {
    if (!control.disabled) control.checked = true;
  }
  setStatus("All report sections selected");
});
controls.clearAllSections.addEventListener("click", () => {
  for (const control of controls.reportSections) {
    if (!control.disabled) control.checked = false;
  }
  setStatus("Report sections cleared");
});
controls.print.addEventListener("click", () => window.print());
controls.restart.addEventListener("click", start);

start();
