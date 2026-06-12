import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const BHOOMI_URL = "https://landrecords.karnataka.gov.in/Service2/";
const MR_STATUS_URL = "https://landrecords.karnataka.gov.in/Service12/MutationStatus.aspx";
const MR_EXTRACT_URL = "https://landrecords.karnataka.gov.in/Service11/MR_MutationExtract.aspx";
const KHATHA_URL = "https://landrecords.karnataka.gov.in/Service64/";
const AKARBAND_BASE_URL = "https://bhoomojini.karnataka.gov.in";
const AKARBAND_API_URL = `${AKARBAND_BASE_URL}/Service39/Home`;
const ADVANCED_RTC_API_URL = "https://landrecords.karnataka.gov.in/service53/ds_rtc.asmx";
const OWNERSHIP_HISTORY_URL = "https://landrecords.karnataka.gov.in/service40/PendcySurveyNoWiseRpt";
const ECHAWADI_BASE_URL = "https://rdservices.karnataka.gov.in";
const ECHAWADI_API_URL = `${ECHAWADI_BASE_URL}/echawadi/Home`;
const REPORT_TASK_TIMEOUT_MS = 60000;
const OLD_RTC_TASK_TIMEOUT_MS = 180000;
const ADVANCED_DETAILS_TASK_TIMEOUT_MS = 90000;
const OWNERSHIP_MAP_TASK_TIMEOUT_MS = 120000;
const REPORT_ENRICH_TIMEOUT_MS = 10000;
const OFFICIAL_FETCH_TIMEOUT_MS = 12000;
const OFFICIAL_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OFFICIAL_PROXY_URL = process.env.OFFICIAL_HTTPS_PROXY || process.env.QUOTAGUARDSTATIC_URL || "";

const sessions = new Map();
const documents = new Map();
let officialProxyDispatcher;

function withReportTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timeoutId)),
    timeout,
  ]);
}

function officialHeaders(headers = {}) {
  return Object.fromEntries(Object.entries({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "accept-language": "en-IN,en;q=0.9,kn;q=0.8",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": OFFICIAL_USER_AGENT,
    ...headers,
  }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function describeRequestError(error) {
  const parts = [];
  for (let item = error; item; item = item.cause) {
    if (item.code) parts.push(item.code);
    if (item.message) parts.push(item.message);
  }
  return [...new Set(parts)].join(" - ") || "network request failed";
}

async function officialFetch(url, options = {}, label = "Official service") {
  const { headers = {}, timeoutMs = OFFICIAL_FETCH_TIMEOUT_MS, retries = 1, ...fetchOptions } = options;
  let lastError;
  if (OFFICIAL_PROXY_URL && !officialProxyDispatcher) {
    const { ProxyAgent } = await import("undici");
    officialProxyDispatcher = new ProxyAgent(OFFICIAL_PROXY_URL);
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...fetchOptions,
        headers: officialHeaders(headers),
        ...(officialProxyDispatcher ? { dispatcher: officialProxyDispatcher } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} request failed: ${describeRequestError(lastError)}`);
}

const currentFields = {
  district: {
    id: "ctl00_MainContent_ddlCDistrict",
    name: "ctl00$MainContent$ddlCDistrict",
    target: "ctl00$MainContent$ddlCDistrict",
  },
  taluk: {
    id: "ctl00_MainContent_ddlCTaluk",
    name: "ctl00$MainContent$ddlCTaluk",
    target: "ctl00$MainContent$ddlCTaluk",
  },
  hobli: {
    id: "ctl00_MainContent_ddlCHobli",
    name: "ctl00$MainContent$ddlCHobli",
    target: "ctl00$MainContent$ddlCHobli",
  },
  village: {
    id: "ctl00_MainContent_ddlCVillage",
    name: "ctl00$MainContent$ddlCVillage",
    target: "ctl00$MainContent$ddlCVillage",
  },
  survey: {
    id: "ctl00_MainContent_txtCSurveyNo",
    name: "ctl00$MainContent$txtCSurveyNo",
    target: "ctl00$MainContent$txtCSurveyNo",
  },
  surnoc: {
    id: "ctl00_MainContent_ddlCSurnocNo",
    name: "ctl00$MainContent$ddlCSurnocNo",
    target: "ctl00$MainContent$ddlCSurnocNo",
  },
  hissa: {
    id: "ctl00_MainContent_ddlCHissaNo",
    name: "ctl00$MainContent$ddlCHissaNo",
    target: "ctl00$MainContent$ddlCHissaNo",
  },
  period: {
    id: "ctl00_MainContent_ddlCPeriod",
    name: "ctl00$MainContent$ddlCPeriod",
    target: "ctl00$MainContent$ddlCPeriod",
  },
  year: {
    id: "ctl00_MainContent_ddlCYear",
    name: "ctl00$MainContent$ddlCYear",
  },
};

const oldFields = {
  district: {
    id: "ctl00_MainContent_ddlODist",
    name: "ctl00$MainContent$ddlODist",
    target: "ctl00$MainContent$ddlODist",
  },
  taluk: {
    id: "ctl00_MainContent_ddlOTaluk",
    name: "ctl00$MainContent$ddlOTaluk",
    target: "ctl00$MainContent$ddlOTaluk",
  },
  hobli: {
    id: "ctl00_MainContent_ddlOHobli",
    name: "ctl00$MainContent$ddlOHobli",
    target: "ctl00$MainContent$ddlOHobli",
  },
  village: {
    id: "ctl00_MainContent_ddlOVillage",
    name: "ctl00$MainContent$ddlOVillage",
    target: "ctl00$MainContent$ddlOVillage",
  },
  survey: {
    id: "ctl00_MainContent_txtOSurveyNo",
    name: "ctl00$MainContent$txtOSurveyNo",
    target: "ctl00$MainContent$txtOSurveyNo",
  },
  surnoc: {
    id: "ctl00_MainContent_ddlOSurnocNo",
    name: "ctl00$MainContent$ddlOSurnocNo",
    target: "ctl00$MainContent$ddlOSurnocNo",
  },
  hissa: {
    id: "ctl00_MainContent_ddlOHissaNo",
    name: "ctl00$MainContent$ddlOHissaNo",
    target: "ctl00$MainContent$ddlOHissaNo",
  },
  period: {
    id: "ctl00_MainContent_ddlOPeriod",
    name: "ctl00$MainContent$ddlOPeriod",
    target: "ctl00$MainContent$ddlOPeriod",
  },
  year: {
    id: "ctl00_MainContent_ddlOYear",
    name: "ctl00$MainContent$ddlOYear",
    target: "ctl00$MainContent$ddlOYear",
  },
};

const mutationStatusFields = {
  district: { id: "MainContent_drpdist", name: "ctl00$MainContent$drpdist", target: "ctl00$MainContent$drpdist" },
  taluk: { id: "MainContent_drptaluk", name: "ctl00$MainContent$drptaluk", target: "ctl00$MainContent$drptaluk" },
  hobli: { id: "MainContent_drphobli", name: "ctl00$MainContent$drphobli", target: "ctl00$MainContent$drphobli" },
  village: { id: "MainContent_drpvillage", name: "ctl00$MainContent$drpvillage", target: "ctl00$MainContent$drpvillage" },
  survey: { id: "MainContent_txtSurvey", name: "ctl00$MainContent$txtSurvey", target: "ctl00$MainContent$txtSurvey" },
  surnoc: { id: "MainContent_drpsurnoc", name: "ctl00$MainContent$drpsurnoc", target: "ctl00$MainContent$drpsurnoc" },
  hissa: { id: "MainContent_drphissa", name: "ctl00$MainContent$drphissa", target: "ctl00$MainContent$drphissa" },
};

const mutationExtractFields = {
  district: { id: "ctl00_MainContent_drpdist", name: "ctl00$MainContent$drpdist", target: "ctl00$MainContent$drpdist" },
  taluk: { id: "ctl00_MainContent_drptaluk", name: "ctl00$MainContent$drptaluk", target: "ctl00$MainContent$drptaluk" },
  hobli: { id: "ctl00_MainContent_drphobli", name: "ctl00$MainContent$drphobli", target: "ctl00$MainContent$drphobli" },
  village: { id: "ctl00_MainContent_drpvillage", name: "ctl00$MainContent$drpvillage", target: "ctl00$MainContent$drpvillage" },
  survey: { id: "ctl00_MainContent_txtSurvey", name: "ctl00$MainContent$txtSurvey", target: "ctl00$MainContent$txtSurvey" },
};

const khathaFields = {
  district: { id: "drpdist", name: "drpdist", target: "drpdist" },
  taluk: { id: "drptaluk", name: "drptaluk", target: "drptaluk" },
  hobli: { id: "drphobli", name: "drphobli", target: "drphobli" },
  village: { id: "ddlVillage", name: "ddlVillage", target: "ddlVillage" },
  survey: { id: "txtSurvey", name: "txtSurvey", target: "txtSurvey" },
};

const ownershipHistoryFields = {
  district: { id: "MainContent_drpdist", name: "ctl00$MainContent$drpdist", target: "ctl00$MainContent$drpdist" },
  taluk: { id: "MainContent_drptaluk", name: "ctl00$MainContent$drptaluk", target: "ctl00$MainContent$drptaluk" },
  hobli: { id: "MainContent_ddlHobli", name: "ctl00$MainContent$ddlHobli", target: "ctl00$MainContent$ddlHobli" },
  village: { id: "MainContent_ddlVillage", name: "ctl00$MainContent$ddlVillage", target: "" },
  survey: { id: "MainContent_txtSurvey", name: "ctl00$MainContent$txtSurvey", target: "" },
};

const khathaButtons = {
  fetch: { id: "btnGetReport", name: "btnGetReport", value: "ವರದಿ ಪಡೆಯಿರಿ" },
};

const ownershipHistoryButtons = {
  fetch: { id: "MainContent_Button1", name: "ctl00$MainContent$Button1", value: "Get Report" },
};

const fields = currentFields;

const buttons = {
  go: {
    id: "ctl00_MainContent_btnCGo",
    name: "ctl00$MainContent$btnCGo",
    value: "Go",
  },
  fetch: {
    id: "ctl00_MainContent_btnCFetchDetails",
    name: "ctl00$MainContent$btnCFetchDetails",
    value: "Fetch details",
  },
};

const currentPreviewButton = {
  name: "ctl00$MainContent$btnCPreview",
  value: "View",
};

const oldButtons = {
  tab: { name: "ctl00$MainContent$Tab3", value: "Old Year" },
  go: { id: "ctl00_MainContent_btnOGO", name: "ctl00$MainContent$btnOGO", value: "Go" },
  fetch: { id: "ctl00_MainContent_btnOFetchDetails", name: "ctl00$MainContent$btnOFetchDetails", value: "Fetch details" },
};

const mutationStatusButtons = {
  fetch: { id: "MainContent_btnFetch", name: "ctl00$MainContent$btnFetch", value: "Fetch Details" },
};

const mutationExtractButtons = {
  fetch: { id: "ctl00_MainContent_btnFetch", name: "ctl00$MainContent$btnFetch", value: "Fetch Details" },
};

const relatedServices = [
  { name: "Khata Extract", url: "https://landrecords.karnataka.gov.in/service64/" },
  { name: "Survey Document", url: "https://bhoomojini.karnataka.gov.in/oscitizen/" },
  { name: "Akarband", url: "https://bhoomojini.karnataka.gov.in/service39/" },
  { name: "RTC with sketch", url: "https://rdservices.karnataka.gov.in/BhoomiMaps/" },
  { name: "eChavadi", url: "https://rdservices.karnataka.gov.in/echawadi/" },
  { name: "Survey Sketch", url: "https://rdservices.karnataka.gov.in/service84/" },
  { name: "Record Room Document", url: "https://recordroom.karnataka.gov.in/service4" },
  { name: "Digitally signed RTC and MR", url: "https://rtc.karnataka.gov.in/service78/" },
  { name: "Mutation History", url: "https://landrecords.karnataka.gov.in/service40/PendcySurveyNoWiseRpt" },
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function hiddenValue(html, id) {
  const match = html.match(new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function selectBlock(html, id) {
  const re = new RegExp(`<select\\b([^>]*)id=["']${id}["']([^>]*)>([\\s\\S]*?)<\\/select>`, "i");
  const match = html.match(re);
  if (!match) return { disabled: true, options: [] };

  const tag = `${match[1]} ${match[2]}`;
  const options = [...match[3].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => {
    const attrs = option[1];
    return {
      value: attr(attrs, "value"),
      label: stripTags(option[2]),
      selected: /\bselected\b/i.test(attrs),
    };
  });

  return {
    disabled: /\bdisabled\b/i.test(tag),
    options,
    selected: options.find((option) => option.selected)?.value || "",
  };
}

function inputState(html, id) {
  const match = html.match(new RegExp(`<input\\b[^>]*id=["']${id}["'][^>]*>`, "i"));
  if (!match) return { disabled: true, value: "" };
  return {
    disabled: /\bdisabled\b/i.test(match[0]),
    value: attr(match[0], "value"),
  };
}

function buttonState(html, id) {
  const match = html.match(new RegExp(`<input\\b[^>]*id=["']${id}["'][^>]*>`, "i"));
  return {
    disabled: !match || /\bdisabled\b/i.test(match[0]),
  };
}

function selectedLabel(html, key, value, fieldConfig = fields) {
  const select = selectBlock(html, fieldConfig[key].id);
  return select.options.find((option) => option.value === value)?.label || value || "";
}

function sanitizeResultHtml(html, baseUrl = BHOOMI_URL) {
  const resultMatches = [
    ...html.matchAll(/<div[^>]*class=["'][^"']*(?:panel|well)[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi),
  ]
    .map((match) => match[0])
    .filter((block) => /Lbl|Grid|Details|Mutation|Owner|Cultivator|Land|Survey|Village|Hissa|Period|Revenue/i.test(block));

  const fallback = html.match(/<div id=["']ctl00_MainContent_div1["'][\s\S]*?<div id=["']ctl00_MainContent_Panel2["']/i);
  const raw = resultMatches.join("\n") || fallback?.[0] || "";

  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=["'][^"']*["']/gi, "")
    .replace(/\s(?:src|href)=["'](?!https?:|#)([^"']*)["']/gi, ` href="${baseUrl}$1"`)
    .replace(/\sstyle=["'][^"']*["']/gi, "")
    .replace(/\sclass=["'][^"']*["']/gi, "")
    .trim();
}

function officialContentHtml(html, baseUrl = BHOOMI_URL) {
  const updatePanel = html.match(/<div id=["'][^"']*(?:UpdatePanel1|pnl|Panel|div1|Grid)[^"']*["'][\s\S]*?(?:<\/form>|<nav class=["']navbar navbar-default navbar-fixed-bottom)/i);
  const raw = updatePanel?.[0] || sanitizeResultHtml(html, baseUrl) || "";
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<input\b[^>]*type=["']hidden["'][^>]*>/gi, "")
    .replace(/\son\w+=["'][^"']*["']/gi, "")
    .replace(/\s(?:src|href)=["'](?!https?:|#)([^"']*)["']/gi, ` href="${baseUrl}$1"`)
    .replace(/\sstyle=["'][^"']*["']/gi, "")
    .replace(/\sclass=["'][^"']*["']/gi, "")
    .replace(/\s(id|name)=["'][^"']*["']/gi, "")
    .trim();
}

function visibleText(html) {
  return stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<option\b[^>]*>/gi, " ")
  );
}

function extractDataRows(html) {
  const rows = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    const useful = cells.filter(Boolean);
    if (useful.length >= 2) rows.push(useful);
  }
  return rows.slice(0, 80);
}

function extractAllDataRows(html) {
  const rows = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    const useful = cells.filter(Boolean);
    if (useful.length >= 1) rows.push(useful);
  }
  return rows;
}

function summarizeOfficialHtml(html) {
  const text = visibleText(html);
  const rows = extractDataRows(html);
  const hasData = rows.length > 0 || /(owner|mutation|khata|extent|land|cultivator|survey|hissa|transaction|rtc)/i.test(text);
  return {
    hasData,
    text: text.slice(0, 5000),
    rows,
  };
}

function mutationStatusResultText(html) {
  const candidates = [];
  for (const match of html.matchAll(/<(?:span|label|div|td)\b[^>]*(?:id|class)=["'][^"']*(?:lbl|Label|msg|status|Status|result|Result)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|label|div|td)>/gi)) {
    const text = stripTags(match[1]);
    if (/ವಹಿವಾಟಿನ\s*ಸಂಖ್ಯೆ|ಸ್ಥಿತಿ\s*:|Transaction\s*(?:No|Number)\s*:|Status\s*:/i.test(text)) candidates.push(text);
  }
  for (const row of extractAllDataRows(html)) {
    const text = row.join(" ");
    if (/ವಹಿವಾಟಿನ\s*ಸಂಖ್ಯೆ|ಸ್ಥಿತಿ\s*:|Transaction\s*(?:No|Number)\s*:|Status\s*:/i.test(text) && !/Select District|Select Taluk|Select Hobli|Select Village/i.test(text)) {
      candidates.push(text);
    }
  }
  const visible = visibleText(html);
  const focused = visible.match(/(?:ವಹಿವಾಟಿನ\s*ಸಂಖ್ಯೆ\s*:?\s*[^\s,]+\s*,?\s*)?ಸ್ಥಿತಿ\s*:?\s*[^.।]+[.।]?/);
  if (focused) candidates.push(focused[0]);
  const noPending = visible.match(/ಸ್ಥಿತಿ\s*:?\s*ಯಾವುದೇ\s+ಮ್ಯುಟೇಶನ್\s+ಬಾಕಿ\s+ಇರುವುದಿಲ್ಲ[.।]?/);
  if (noPending) candidates.push(noPending[0]);
  return candidates
    .map((value) => value.replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim())
    .find((value) => value && !/Beta Version|Logout|Select District|Select Taluk|Select Village|Surnoc No/i.test(value)) || "";
}

function parseMutationStatusSummary(html) {
  const text = mutationStatusResultText(html);
  const transaction = (text.match(/ವಹಿವಾಟಿನ\s*ಸಂಖ್ಯೆ\s*:?\s*([^\s,]+)/) || text.match(/Transaction\s*(?:No|Number)\s*:?\s*([^\s,]+)/i) || [])[1] || "";
  const statusRaw = (text.match(/ಸ್ಥಿತಿ\s*:?\s*([^]+?)(?=\s*(?:&copy;|©|Disclaimer|BHOOMI MONITORING|All Rights Reserved|Designed|$))/) || text.match(/Status\s*:?\s*([^]+?)(?=\s*(?:&copy;|©|Disclaimer|BHOOMI MONITORING|All Rights Reserved|Designed|$))/i) || [])[1]?.trim() || "";
  const status = statusRaw
    .replace(/&copy;[\s\S]*$/i, "")
    .replace(/©[\s\S]*$/i, "")
    .replace(/BHOOMI MONITORING[\s\S]*$/i, "")
    .replace(/All Rights Reserved[\s\S]*$/i, "")
    .replace(/Beta Version[\s\S]*$/i, "")
    .trim();
  const noPending = /ಯಾವುದೇ\s+ಮ್ಯುಟೇಶನ್\s+ಬಾಕಿ|no\s+mutation\s+pending/i.test(text);
  const rows = [];
  if (transaction || status || noPending) {
    if (transaction) rows.push(["ವಹಿವಾಟಿನ ಸಂಖ್ಯೆ / MR Number", transaction]);
    rows.push(["ಸ್ಥಿತಿ / Status", status || (noPending ? "ಯಾವುದೇ ಮ್ಯುಟೇಶನ್ ಬಾಕಿ ಇರುವುದಿಲ್ಲ" : "-")]);
  }
  return {
    hasData: rows.length > 0,
    text: rows.length ? rows.map((row) => row.join(": ")).join(" | ") : "Mutation status was not returned for this survey.",
    rows: rows.length ? rows : [["ಸ್ಥಿತಿ / Status", "Mutation status was not returned for this survey."]],
  };
}

function parseMutationRegisterSummary(html, values = {}) {
  const summary = summarizeOfficialHtml(html);
  const usefulRows = summary.rows.filter((row) => {
    const joined = row.join(" ");
    return !/BAGALKOTE|BALLARI|BENGALURU|Select District/i.test(joined);
  });
  const headerIndex = usefulRows.findIndex((row) => row.some((cell) => /Survey No/i.test(cell)) && row.some((cell) => /MR Number/i.test(cell)));
  const header = headerIndex >= 0 ? usefulRows[headerIndex] : usefulRows[0] || [];
  const bodyRows = headerIndex >= 0 ? usefulRows.slice(headerIndex + 1) : usefulRows.slice(1);
  const surveyIndex = header.findIndex((cell) => /Survey No/i.test(cell));
  const selectedSurvey = String(values.survey || "").trim();
  const selectedHissa = String(values.hissaLabel || values.hissa || "").trim();
  const filteredRows = bodyRows.filter((row) => {
    const surveyNo = row[surveyIndex] || row.find((cell) => /^\d+\//.test(cell)) || "";
    const parts = surveyNo.split("/");
    if (!selectedSurvey || parts[0] !== selectedSurvey) return false;
    if (!selectedHissa) return true;
    return (parts[2] || "") === selectedHissa;
  });
  const rows = filteredRows.length
    ? [header, ...filteredRows]
    : (header.length ? [header, ["No MR records found for this survey and hissa", ""]] : [["No MR records found for this survey and hissa", ""]]);
  return {
    ...summary,
    hasData: filteredRows.length > 0,
    rows: cleanMrRows(rows),
  };
}

function cleanMrRows(rows) {
  if (!rows.length) return rows;
  const header = rows[0];
  const selectIndex = header.findIndex((cell) => /^(&nbsp;|\s*select\s*)$/i.test(cell));
  if (selectIndex === -1) return rows;
  return rows.map((row) => row.filter((_, index) => index !== selectIndex));
}

function parseKhathaSummary(html) {
  const summary = summarizeOfficialHtml(html);
  const rows = summary.rows.filter((row) => {
    const joined = row.join(" ");
    return !/Select District|BAGALKOTE|BALLARI|BENGALURU/i.test(joined);
  });
  const text = visibleText(html);
  const hasNoRecords = /No\s+Khatha\s+records\s+found|No\s+Khata\s+records\s+found/i.test(text) || rows.some((row) => /No\s+Khatha\s+records\s+found|No\s+Khata\s+records\s+found/i.test(row.join(" ")));
  return {
    hasData: !hasNoRecords && rows.length > 0,
    text: text.slice(0, 1400),
    rows: (!hasNoRecords && rows.length) ? rows : [["No Khatha records found for this survey", ""]],
  };
}

function parseKhathaByNumberSummary(html, khathaNumber) {
  const rows = extractDataRows(html).filter((row) => {
    const joined = row.join(" ");
    return !/Select District|ಜಿಲ್ಲೆಯ ಆಯ್ಕೆ|Select Taluk|ತಾಲ್ಲೂಕಿನ ಆಯ್ಕೆ|Select Hobli|ಹೋಬಳಿಯ ಆಯ್ಕೆ|Select Village|ಗ್ರಾಮದ ಆಯ್ಕೆ/i.test(joined);
  });
  const text = visibleText(html);
  const hasNoRecords = /No\s+Khatha\s+records\s+found|No\s+Khata\s+records\s+found|No\s+records/i.test(text);
  return {
    hasData: !hasNoRecords && rows.length > 1,
    text: text.slice(0, 3000),
    rows: (!hasNoRecords && rows.length) ? rows : [["Status", `No Khatha details returned for Khatha ${khathaNumber}`]],
  };
}

function khathaNumberFromSummary(summary) {
  if (!summary.hasData) return "";
  const flatRows = (summary.rows || []).flat();
  const headerRowIndex = (summary.rows || []).findIndex((row) => row.some((cell) => /khata|khatha|ಖಾತ|ಖತಾ/i.test(cell)));
  if (headerRowIndex >= 0 && summary.rows[headerRowIndex + 1]) {
    const header = summary.rows[headerRowIndex];
    const value = summary.rows[headerRowIndex + 1][header.findIndex((cell) => /khata|khatha|ಖಾತ|ಖತಾ/i.test(cell))];
    if (value) return value;
  }
  const text = [summary.text, ...flatRows].join(" ");
  const value = (text.match(/(?:Khata|Khatha|Katha|ಖಾತ|ಖತಾ)\s*(?:No|Number|ಸಂಖ್ಯೆ)?\s*:?\s*([A-Za-z0-9/-]+)/i) || [])[1] || "";
  return /^(records?|found)$/i.test(value) ? "" : value;
}

const bilingualFields = {
  khata: [/khata?h?|katha/i, /ಖಾತ|ಖತಾ/],
  possession: [/acqui?sition|possession|holding/i, /ಕಬ್ಜೆ|ಸ್ವಾಧೀನ/],
  rights: [/other\s*rights|rights/i, /ಇತರೆ\s*ಹಕ್ಕು|ಹಕ್ಕುಗಳು/],
  liabilities: [/liabil|loan|encumbrance|charge/i, /ಋಣ|ಭಾರ|ಸಾಲ/],
  extent: [/land\s*extent|total\s*extent|extent/i, /ಜಮೀನಿನ\s*ವಿಸ್ತೀರ್ಣ|ವಿಸ್ತೀರ್ಣ/],
};

function matchesAny(value, patterns) {
  const text = String(value ?? "").trim();
  return Boolean(text) && patterns.some((pattern) => pattern.test(text));
}

function meaningfulValue(value) {
  const text = String(value ?? "").trim();
  return text && text !== "-";
}

function firstObjectValue(row, patterns, fallbackKeys = []) {
  for (const key of fallbackKeys) {
    if (meaningfulValue(row?.[key])) return row[key];
  }
  for (const [key, value] of Object.entries(row || {})) {
    if (meaningfulValue(value) && matchesAny(key, patterns)) {
      return value;
    }
  }
  return "";
}

function firstRowValue(rows, patterns) {
  for (let rowIndex = 0; rowIndex < (rows || []).length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      if (!matchesAny(row[cellIndex], patterns)) continue;
      const inlineValue = row[cellIndex + 1];
      if (row.length <= 3 && cellIndex === 0) {
        if (meaningfulValue(inlineValue) && !matchesAny(inlineValue, patterns)) return inlineValue;
        continue;
      }
      const nextRowValue = rows[rowIndex + 1]?.[cellIndex];
      if (meaningfulValue(nextRowValue)) return nextRowValue;
    }
  }
  return "";
}

function firstTextValue(text, patterns) {
  const label = patterns.map((pattern) => pattern.source).join("|");
  const match = String(text || "").match(new RegExp(`(?:${label})\\s*(?:ನಂ|ಸಂಖ್ಯೆ|No|Number)?\\s*(?::|-)\\s*([^\\n:|]+?)(?=\\s{2,}|\\s+(?:Khata|Khatha|Katha|Owner|Extent|Rights|Liabilities|Acquisition|Possession|ಖಾತ|ಕಬ್ಜೆ|ಸ್ವಾಧೀನ|ಇತರೆ|ಋಣ)|$)`, "i"));
  return match?.[1]?.trim() || "";
}

function firstSummaryValue(records, patterns) {
  for (const record of records || []) {
    const fromRows = firstRowValue(record.summary?.rows || [], patterns);
    if (fromRows) return fromRows;
    const fromText = firstTextValue(record.summary?.text || "", patterns);
    if (fromText) return fromText;
  }
  return "";
}

function xmlEscape(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapSvgText(value, maxChars = 42) {
  const words = String(value ?? "-").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + " " + word).length <= maxChars) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines.slice(0, 3) : ["-"];
}

function parseOfficialJson(text) {
  const parsed = JSON.parse(text);
  return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
}

async function fetchAkarbandJson(path, payload = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    form.set(key, String(value ?? ""));
  }
  const response = await officialFetch(`${AKARBAND_API_URL}/${path}`, {
    method: "POST",
    headers: {
      referer: `${AKARBAND_BASE_URL}/service39/`,
    },
    body: form,
  }, "Akarband service");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Akarband service returned HTTP ${response.status}`);
  }
  return parseOfficialJson(text || "{}");
}

async function fetchEchawadiJson(path, payload = {}) {
  const response = await officialFetch(`${ECHAWADI_API_URL}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      referer: `${ECHAWADI_BASE_URL}/echawadi/`,
    },
    body: JSON.stringify(payload),
  }, "eChawadi service");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`eChawadi service returned HTTP ${response.status}`);
  }
  if (!text || text === "\"\"" || text === "null") return null;
  return parseOfficialJson(text);
}

async function fetchAdvancedRtcJson(path, payload = {}) {
  const response = await officialFetch(`${ADVANCED_RTC_API_URL}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      referer: "https://landrecords.karnataka.gov.in/service53/RTC",
    },
    body: JSON.stringify(payload),
  }, "Advanced RTC service");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Advanced RTC service returned HTTP ${response.status}`);
  }
  const parsed = parseOfficialJson(text || "{}");
  return typeof parsed.d === "string" ? JSON.parse(parsed.d) : parsed.d;
}

function normalizePlace(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function numberString(value = "") {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const number = Number(normalized);
  return Number.isFinite(number) ? String(number) : normalized;
}

function surveyText(row) {
  return [
    row.SurveyNumbers,
    row.SurveyNo,
    row.Survey_no,
    row.survey_no,
    row.LND_SYNO,
    row.LND_SRNOC,
    row.LND_HISSA,
  ].filter((value) => value !== undefined && value !== null).join(" ");
}

function rowMatchesSurvey(row, values) {
  const selectedSurvey = String(values.survey || "").trim();
  if (!selectedSurvey) return false;
  const text = surveyText(row);
  if (!text) return false;
  const directFields = [row.Survey_no, row.LND_SYNO, row.survey_no].filter((value) => value !== undefined && value !== null);
  if (directFields.some((value) => String(value).trim() === selectedSurvey || String(value).trim().split("/")[0] === selectedSurvey)) return true;
  return new RegExp(`(^|[^0-9])${selectedSurvey}\\s*(?:/|,|$)`).test(String(text));
}

function compactRows(rows, values, mapper) {
  const seen = new Set();
  const uniqueRows = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mapped = uniqueRows.map((row) => {
    const valuesRow = mapper(row).map((value) => value ?? "");
    return [rowMatchesSurvey(row, values) ? "YES" : "", ...valuesRow];
  });
  return mapped.sort((a, b) => {
    if (a[0] === "YES" && b[0] !== "YES") return -1;
    if (a[0] !== "YES" && b[0] === "YES") return 1;
    return 0;
  });
}

function eChawadiSummary(label, rows, values, headers, mapper) {
  const matchingRows = rows.filter((row) => rowMatchesSurvey(row, values));
  const body = compactRows(matchingRows, values, mapper);
  return {
    label,
    summary: {
      hasData: body.length > 0,
      text: body.length ? `${body.length} matching item(s) found` : "No matching records found",
      rows: body.length ? [["Survey Match", ...headers], ...body] : [["Status", "No matching records found for selected survey"]],
    },
  };
}

function selectedSurveyParts(values) {
  return {
    survey: String(values.survey || "").trim(),
    surnoc: String(values.surnocLabel || values.surnoc || "").trim(),
    hissa: String(values.hissaLabel || values.hissa || "").trim(),
  };
}

function surveyPartMatches(actual, selected) {
  if (!selected) return true;
  return String(actual ?? "").trim() === selected;
}

function advancedOwnerRows(details, values) {
  const selected = selectedSurveyParts(values);
  return (details || []).filter((row) => (
    surveyPartMatches(row.survey_no, selected.survey)
      && surveyPartMatches(row.surnoc, selected.surnoc)
      && surveyPartMatches(row.hissa_no, selected.hissa)
  ));
}

function rowsFromObjects(objects, headers, mapper) {
  const body = (objects || []).map((item) => mapper(item).map((value) => value ?? ""));
  return body.length ? [headers, ...body] : [["Status", "No details returned"]];
}

function advancedKhathaNumberFromBlock(block) {
  const ownerNumbers = (block?.ownerdetails || [])
    .map((row) => firstObjectValue(row, bilingualFields.khata, ["Khatanumber", "KhataNumber", "KhataNo", "KhathaNumber"]))
    .filter(Boolean);
  return uniq(ownerNumbers).join(", ");
}

function advancedRecordsFromRtcData(rtcData, ownerRows) {
  const block = Array.isArray(rtcData) ? rtcData.find(Boolean) : null;
  const records = [
    {
      label: "Service53 survey owner records",
      summary: {
        hasData: ownerRows.length > 0,
        text: ownerRows.length ? `${ownerRows.length} matching owner record(s)` : "No matching owner records returned",
        rows: rowsFromObjects(ownerRows, ["Owner", "Survey", "Surnoc", "Hissa", "Land Code", "Owner Nos"], (row) => [
          row.owner,
          row.survey_no,
          row.surnoc,
          row.hissa_no,
          row.land_code,
          [row.main_owner_no, row.owner_no].filter(Boolean).join(" / "),
        ]),
      },
    },
  ];

  if (!block) {
    records.push({
      label: "Advanced RTC detail status",
      summary: {
        hasData: false,
        text: "The official Service53 RTC detail service did not return extended fields for this selection.",
        rows: [["Status", "Advanced RTC details were not returned by the official service"]],
      },
    });
    return records;
  }

  records.push({
    label: "ಜಮೀನಿನ ವಿಸ್ತೀರ್ಣ / Land extent and revenue",
    summary: {
      hasData: Boolean(block.landdetails?.length),
      text: "Land extent, revenue, kharab, soil, and patta details",
      rows: rowsFromObjects(block.landdetails, ["Survey", "Hissa", "Total Extent", "Karab A", "Karab B", "Balance", "Revenue", "Water Rate", "Cesses", "Patta", "Soil"], (row) => [
        row.Surveyno,
        row.Hissa,
        row.Totalextent,
        row.Phodkharaba,
        row.Phodkharabb,
        row.Balanceextents,
        row.Landrevenue || row.Totalrevenue,
        row.Waterrate,
        row.Cesses,
        row.Patta,
        row.Soiltype,
      ]),
    },
  });
  records.push({
    label: "ಖಾತೆ ನಂ / 10. ಕಬ್ಜೆ ಅಥವಾ ಸ್ವಾಧೀನತೆಯ ರೀತಿ / ಋಣಗಳು",
    summary: {
      hasData: Boolean(block.ownerdetails?.length),
      text: "Owner khata, acquisition, rights, and liabilities",
      rows: rowsFromObjects(block.ownerdetails, ["Owner", "Extent", "Khata No", "Acquisition / Possession", "Rights", "Liabilities"], (row) => [
        [row.Ownername, row.Relation, row.Relative].filter(Boolean).join(" "),
        row.Ownerextents || firstObjectValue(row, bilingualFields.extent, ["OwnerExtent", "Extent"]),
        firstObjectValue(row, bilingualFields.khata, ["Khatanumber", "KhataNumber", "KhataNo", "KhathaNumber"]),
        firstObjectValue(row, bilingualFields.possession, ["Acquistiondetails", "Acquisitiondetails", "Possessiondetails"]),
        firstObjectValue(row, bilingualFields.rights, ["Rights", "OtherRights"]),
        firstObjectValue(row, bilingualFields.liabilities, ["Liablities", "Liabilities"]),
      ]),
    },
  });
  records.push({
    label: "12. ಸಾಗುವಳಿ ಮತ್ತು ಗೇಣಿಯ ವಿವರಗಳು / Cultivation and tenancy",
    summary: {
      hasData: Boolean(block.cultivator?.length),
      text: "Cultivator, crop, land utilization, water source, and tenancy details",
      rows: rowsFromObjects(block.cultivator, ["Year / Season", "Cultivator", "Cultivation Type", "Extent", "Tenant Amount", "Land Use", "Crop", "Crop Extent", "Water Source", "Yield / Acre"], (row) => [
        [row.Yearname, row.Seasonname].filter(Boolean).join(" "),
        [row.Culti_name, row.Cult_relationship, row.Cult_relativename].filter(Boolean).join(" "),
        row.Cultivationtype,
        row.Cultivationextent,
        row.Tenantamount,
        [row.Landutilzation_classification, row.Landutilization_extent, row.Landclassification].filter(Boolean).join(" / "),
        row.Cropname || row.Mixed_mixturename,
        row.Totalcropextent || row.Singlecropextent || row.Mixedcropextent,
        row.Watersource,
        row.Yielsperacre,
      ]),
    },
  });
  records.push({
    label: "ನೀರಾವರಿ ಮತ್ತು ಮರಗಳು / Irrigation and trees",
    summary: {
      hasData: Boolean(block.irrigation?.length || block.tree?.length),
      text: "Irrigation and tree details",
      rows: [
        ...rowsFromObjects(block.irrigation, ["Type", "Water Source", "Kharif", "Rabi", "Garden", "Total"], (row) => [
          "Irrigation",
          row.Watersource,
          row.Kharifextents,
          row.Rabiextent,
          row.Gardenextent,
          row.Totalextent,
        ]),
        ...((block.tree || []).length ? rowsFromObjects(block.tree, ["Type", "Tree", "Count"], (row) => ["Tree", row.Treename, row.Numberoftrees]).slice(1) : []),
      ],
    },
  });
  return records;
}

function advancedFallbackRecordsFromRtcSection(rtcSection) {
  const rtcRows = rtcSection?.rtcRows || [];
  const records = [];
  if (rtcRows.length) {
    records.push({
      label: "RTC owner, extent, and restrictions",
      summary: {
        hasData: true,
        text: "Advanced Details fallback parsed from the current RTC table because Service53 returned no extended detail payload.",
        rows: rowsFromObjects(rtcRows, ["Owner(s)", "Extent(s)", "Khata Number", "Owner Category", "Gov Restriction", "Court Stay", "Alienated", "Land ID"], (row) => [
          (row.owners || []).join("; "),
          (row.extents || []).join("; "),
          row.khataNumber,
          (row.ownerCategories || []).join(", "),
          (row.govRestrictions || []).join(", "),
          (row.courtStays || []).join(", "),
          (row.alienated || []).join(", "),
          row.landId,
        ]),
      },
    });
  }

  const rtcRecords = rtcSection?.records || [];
  const khata = firstSummaryValue(rtcRecords, bilingualFields.khata);
  const possession = firstSummaryValue(rtcRecords, bilingualFields.possession);
  const rights = firstSummaryValue(rtcRecords, bilingualFields.rights);
  const liabilities = firstSummaryValue(rtcRecords, bilingualFields.liabilities);
  const extent = firstSummaryValue(rtcRecords, bilingualFields.extent);
  const detailRows = [
    ["Khata Number / ಖಾತೆ ನಂ", khata || "-"],
    ["10. Acquisition or possession / ಕಬ್ಜೆ ಅಥವಾ ಸ್ವಾಧೀನತೆಯ ರೀತಿ", possession || "-"],
    ["11. Other rights / ಇತರೆ ಹಕ್ಕುಗಳು", rights || "-"],
    ["11. Liabilities / ಋಣಗಳು", liabilities || "-"],
    ["Land extent / ಜಮೀನಿನ ವಿಸ್ತೀರ್ಣ", extent || "-"],
  ];
  records.push({
    label: "Bilingual RTC label extraction",
    summary: {
      hasData: detailRows.some((row) => row[1] !== "-"),
      text: "Kannada and English labels parsed from the available RTC detail text.",
      rows: detailRows,
    },
  });
  return records;
}

function advancedSnapshotItems(records) {
  const items = [];
  for (const record of records || []) {
    if (/status/i.test(record.label || "")) continue;
    const rows = record.summary?.rows || [];
    if (!rows.length) continue;
    items.push({
      kind: "heading",
      text: record.label || "Advanced RTC details",
    });
    const headers = rows[0] || [];
    const body = rows.slice(1);
    for (const row of body) {
      if (!row.some(meaningfulValue)) continue;
      const label = row.length === 2
        ? row[0]
        : headers.map((header, index) => [header, row[index]].filter(meaningfulValue).join(": ")).filter(Boolean).join(" | ");
      const value = row.length === 2 ? row[1] : "";
      items.push({ kind: "row", label, value });
    }
  }
  return items;
}

function advancedSnapshotSvg(values, records) {
  const items = advancedSnapshotItems(records);
  const width = 1400;
  const lineHeight = 24;
  const rowGap = 12;
  let y = 34;
  const blocks = [];
  const addText = (x, yPos, text, size = 18, weight = 500, fill = "#4f5f6d") => {
    const lines = wrapSvgText(text, x > 420 ? 58 : 34);
    lines.forEach((line, index) => {
      blocks.push(`<text x="${x}" y="${yPos + index * lineHeight}" font-size="${size}" font-weight="${weight}" fill="${fill}">${xmlEscape(line)}</text>`);
    });
    return lines.length * lineHeight;
  };

  blocks.push(`<rect x="0" y="0" width="${width}" height="100%" fill="#ffffff"/>`);
  blocks.push(`<text x="18" y="${y}" font-size="24" font-weight="700" fill="#1f2933">Advanced RTC Details</text>`);
  blocks.push(`<text x="640" y="${y}" font-size="18" font-weight="700" fill="#1f2933">Sri SatVam Bhoomi Data Reader</text>`);
  y += 38;

  const surveyLine = [
    `District: ${values.districtLabel || values.district || "-"}`,
    `Taluk: ${values.talukLabel || values.taluk || "-"}`,
    `Hobli: ${values.hobliLabel || values.hobli || "-"}`,
    `Village: ${values.villageLabel || values.village || "-"}`,
    `Survey: ${[values.survey, values.surnocLabel || values.surnoc, values.hissaLabel || values.hissa].filter(Boolean).join(" / ") || "-"}`,
  ].join("    ");
  blocks.push(`<text x="18" y="${y}" font-size="16" fill="#52616f">${xmlEscape(surveyLine)}</text>`);
  y += 30;

  for (const item of items) {
    if (item.kind === "heading") {
      blocks.push(`<rect x="0" y="${y - 18}" width="${width}" height="34" fill="#4f83bd"/>`);
      blocks.push(`<text x="18" y="${y + 5}" font-size="18" font-weight="700" fill="#ffffff">${xmlEscape(item.text)}</text>`);
      y += 42;
      continue;
    }
    const valueHeight = Math.max(addText(18, y, item.label, 16, 700), addText(580, y, item.value || "", 16, 500));
    blocks.push(`<line x1="18" y1="${y + valueHeight + 4}" x2="${width - 18}" y2="${y + valueHeight + 4}" stroke="#d8e0e7" stroke-width="1"/>`);
    y += valueHeight + rowGap;
  }

  if (!items.length) {
    blocks.push(`<text x="18" y="${y}" font-size="18" fill="#52616f">No Advanced RTC page details were returned for this selection.</text>`);
    y += 32;
  }

  const height = Math.max(520, y + 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:Arial,'Noto Sans Kannada','Noto Sans',sans-serif;}</style>
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
    ${blocks.join("\n")}
  </svg>`;
}

function storeAdvancedSnapshot(values, records) {
  const svg = advancedSnapshotSvg(values, records);
  const filename = `advanced-rtc-${values.survey || "record"}.svg`;
  return storeDocument(Buffer.from(svg, "utf8"), "image/svg+xml", filename);
}

function surveyPattern(value) {
  return /^\d+\s*\/\s*[^/]+\s*\/\s*[^/\s]+/.test(String(value || "").trim());
}

function parseExtentValue(value = "") {
  const text = stripTags(String(value));
  return (text.match(/(?:ಒಟ್ಟು|Total)\s*:?\s*([0-9.]+)/i)
    || text.match(/(?:ಖರಾಬ್\s*\(ಅ\)|Kharab\s*A)\s*:?\s*([0-9.]+)/i)
    || text.match(/(?:ಖರಾಬ್\s*\(ಬ\)|Kharab\s*B)\s*:?\s*([0-9.]+)/i)
    || [])[1] || "";
}

function mutationNature(type = "", acquisition = "") {
  const joined = `${type} ${acquisition}`;
  if (/ಫೋಡಿ|ವಿಭಜನೆ|partition|split|podi/i.test(joined)) return "Partition / split";
  if (/ಕೋರ್ಟ್|court/i.test(joined)) return "Court order / transfer";
  if (/ಕ್ರಯ|sale|purchase/i.test(joined)) return "Purchase / sale";
  if (/ಹಕ್ಕು|ಋಣ|bank|loan|charge|obligation|ಆಧಾರ|ಭೋಗ್ಯ/i.test(joined)) return "Rights / bank charge";
  if (/ಖಾತೆ|ಪೌತಿ|pauti|katha|khata/i.test(joined)) return "Khata / pauti change";
  return [type, acquisition].filter(Boolean).join(" / ") || "-";
}

function selectedSurveyKey(values) {
  return [values.survey, values.surnocLabel || values.surnoc, values.hissaLabel || values.hissa]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

function parseOwnershipHistoryReport(html, values) {
  const rows = extractAllDataRows(html);
  const headerIndex = rows.findIndex((row) => {
    const joined = row.join(" ");
    return /Survey No/i.test(joined) && /MR\s*Number|Mutation Type|Sl\s*No/i.test(joined);
  });
  const mutationRows = [];
  if (headerIndex >= 0) {
    for (const row of rows.slice(headerIndex + 1)) {
      if (row.length < 8 || !/^\d+$/.test(row[0] || "")) break;
      mutationRows.push({
        slNo: row[0],
        surveyNo: row[1],
        year: row[2],
        transactionNo: row[3],
        mrNo: row[4],
        mrDisplay: `MR ${row[4]}/${row[2]}`,
        mutationType: row[5],
        acquisitionType: row[6],
        approveDate: row[7],
        nature: mutationNature(row[5], row[6]),
        focus: selectedSurveyKey(values) && row[1] === selectedSurveyKey(values) ? "YES" : "",
      });
    }
  }

  const landDetails = [];
  let stage = "";
  let activeLand = null;
  for (const row of rows) {
    const joined = row.join(" ");
    if (/ಈಗಿನ|Current/i.test(joined) && /ಸರ್ವೇ|Survey/i.test(joined)) stage = "Before / existing";
    if (/ಹೊಸ|New/i.test(joined) && /ಸರ್ವೇ|Survey/i.test(joined)) stage = "After / new";
    if (surveyPattern(row[0]) && /ಒಟ್ಟು|Total/i.test(row[1] || "")) {
      activeLand = {
        stage,
        surveyNo: row[0],
        totalExtent: parseExtentValue(row[1]),
        revenue: (row[2] || "").replace(/ಕಂದಾಯ\s*:?\s*/i, "").trim(),
        patta: row[3] || "",
        soil: row[4] || "",
        kharabA: "",
        kharabB: "",
      };
      landDetails.push(activeLand);
    } else if (activeLand && /ಖರಾಬ್\s*\(ಅ\)|Kharab\s*A/i.test(row[1] || "")) {
      activeLand.kharabA = parseExtentValue(row[1]);
    } else if (activeLand && /ಖರಾಬ್\s*\(ಬ\)|Kharab\s*B/i.test(row[1] || "")) {
      activeLand.kharabB = parseExtentValue(row[1]);
    }
  }

  const ownerPositions = rows
    .filter((row) => row.length === 3
      && surveyPattern(row[0])
      && (!values.survey || String(row[0]).startsWith(`${values.survey}/`))
      && /[0-9]+\.[0-9.]+/.test(row[2] || "")
      && !/MR\s*T|Rs\.?|BANK/i.test(row[1] || ""))
    .map((row) => ({
      surveyNo: row[0],
      owner: row[1],
      ownerExtent: row[2],
    }));

  const finalPositions = ownerPositions.map((owner) => {
    const land = [...landDetails].reverse().find((item) => item.stage === "After / new" && item.surveyNo === owner.surveyNo)
      || [...landDetails].reverse().find((item) => item.surveyNo === owner.surveyNo);
    return { ...owner, ...land };
  });

  return {
    html,
    rows,
    mutationRows,
    landDetails,
    finalPositions,
    text: visibleText(html),
  };
}

function ownershipInsightRows(data, values) {
  const latest = data.mutationRows[0];
  const focusRows = data.mutationRows.filter((row) => row.focus === "YES" || !selectedSurveyKey(values) || row.surveyNo.startsWith(`${values.survey}/`));
  const finalSurveys = uniq(data.finalPositions.map((row) => row.surveyNo));
  return [
    ["Mutation entries found", String(data.mutationRows.length)],
    ["Focused survey chain", focusRows.length ? `${focusRows.length} matching / related entries` : "No exact hissa match found"],
    ["Latest MR", latest ? `${latest.mrDisplay} on ${latest.approveDate} (${latest.nature})` : "-"],
    ["Final survey position", finalSurveys.length ? finalSurveys.join(", ") : "-"],
  ];
}

function ownershipMapSvg(values, data) {
  const width = 1600;
  const height = 1050;
  const focus = selectedSurveyKey(values) || `${values.survey || "-"}`;
  const latestRows = data.mutationRows.slice(0, 5);
  const finalRows = data.finalPositions.slice(0, 4);
  const insightRows = ownershipInsightRows(data, values);
  const blocks = [];
  const rect = (x, y, w, h, stroke = "#83aaf7", fill = "#fff", r = 10) => blocks.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
  const text = (x, y, value, size = 20, weight = 500, fill = "#16213e") => {
    wrapSvgText(value, Math.max(18, Math.floor((width - x - 40) / (size * 0.46)))).forEach((line, index) => {
      blocks.push(`<text x="${x}" y="${y + index * (size + 5)}" font-size="${size}" font-weight="${weight}" fill="${fill}">${xmlEscape(line)}</text>`);
    });
  };
  const arrow = (x1, y1, x2, y2) => blocks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0b4db3" stroke-width="5" marker-end="url(#arrow)"/>`);

  blocks.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#f7fbff"/>`);
  text(150, 54, "Land Derivation & Mutation Dashboard", 42, 800, "#071b7a");
  text(150, 92, `Survey No. ${focus} - ${values.villageLabel || values.village || ""}, ${values.hobliLabel || values.hobli || ""}, ${values.talukLabel || values.taluk || ""}`, 21, 500, "#111827");
  rect(1125, 24, 440, 54, "#555", "#fff", 8);
  text(1142, 59, "Source: Bhoomi Encumbrance / MR History Report", 19, 700, "#071b7a");

  const chips = [
    ["District", values.districtLabel || values.district || "-"],
    ["Taluk", values.talukLabel || values.taluk || "-"],
    ["Hobli", values.hobliLabel || values.hobli || "-"],
    ["Village", values.villageLabel || values.village || "-"],
    ["Parent Survey", values.survey || "-"],
    ["Focus Hissa", focus],
  ];
  chips.forEach(([label, value], index) => {
    const x = 24 + index * 260;
    rect(x, 118, 245, 84);
    text(x + 18, 150, label, 17, 500, "#26364a");
    text(x + 18, 178, value, 21, 800, index === 5 ? "#067333" : "#111827");
  });

  blocks.push(`<rect x="24" y="220" width="1540" height="38" rx="8" fill="#0b4db3"/>`);
  text(46, 248, "1. Main MR History Summary", 23, 800, "#fff");
  latestRows.slice(0, 3).forEach((row, index) => {
    const x = 50 + index * 500;
    rect(x, 275, 455, 166, "#9dc0ff");
    blocks.push(`<circle cx="${x + 38}" cy="314" r="24" fill="#0b4db3"/>`);
    text(x + 29, 323, String(index + 1), 24, 800, "#fff");
    text(x + 86, 309, row.mrDisplay, 24, 800, "#071b7a");
    text(x + 86, 345, `Date: ${row.approveDate}`, 17, 600);
    text(x + 86, 373, `Nature: ${row.nature}`, 17, 600);
    text(x + 86, 401, `Survey: ${row.surveyNo}`, 17, 600);
    text(x + 86, 429, `Type: ${[row.mutationType, row.acquisitionType].filter(Boolean).join(" / ")}`, 16, 500, "#2d3748");
  });

  rect(24, 466, 760, 265, "#1c76b7");
  blocks.push(`<rect x="24" y="466" width="350" height="38" rx="8" fill="#0b4db3"/>`);
  text(46, 494, "2. Easy Land Derivation Map", 23, 800, "#fff");
  const mapNodes = [
    [`Parent Survey`, `${values.survey || "-"} / history`],
    [latestRows.at(-1)?.mrDisplay || "Old MR", latestRows.at(-1)?.nature || "Start"],
    [latestRows[0]?.mrDisplay || "Latest MR", latestRows[0]?.nature || "Latest mutation"],
    ["Final Position", finalRows.map((row) => row.surveyNo).join(" & ") || focus],
  ];
  mapNodes.forEach(([label, value], index) => {
    const x = 42 + index * 180;
    rect(x, 532, 150, 122, index === 0 ? "#008b5a" : "#9dc0ff");
    text(x + 16, 565, label, 17, 800, index === 0 ? "#067333" : "#071b7a");
    text(x + 16, 604, value, 17, 700, "#111827");
    if (index < mapNodes.length - 1) arrow(x + 150, 593, x + 176, 593);
  });
  text(58, 694, finalRows.length > 1 ? "Split / partition style final position detected from mutation history." : "Mutation history chain prepared from official Service40 report.", 19, 600, "#075985");

  rect(806, 466, 758, 265, "#1c76b7");
  blocks.push(`<rect x="806" y="466" width="350" height="38" rx="8" fill="#0b4db3"/>`);
  text(828, 494, "3. Record Movement Timeline", 23, 800, "#fff");
  const timeline = data.mutationRows.slice().reverse().slice(0, 6);
  if (timeline.length) {
    const startX = 850;
    const gap = 112;
    blocks.push(`<line x1="${startX}" y1="575" x2="${startX + gap * (timeline.length - 1)}" y2="575" stroke="#0b4db3" stroke-width="4"/>`);
    timeline.forEach((row, index) => {
      const x = startX + index * gap;
      blocks.push(`<circle cx="${x}" cy="575" r="28" fill="#fff" stroke="#0b4db3" stroke-width="4"/>`);
      text(x - 28, 535, row.year.split("-")[0], 15, 700, "#071b7a");
      text(x - 44, 630, row.mrDisplay, 14, 700);
      text(x - 44, 650, row.nature, 13, 500, "#2d3748");
    });
  }

  blocks.push(`<rect x="24" y="752" width="1540" height="170" rx="12" fill="#ffffff" stroke="#008b5a" stroke-width="2"/>`);
  blocks.push(`<rect x="24" y="752" width="360" height="42" rx="8" fill="#0b4db3"/>`);
  text(46, 782, "4. Final Position as per Report", 23, 800, "#fff");
  finalRows.forEach((row, index) => {
    const x = 55 + index * 370;
    text(x, 835, row.surveyNo, 27, 800, "#067333");
    text(x, 865, `Owner: ${row.owner}`, 16, 600);
    text(x, 890, `Owner extent: ${row.ownerExtent || "-"}`, 16, 700, "#111827");
    text(x, 915, `Total with kharab: ${row.totalExtent || "-"}`, 16, 600);
  });

  blocks.push(`<rect x="24" y="938" width="250" height="86" rx="10" fill="#0b4db3"/>`);
  text(70, 990, "Key Insight", 30, 800, "#fff");
  insightRows.slice(0, 3).forEach((row, index) => {
    const x = 310 + index * 410;
    blocks.push(`<circle cx="${x}" cy="980" r="26" fill="#0b4db3"/>`);
    text(x - 7, 989, String(index + 1), 24, 800, "#fff");
    text(x + 42, 965, row[0], 18, 800, "#111827");
    text(x + 42, 995, row[1], 17, 500, "#111827");
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#0b4db3"/></marker></defs>
    <style>text{font-family:Arial,'Noto Sans Kannada','Noto Sans',sans-serif;}</style>
    ${blocks.join("\n")}
  </svg>`;
}

function storeOwnershipMap(values, data) {
  const svg = ownershipMapSvg(values, data);
  const filename = `ownership-map-${values.survey || "record"}.svg`;
  return storeDocument(Buffer.from(svg, "utf8"), "image/svg+xml", filename);
}

function tableSnapshotSvg(title, values, rows) {
  const width = 1400;
  const columnCount = Math.max(1, Math.max(...(rows || [[]]).map((row) => row.length)));
  const columnWidth = Math.floor((width - 48) / columnCount);
  const lineHeight = 20;
  let y = 34;
  const blocks = [];
  blocks.push(`<rect x="0" y="0" width="${width}" height="100%" fill="#ffffff"/>`);
  blocks.push(`<text x="24" y="${y}" font-size="28" font-weight="800" fill="#0b4db3">${xmlEscape(title)}</text>`);
  y += 34;
  const surveyLine = [
    `District: ${values.districtLabel || values.district || "-"}`,
    `Taluk: ${values.talukLabel || values.taluk || "-"}`,
    `Hobli: ${values.hobliLabel || values.hobli || "-"}`,
    `Village: ${values.villageLabel || values.village || "-"}`,
    `Survey: ${[values.survey, values.surnocLabel || values.surnoc, values.hissaLabel || values.hissa].filter(Boolean).join(" / ") || "-"}`,
  ].join("    ");
  blocks.push(`<text x="24" y="${y}" font-size="16" fill="#52616f">${xmlEscape(surveyLine)}</text>`);
  y += 32;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const wrapped = Array.from({ length: columnCount }, (_, index) => wrapSvgText(row[index] || "", Math.max(18, Math.floor(columnWidth / 9))));
    const rowHeight = Math.max(42, 16 + Math.max(...wrapped.map((lines) => lines.length)) * lineHeight);
    const fill = rowIndex === 0 ? "#eaf2ff" : rowIndex % 2 ? "#ffffff" : "#f8fafc";
    blocks.push(`<rect x="24" y="${y - 22}" width="${width - 48}" height="${rowHeight}" fill="${fill}" stroke="#d8e0e7" stroke-width="1"/>`);
    for (let column = 0; column < columnCount; column += 1) {
      const x = 34 + column * columnWidth;
      wrapped[column].forEach((line, index) => {
        blocks.push(`<text x="${x}" y="${y + index * lineHeight}" font-size="${rowIndex === 0 ? 16 : 15}" font-weight="${rowIndex === 0 ? 800 : 500}" fill="#1f2933">${xmlEscape(line)}</text>`);
      });
      if (column > 0) {
        blocks.push(`<line x1="${24 + column * columnWidth}" y1="${y - 22}" x2="${24 + column * columnWidth}" y2="${y - 22 + rowHeight}" stroke="#d8e0e7" stroke-width="1"/>`);
      }
    }
    y += rowHeight;
  }

  const height = Math.max(360, y + 30);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text{font-family:Arial,'Noto Sans Kannada','Noto Sans',sans-serif;}</style>
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
    ${blocks.join("\n")}
  </svg>`;
}

function storeTableSnapshot(title, values, rows, filename) {
  const svg = tableSnapshotSvg(title, values, rows);
  return storeDocument(Buffer.from(svg, "utf8"), "image/svg+xml", filename);
}

function previewRtcImageUrl(html, baseUrl = BHOOMI_URL) {
  const imgMatch = html.match(/<img\b[^>]*(?:id=["']ImgSketchPage["'][^>]*src|src)=["']([^"']+)["'][^>]*>/i)
    || html.match(/<img\b[^>]*src=["']([^"']*RTCPreviewPng[^"']*)["'][^>]*>/i);
  return imgMatch ? new URL(decodeHtml(imgMatch[1]), baseUrl).href : "";
}

async function fetchCurrentRtcPreviewRecord(session, values, label) {
  const previewForm = buildForm(session, values, "", currentFields);
  previewForm.set(currentPreviewButton.name, currentPreviewButton.value);
  await fetchOfficial(session, previewForm, session.url);

  const previewPagePath = (session.html.match(/window\.open\(\s*['"]([^'"]*PreviewRTC\.aspx[^'"]*)['"]/i) || [])[1] || "PreviewRTC.aspx";
  const previewPageUrl = new URL(previewPagePath, session.url || BHOOMI_URL).href;
  const previewHtml = await fetchOfficialText(session, previewPageUrl, session.url || BHOOMI_URL);
  const imageUrl = previewRtcImageUrl(previewHtml, previewPageUrl);
  if (!imageUrl) throw new Error("Official RTC View page did not return a preview image");

  const response = await officialFetch(imageUrl, {
    headers: {
      cookie: session.cookie,
      referer: previewPageUrl,
    },
    timeoutMs: 30000,
  }, "Current RTC preview image");
  if (!response.ok) throw new Error(`Current RTC preview image returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  const storedImageUrl = storeDocument(
    buffer,
    contentType,
    `current-rtc-${values.survey || "survey"}-${values.surnocLabel || values.surnoc || "surnoc"}-${values.hissaLabel || values.hissa || "hissa"}.png`,
  );

  return {
    label: "Current RTC official View page",
    summary: {
      hasData: true,
      text: "Official Current RTC View page image fetched from Bhoomi.",
      rows: [
        ["View", "Official RTC preview image fetched"],
        ["Period", label || values.periodLabel || "-"],
      ],
    },
    imageUrl: storedImageUrl,
    imageClass: "current-rtc-page",
  };
}

function emptyOwnershipHistoryData(html = "") {
  return {
    html,
    rows: extractAllDataRows(html),
    mutationRows: [],
    landDetails: [],
    finalPositions: [],
    text: visibleText(html),
  };
}

function ownershipMapRecords(values, parsed, statusRows = []) {
  const imageUrl = storeOwnershipMap(values, parsed);
  const historyRows = [
    ["Date", "MR No", "Survey No", "Nature", "Mutation Type", "Acquisition Type", "Transaction No", "Focus"],
    ...parsed.mutationRows.map((row) => [
      row.approveDate,
      row.mrDisplay,
      row.surveyNo,
      row.nature,
      row.mutationType,
      row.acquisitionType,
      row.transactionNo,
      row.focus,
    ]),
  ];
  const finalRows = [
    ["Survey No", "Owner", "Owner Extent", "Total Extent", "Kharab A", "Kharab B", "Stage"],
    ...parsed.finalPositions.map((row) => [
      row.surveyNo,
      row.owner,
      row.ownerExtent,
      row.totalExtent || "",
      row.kharabA || "",
      row.kharabB || "",
      row.stage || "",
    ]),
  ];
  const records = [
    {
      label: "Ownership dashboard snapshot",
      summary: {
        hasData: parsed.mutationRows.length > 0,
        text: parsed.mutationRows.length ? "Mutation history dashboard generated from Service40." : "Ownership map dashboard prepared without mutation-history rows.",
        rows: [["Snapshot", "Ownership map dashboard attached in the report"]],
      },
      imageUrl,
      imageClass: "ownership-map-page",
    },
  ];
  if (statusRows.length) {
    records.push({
      label: "Service40 mutation history status",
      summary: {
        hasData: false,
        text: "Service40 did not generate a mutation-history report for this selection.",
        rows: statusRows,
      },
    });
  }
  records.push(
    {
      label: "Main MR history summary",
      summary: {
        hasData: parsed.mutationRows.length > 0,
        text: `${parsed.mutationRows.length} mutation history row(s) found`,
        rows: parsed.mutationRows.length ? historyRows : [["Status", "No mutation history rows returned by Service40"]],
      },
    },
    {
      label: "Final land position after mutation history",
      summary: {
        hasData: parsed.finalPositions.length > 0,
        text: parsed.finalPositions.length ? `${parsed.finalPositions.length} final survey position(s) parsed` : "No final position rows parsed",
        rows: parsed.finalPositions.length ? finalRows : [["Status", "No final land position rows parsed"]],
      },
    },
    {
      label: "Ownership map key insights",
      summary: {
        hasData: parsed.mutationRows.length > 0,
        text: "Derived mutation-history observations",
        rows: ownershipInsightRows(parsed, values),
      },
    },
  );
  return records;
}

function akarbandSurveyEntries(data) {
  return Object.values(data || {})
    .map((item) => ({
      survey: String(item.Item1 ?? "").trim(),
      surnoc: String(item.Item2 ?? "").trim(),
      hissa: String(item.Item3 ?? "").trim(),
    }))
    .filter((item) => item.survey);
}

function chooseAkarbandSelection(entries, values) {
  const requested = {
    survey: String(values.survey || "").trim(),
    surnoc: String(values.surnocLabel || values.surnoc || "").trim(),
    hissa: String(values.hissaLabel || values.hissa || "").trim(),
  };
  const surveyMatches = entries.filter((entry) => entry.survey === requested.survey);
  const exact = surveyMatches.find((entry) => {
    const surnocOk = !requested.surnoc || entry.surnoc === requested.surnoc;
    const hissaOk = !requested.hissa || entry.hissa === requested.hissa;
    return surnocOk && hissaOk;
  });
  const chosen = exact || surveyMatches[0] || requested;
  return {
    survey: chosen.survey || requested.survey,
    surnoc: chosen.surnoc || requested.surnoc || "*",
    hissa: chosen.hissa || requested.hissa || "*",
    matched: Boolean(exact),
    surveyAvailable: surveyMatches.length > 0,
  };
}

function storeDocument(buffer, contentType, filename) {
  const id = randomUUID();
  documents.set(id, {
    buffer,
    contentType,
    filename: filename.replace(/[^\w.-]+/g, "-"),
    createdAt: Date.now(),
  });
  return `/api/document/${id}`;
}

function runCommand(command, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function renderPdfPreview(buffer, filename) {
  const tempDir = await mkdtemp(join(tmpdir(), "akarband-"));
  try {
    const pdfPath = join(tempDir, filename);
    await writeFile(pdfPath, buffer);
    await runCommand("/usr/bin/qlmanage", ["-t", "-s", "1800", "-o", tempDir, pdfPath]);
    const files = await readdir(tempDir);
    const previewFile = files.find((file) => file.endsWith(".png") && file.includes(filename));
    if (!previewFile) throw new Error("Akarband preview image was not produced");
    return await readFile(join(tempDir, previewFile));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function storePdfWithPreview(buffer, filename) {
  const pdfUrl = storeDocument(buffer, "application/pdf", filename);
  try {
    const previewBuffer = await renderPdfPreview(buffer, filename);
    const imageUrl = storeDocument(previewBuffer, "image/png", filename.replace(/\.pdf$/i, ".png"));
    return { pdfUrl, imageUrl };
  } catch (error) {
    return { pdfUrl, imageError: error.message };
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function findValueAfter(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}\\s*(?:is\\s*)?:\\s*([^:]+?)(?=\\s+[A-Z][A-Za-z ]{2,}\\s*:|\\s+RTC Documents|\\s+OnGoing|$)`, "i"));
  return match ? match[1].trim() : "";
}

function extractOwnerRows(rows) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => /^owner$/i.test(cell)) && row.some((cell) => /^extent$/i.test(cell)));
  if (headerIndex === -1) return [];
  const headers = rows[headerIndex].map((header) => header.toLowerCase());
  const ownerIndex = headers.findIndex((header) => header === "owner");
  const extentIndex = headers.findIndex((header) => header === "extent");
  const categoryIndex = headers.findIndex((header) => header.includes("owner category"));
  const govRestrictionIndex = headers.findIndex((header) => header.includes("gov restriction"));
  const courtStayIndex = headers.findIndex((header) => header.includes("court stay"));
  const alienatedIndex = headers.findIndex((header) => header.includes("alienated"));

  return rows.slice(headerIndex + 1)
    .filter((row) => row[ownerIndex] || row[extentIndex])
    .map((row) => ({
      owner: row[ownerIndex] || "",
      extent: row[extentIndex] || "",
      category: row[categoryIndex] || "",
      govRestriction: row[govRestrictionIndex] || "",
      courtStay: row[courtStayIndex] || "",
      alienated: row[alienatedIndex] || "",
    }));
}

function rtcRecordFromSummary({ mode, label, summary, values }) {
  const ownerRows = extractOwnerRows(summary.rows || []);
  const text = summary.text || "";
  const labelYear = (label.match(/\(([^)]+)\)/) || [])[1]?.trim() || "";
  return {
    type: mode === "old" ? "Old RTC" : "Current RTC",
    period: label || values.periodLabel || "",
    year: labelYear || values.yearLabel || values.year || "",
    village: values.villageLabel || values.village || findValueAfter(text, "Village"),
    survey: values.survey || findValueAfter(text, "Survey No"),
    surnoc: values.surnocLabel || values.surnoc || "",
    hissa: values.hissaLabel || values.hissa || "",
    landId: (text.match(/Your Land ID is\s*:\s*([0-9 ]+)/i) || [])[1]?.trim() || "",
    khataNumber: findValueAfter(text, "Khatah Number") || findValueAfter(text, "Khata Number") || (text.match(/Khata(?:h)?\s*(?:No|Number)\s*:?\s*([A-Za-z0-9/ -]+)/i) || [])[1]?.trim() || "",
    ongoingMutation: (text.match(/OnGoing Mutation\s*:\s*(Yes|No)/i) || [])[1] || "",
    owners: ownerRows.map((row) => row.owner),
    extents: ownerRows.map((row) => row.extent),
    ownerCategories: uniq(ownerRows.map((row) => row.category)),
    govRestrictions: uniq(ownerRows.map((row) => row.govRestriction)),
    courtStays: uniq(ownerRows.map((row) => row.courtStay)),
    alienated: uniq(ownerRows.map((row) => row.alienated)),
    ownerDetails: ownerRows,
    notes: ownerRows.length ? "" : text.slice(0, 360),
  };
}

function parseState(session) {
  const html = session.html;
  return {
    sessionId: session.id,
    lastUpdated: new Date().toISOString(),
    source: BHOOMI_URL,
    selects: {
      district: selectBlock(html, fields.district.id),
      taluk: selectBlock(html, fields.taluk.id),
      hobli: selectBlock(html, fields.hobli.id),
      village: selectBlock(html, fields.village.id),
      surnoc: selectBlock(html, fields.surnoc.id),
      hissa: selectBlock(html, fields.hissa.id),
      period: selectBlock(html, fields.period.id),
      year: selectBlock(html, fields.year.id),
    },
    survey: inputState(html, fields.survey.id),
    canGo: !buttonState(html, buttons.go.id).disabled,
    canFetch: !buttonState(html, buttons.fetch.id).disabled,
    details: {
      village: stripTags((html.match(/id=["']ctl00_MainContent_lblCValueVillage["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
      survey: stripTags((html.match(/id=["']ctl00_MainContent_lblCvalueSurveyNo["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
      surnoc: stripTags((html.match(/id=["']ctl00_MainContent_lblCValueSurnoc["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
      hissa: stripTags((html.match(/id=["']ctl00_MainContent_lblCValueHissaNo["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
      period: stripTags((html.match(/id=["']ctl00_MainContent_lblCValuePeriod["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
      year: stripTags((html.match(/id=["']ctl00_MainContent_lblCValueYear["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ""),
    },
  };
}

function buildForm(session, values, eventTarget = "", fieldConfig = fields) {
  const params = new URLSearchParams();
  params.set("__EVENTTARGET", eventTarget);
  params.set("__EVENTARGUMENT", "");
  params.set("__VIEWSTATE", hiddenValue(session.html, "__VIEWSTATE"));
  params.set("__VIEWSTATEGENERATOR", hiddenValue(session.html, "__VIEWSTATEGENERATOR"));
  params.set("__VIEWSTATEENCRYPTED", hiddenValue(session.html, "__VIEWSTATEENCRYPTED"));
  params.set("__EVENTVALIDATION", hiddenValue(session.html, "__EVENTVALIDATION"));

  for (const [key, field] of Object.entries(fieldConfig)) {
    const select = key === "survey" ? inputState(session.html, field.id) : selectBlock(session.html, field.id);
    const value = values[key] ?? (key === "survey" ? select.value : select.selected);
    if (!select.disabled && value !== undefined && value !== "") {
      params.set(field.name, value);
    }
  }

  return params;
}

async function fetchOfficial(session, body, url = session.url || BHOOMI_URL) {
  const response = await officialFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session.cookie,
      referer: url,
    },
    body,
  }, "Bhoomi official site");

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Official site returned HTTP ${response.status}`);
  }
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  if (cookie) session.cookie = cookie;
  session.html = text;
  session.updatedAt = Date.now();
}

async function fetchOfficialText(session, url, referer = session.url || url) {
  const response = await officialFetch(url, {
    headers: {
      cookie: session.cookie,
      referer,
    },
  }, "Bhoomi official site");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Official site returned HTTP ${response.status}`);
  }
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  if (cookie) session.cookie = cookie;
  return text;
}

async function createSession() {
  const response = await officialFetch(BHOOMI_URL, {}, "Bhoomi Service2");
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Official site returned HTTP ${response.status}`);
  }
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  const session = { id: randomUUID(), cookie, html, url: BHOOMI_URL, updatedAt: Date.now() };
  sessions.set(session.id, session);
  return session;
}

async function createServiceSession(url, body) {
  const response = await officialFetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  }, "Bhoomi official site");
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Official site returned HTTP ${response.status}`);
  }
  return {
    id: randomUUID(),
    cookie: (response.headers.get("set-cookie") || "").split(";")[0],
    html,
    url,
    updatedAt: Date.now(),
  };
}

function firstUsableOption(select, preferredValue, preferredLabel = "") {
  if (preferredValue && select.options.some((option) => option.value === preferredValue && !/^select /i.test(option.label))) {
    return preferredValue;
  }
  if (preferredLabel) {
    const normalizedLabel = String(preferredLabel).trim();
    const byLabel = select.options.find((option) => option.label.trim() === normalizedLabel && !/^select /i.test(option.label));
    if (byLabel) return byLabel.value;
  }
  return select.options.find((option) => option.value && !/^select /i.test(option.label) && !/^select /i.test(option.value))?.value || "";
}

function usableOptions(select) {
  return select.options.filter((option) => option.value && !/^select /i.test(option.value) && !/^select /i.test(option.label));
}

function dedupeRtcRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify([
      row.type,
      row.period,
      row.survey,
      row.surnoc,
      row.hissa,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function khathaRecordFromNumber(khathaNumber, source) {
  return {
    label: source,
    summary: {
      hasData: Boolean(khathaNumber),
      text: khathaNumber ? `Khatha number found from ${source}` : "Khatha number was not found",
      rows: khathaNumber ? [["Khata Number / ಖಾತೆ ನಂ", khathaNumber], ["Source", source]] : [["Status", "Khatha number was not found"]],
    },
  };
}

function enrichKhathaSection(khathaSection, khathaNumber, source) {
  if (!khathaSection || !khathaNumber) return;
  khathaSection.khathaNumber = khathaSection.khathaNumber || khathaNumber;
  const existing = firstSummaryValue(khathaSection.records || [], bilingualFields.khata);
  if (existing) return;
  khathaSection.status = "Fetched";
  khathaSection.records = [khathaRecordFromNumber(khathaNumber, source), ...(khathaSection.records || [])];
}

async function enrichKhathaSectionByNumber(khathaSection, values, khathaNumber) {
  if (!khathaSection || !khathaNumber) return;
  if ((khathaSection.records || []).some((record) => record.label === "Khatha details by Katha Number")) return;
  try {
    const record = await fetchKhathaByNumberRecord(values, khathaNumber);
    khathaSection.status = record.summary?.hasData ? "Fetched" : khathaSection.status;
    khathaSection.records = [record, ...(khathaSection.records || [])];
  } catch (error) {
    khathaSection.records = [
      {
        label: "Khatha details by Katha Number",
        summary: {
          hasData: false,
          text: `Could not fetch Khatha details by number: ${error.message}`,
          rows: [["Status", `Could not fetch Khatha details by number: ${error.message}`]],
        },
      },
      ...(khathaSection.records || []),
    ];
  }
}

async function postSelection(session, fieldConfig, key, value, values, url = session.url) {
  const field = fieldConfig[key];
  const form = buildForm(session, { ...values, [key]: value }, field.target, fieldConfig);
  form.set(field.name, value);
  await fetchOfficial(session, form, url);
}

async function switchToOldYear(session) {
  const form = buildForm(session, {}, "", currentFields);
  form.set(oldButtons.tab.name, oldButtons.tab.value);
  await fetchOfficial(session, form, BHOOMI_URL);
}

async function prepareSurveyFlow(session, fieldConfig, values, options = {}) {
  const keys = ["district", "taluk", "hobli", "village"];
  const selected = {};
  for (const key of keys) {
    const value = values[key];
    if (!value) throw new Error(`Missing ${key}`);
    selected[key] = value;
    await postSelection(session, fieldConfig, key, value, selected, session.url);
  }

  selected.survey = values.survey;
  const surveyField = fieldConfig.survey;
  if (options.goButton) {
    const form = buildForm(session, selected, "", fieldConfig);
    form.set(surveyField.name, values.survey);
    form.set(options.goButton.name, options.goButton.value);
    await fetchOfficial(session, form, session.url);
  } else {
    await postSelection(session, fieldConfig, "survey", values.survey, selected, session.url);
  }

  if (fieldConfig.surnoc) {
    const surnoc = firstUsableOption(
      selectBlock(session.html, fieldConfig.surnoc.id),
      options.preferredSurnocValue ?? values.surnoc,
      options.preferredSurnocLabel ?? values.surnocLabel,
    );
    if (surnoc) {
      selected.surnoc = surnoc;
      await postSelection(session, fieldConfig, "surnoc", surnoc, selected, session.url);
    }
  }

  if (fieldConfig.hissa) {
    const hissa = firstUsableOption(
      selectBlock(session.html, fieldConfig.hissa.id),
      options.preferredHissaValue ?? values.hissa,
      options.preferredHissaLabel ?? values.hissaLabel,
    );
    if (hissa) {
      selected.hissa = hissa;
      await postSelection(session, fieldConfig, "hissa", hissa, selected, session.url);
    }
  }

  return selected;
}

async function fetchRtcSection(mode, values) {
  const session = await createServiceSession(BHOOMI_URL);
  const fieldConfig = mode === "old" ? oldFields : currentFields;
  const buttonConfig = mode === "old" ? oldButtons : buttons;
  if (mode === "old") await switchToOldYear(session);

  const selected = await prepareSurveyFlow(session, fieldConfig, values, { goButton: buttonConfig.go });
  const periodSelect = selectBlock(session.html, fieldConfig.period.id);
  const periodOptions = usableOptions(periodSelect);
  const periodValues = periodOptions.map((option) => option.value);

  const wantedPeriods = mode === "current" && values.period ? [values.period] : periodValues;
  const records = [];
  for (const period of wantedPeriods) {
    const working = await createServiceSession(BHOOMI_URL);
    if (mode === "old") await switchToOldYear(working);
    const selectedForPeriod = await prepareSurveyFlow(working, fieldConfig, { ...values, ...selected }, { goButton: buttonConfig.go });
    if (fieldConfig.period) await postSelection(working, fieldConfig, "period", period, { ...values, ...selectedForPeriod, period }, working.url);

    const yearOptions = mode === "old" && fieldConfig.year ? usableOptions(selectBlock(working.html, fieldConfig.year.id)) : [];
    const yearsToFetch = yearOptions.length ? yearOptions : [{ value: "", label: "" }];
    for (const yearOption of yearsToFetch) {
      const rtcValues = { ...values, ...selectedForPeriod, period };
      if (yearOption.value) {
        rtcValues.year = yearOption.value;
        rtcValues.yearLabel = yearOption.label;
        await postSelection(working, fieldConfig, "year", yearOption.value, rtcValues, working.url);
      }
      const form = buildForm(working, rtcValues, "", fieldConfig);
      form.set(buttonConfig.fetch.name, buttonConfig.fetch.value);
      await fetchOfficial(working, form, working.url);
      const html = sanitizeResultHtml(working.html, BHOOMI_URL) || officialContentHtml(working.html, BHOOMI_URL);
      const periodLabel = selectedLabel(working.html, "period", period, fieldConfig) || period;
      const yearLabel = yearOption.label || selectedLabel(working.html, "year", yearOption.value, fieldConfig);
      const label = [periodLabel, yearLabel].filter(Boolean).join(" | ");
      const summary = summarizeOfficialHtml(html);
      records.push({
        label,
        summary,
        rtc: rtcRecordFromSummary({ mode, label: periodLabel, summary, values: { ...rtcValues, periodLabel, yearLabel } }),
      });
      if (mode === "current") {
        try {
          records.push(await fetchCurrentRtcPreviewRecord(working, { ...rtcValues, periodLabel, yearLabel }, label));
        } catch (error) {
          records.push({
            label: "Current RTC official View page",
            summary: {
              hasData: false,
              text: `Could not fetch official RTC View image: ${error.message}`,
              rows: [["Status", `Could not fetch official RTC View image: ${error.message}`]],
            },
          });
        }
      }
    }
  }

  const rtcRows = dedupeRtcRows(records.map((record) => record.rtc).filter(Boolean));
  return {
    title: mode === "old" ? "Old Year RTC" : "Current Year RTC",
    status: records.length ? "Fetched" : "No period available",
    records,
    rtcRows,
    availablePeriods: periodOptions,
  };
}

async function fetchMutationSection(kind, values) {
  const url = kind === "status" ? MR_STATUS_URL : MR_EXTRACT_URL;
  const fieldConfig = kind === "status" ? mutationStatusFields : mutationExtractFields;
  const buttonConfig = kind === "status" ? mutationStatusButtons : mutationExtractButtons;
  const session = await createServiceSession(url, new URLSearchParams({ UserName: "" }));

  const selected = await prepareSurveyFlow(session, fieldConfig, values, kind === "status" ? {
    preferredHissaValue: "",
    preferredHissaLabel: "*",
  } : {});
  const form = buildForm(session, { ...values, ...selected }, "", fieldConfig);
  form.set(buttonConfig.fetch.name, buttonConfig.fetch.value);
  await fetchOfficial(session, form, url);
  const summary = kind === "status" ? parseMutationStatusSummary(session.html) : parseMutationRegisterSummary(session.html, values);
  return {
    title: kind === "status" ? "Mutation Status" : "Mutation Register",
    status: summary.hasData ? "Fetched" : "No details returned",
    records: [{ label: kind === "status" ? "MR status by survey number" : "MR extract by survey number", summary }],
  };
}

async function fetchKhathaSection(values) {
  const session = await createServiceSession(KHATHA_URL);
  const radioForm = buildForm(session, {}, "rbnSurveyNum", {});
  radioForm.set("a", "rbnSurveyNum");
  await fetchOfficial(session, radioForm, KHATHA_URL);

  const selected = {};
  for (const key of ["district", "taluk", "hobli", "village"]) {
    const field = khathaFields[key];
    const value = values[key];
    if (!value) throw new Error(`Missing ${key}`);
    selected[key] = value;
    const form = buildForm(session, selected, field.target, khathaFields);
    form.set("a", "rbnSurveyNum");
    form.set(field.name, value);
    await fetchOfficial(session, form, KHATHA_URL);
  }

  const form = buildForm(session, { ...selected, survey: values.survey || "" }, "", khathaFields);
  form.set("a", "rbnSurveyNum");
  form.set(khathaFields.survey.name, values.survey || "");
  form.set(khathaButtons.fetch.name, khathaButtons.fetch.value);
  await fetchOfficial(session, form, KHATHA_URL);

  const summary = parseKhathaSummary(session.html);
  return {
    title: "Khatha Number",
    status: summary.hasData ? "Fetched" : "No details returned",
    records: [{ label: "Khatha details by survey number", summary }],
    khathaNumber: khathaNumberFromSummary(summary),
  };
}

async function fetchKhathaByNumberRecord(values, khathaNumber) {
  const session = await createServiceSession(KHATHA_URL);
  const selected = {};
  for (const key of ["district", "taluk", "hobli", "village"]) {
    const field = khathaFields[key];
    const value = values[key];
    if (!value) throw new Error(`Missing ${key}`);
    selected[key] = value;
    const form = buildForm(session, selected, field.target, khathaFields);
    form.set("a", "rbnKhataNum");
    form.set(field.name, value);
    await fetchOfficial(session, form, KHATHA_URL);
  }

  const form = buildForm(session, { ...selected, survey: khathaNumber }, "", khathaFields);
  form.set("a", "rbnKhataNum");
  form.set(khathaFields.survey.name, khathaNumber);
  form.set(khathaButtons.fetch.name, khathaButtons.fetch.value);
  await fetchOfficial(session, form, KHATHA_URL);

  const summary = parseKhathaByNumberSummary(session.html, khathaNumber);
  const imageUrl = storeTableSnapshot(
    `Khatha details by Katha Number ${khathaNumber}`,
    values,
    summary.rows,
    `khatha-${khathaNumber || "number"}.svg`,
  );
  return {
    label: "Khatha details by Katha Number",
    summary,
    imageUrl,
    imageClass: "khatha-page",
  };
}

async function fetchAdvancedDetailsSection(values) {
  const selected = selectedSurveyParts(values);
  const ownerResponse = await fetchAdvancedRtcJson("FnGetSurveyDetailsUsingBhoomiIndex", {
    pDeptUserId: "",
    pDeptPass: "",
    pDistCode: values.district || "",
    pTlkCode: values.taluk || "",
    pHobliCode: values.hobli || "",
    pVillCode: values.village || "",
    sLang: "kn_in",
  });
  const ownerRows = advancedOwnerRows(ownerResponse?.Details || [], values);
  const detailResponse = await fetchAdvancedRtcJson("getXml_Dsrtc", {
    dist_code: values.district || "",
    taluk_code: values.taluk || "",
    hobli_code: values.hobli || "",
    village_code: values.village || "",
    surveyNo: selected.survey,
    surnoc: selected.surnoc,
    hissano: selected.hissa,
  });
  const records = advancedRecordsFromRtcData(detailResponse, ownerRows);
  let khathaNumber = advancedKhathaNumberFromBlock(Array.isArray(detailResponse) ? detailResponse.find(Boolean) : null)
    || firstSummaryValue(records, bilingualFields.khata);

  const hasDetailPayload = Array.isArray(detailResponse) && detailResponse.some(Boolean);
  if (!hasDetailPayload) {
    try {
      const rtcFallback = await fetchRtcSection("current", values);
      const fallbackRecords = advancedFallbackRecordsFromRtcSection(rtcFallback);
      records.push(...fallbackRecords);
      khathaNumber = khathaNumber
        || rtcFallback.rtcRows?.map((row) => row.khataNumber).find(Boolean)
        || firstSummaryValue(fallbackRecords, bilingualFields.khata);
    } catch (error) {
      records.push({
        label: "RTC fallback status",
        summary: {
          hasData: false,
          text: `Could not parse fallback RTC details: ${error.message}`,
          rows: [["Status", `Could not parse fallback RTC details: ${error.message}`]],
        },
      });
    }
  }
  const imageUrl = storeAdvancedSnapshot(values, records);
  records.push({
    label: "Advanced RTC page snapshot",
    summary: {
      hasData: true,
      text: "Printable Advanced RTC page snapshot prepared for the report.",
      rows: [["Snapshot", "Advanced RTC details page attached in the report"]],
    },
    imageUrl,
    imageClass: "advanced-rtc-page",
  });
  return {
    title: "Advanced Details",
    status: records.some((record) => record.summary?.hasData) ? "Fetched" : "No details returned",
    records,
    khathaNumber,
  };
}

async function fetchAkarbandSection(values) {
  const locationPayload = {
    distId: values.district || "",
    tlkId: values.taluk || "",
    hblId: values.hobli || "",
    vlgId: values.village || "",
  };
  const surveyData = await fetchAkarbandJson("GetSurveyNos", locationPayload);
  const entries = akarbandSurveyEntries(surveyData);
  const selection = chooseAkarbandSelection(entries, values);
  const response = await fetchAkarbandJson("GetAkarband", {
    ...locationPayload,
    syno: selection.survey,
    surnoc: selection.surnoc,
    hissa: selection.hissa,
  });

  const message = response.ReturnVal || response.ReturnValue || response.Message || "";
  const pdfBase64 = response.PdfFile || "";
  const rows = [];
  if (!selection.matched && selection.surveyAvailable) {
    rows.push(["Selection note", "Nearest available Akarband survey entry was used from the official list"]);
  }

  if (pdfBase64) {
    const buffer = Buffer.from(pdfBase64, "base64");
    const filename = `akarband-survey-${selection.survey || "record"}.pdf`.replace(/[^\w.-]+/g, "-");
    const { pdfUrl, imageUrl, imageError } = await storePdfWithPreview(buffer, filename);
    rows.push(["Certificate", "Official Akarband PDF fetched"]);
    if (imageError) rows.push(["Attachment preview", imageError]);
    return {
      title: "Akarband",
      status: "Fetched",
      records: [{
        label: "Akarband certificate",
        summary: {
          hasData: true,
          text: "Official Akarband PDF fetched from Bhoomojini.",
          rows,
        },
        pdfUrl,
        imageUrl,
        filename,
      }],
    };
  }

  rows.push(["Certificate", message || "Akarband document was not returned by the official service"]);
  return {
    title: "Akarband",
    status: "No details returned",
    records: [{
      label: "Akarband certificate by survey number",
      summary: {
        hasData: false,
        text: message || "Akarband document was not returned by the official service",
        rows,
      },
    }],
  };
}

async function fetchOwnershipMapSection(values) {
  const session = await createServiceSession(OWNERSHIP_HISTORY_URL);
  const selected = {};
  for (const key of ["district", "taluk", "hobli"]) {
    const field = ownershipHistoryFields[key];
    const value = values[key];
    if (!value) throw new Error(`Missing ${key}`);
    selected[key] = value;
    await postSelection(session, ownershipHistoryFields, key, value, selected, OWNERSHIP_HISTORY_URL);
  }

  selected.village = values.village || "";
  selected.survey = values.survey || "";
  const form = buildForm(session, selected, "", ownershipHistoryFields);
  form.set(ownershipHistoryFields.village.name, selected.village);
  form.set(ownershipHistoryFields.survey.name, selected.survey);
  form.set(ownershipHistoryButtons.fetch.name, ownershipHistoryButtons.fetch.value);
  await fetchOfficial(session, form, OWNERSHIP_HISTORY_URL);

  const popupPath = (session.html.match(/window\.open\('([^']*HtmlPendcysurveynoWise[^']*)'/i) || [])[1] || "HtmlPendcysurveynoWise.aspx";
  const popupUrl = new URL(popupPath, "https://landrecords.karnataka.gov.in/service40/").href;
  const popupHtml = await fetchOfficialText(session, popupUrl, OWNERSHIP_HISTORY_URL);
  const reportPath = (popupHtml.match(/window\.open\('([^']*BhoomiPendcySurveynoWise\.html[^']*)'/i) || [])[1];
  if (!reportPath) {
    const parsed = emptyOwnershipHistoryData(popupHtml);
    return {
      title: "Ownership Map",
      status: "No details returned",
      records: ownershipMapRecords(values, parsed, [
        ["Status", "Mutation history popup did not return a generated report"],
        ["Survey", selectedSurveyKey(values) || values.survey || "-"],
        ["Village", values.villageLabel || values.village || "-"],
        ["Source", OWNERSHIP_HISTORY_URL],
      ]),
    };
  }
  const reportUrl = new URL(reportPath, popupUrl).href;
  const reportHtml = await fetchOfficialText(session, reportUrl, popupUrl);
  const parsed = parseOwnershipHistoryReport(reportHtml, values);
  return {
    title: "Ownership Map",
    status: parsed.mutationRows.length ? "Fetched" : "No details returned",
    records: ownershipMapRecords(values, parsed),
  };
}

async function resolveEchawadiVillage(values) {
  const dist = numberString(values.district);
  const taluk = numberString(values.taluk);
  const hobli = numberString(values.hobli);
  const villageList = await fetchEchawadiJson("LoadVillage", {
    pDistCode: dist,
    pTalukCode: taluk,
    pHobliCode: hobli,
  });
  const villages = villageList?.data || [];
  const selectedVillage = numberString(values.village);
  const selectedLabel = normalizePlace(values.villageLabel || "");
  const matched = villages.find((village) => numberString(village.village_code) === selectedVillage)
    || villages.find((village) => selectedLabel && normalizePlace(village.village_name_kn) === selectedLabel);
  if (!matched) {
    throw new Error("Could not map selected village to eChawadi village code");
  }
  return {
    dist,
    taluk,
    hobli,
    village: `${numberString(matched.LGDCODE)}_${numberString(matched.village_code)}`,
    villageName: matched.village_name_kn || values.villageLabel || "",
  };
}

async function fetchEchawadiData(path, params) {
  const response = await fetchEchawadiJson(path, { paramObj: params });
  if (!response) return [];
  if (response.data === "nodata") return [];
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.data?.Table)) return response.data.Table;
  return [];
}

async function fetchEchawadiSection(values) {
  const location = await resolveEchawadiVillage(values);
  const baseParams = {
    Dist: location.dist,
    Taluk: location.taluk,
    Hobli: location.hobli,
    Village: location.village,
  };
  const [
    mutations,
    rccmsPending,
    rccmsDisposed,
    rccmsRejected,
    conversions,
    renewableEnergy,
    industrialProjects,
    epouti,
  ] = await Promise.all([
    fetchEchawadiData("GetActiveCasesofMutationStatus", baseParams),
    fetchEchawadiData("GetActiveRCCMS", { ...baseParams, RCCMSSearchtype: "P" }),
    fetchEchawadiData("GetActiveRCCMS", { ...baseParams, RCCMSSearchtype: "D" }),
    fetchEchawadiData("GetActiveRCCMS", { ...baseParams, RCCMSSearchtype: "R" }),
    fetchEchawadiData("GetActiveConversionLand", { ...baseParams, LCDataSearchtype: "D" }),
    fetchEchawadiData("GetActiveConversionLand", { ...baseParams, LCDataSearchtype: "E" }),
    fetchEchawadiData("GetActiveConversionLand", { ...baseParams, LCDataSearchtype: "I" }),
    fetchEchawadiData("GetEpoutiData", baseParams),
  ]);

  const rccms = [
    ...rccmsPending.map((row) => ({ ...row, Case_Status: row.Case_Status || "Pending" })),
    ...rccmsDisposed.map((row) => ({ ...row, Case_Status: row.Case_Status || "Disposed" })),
    ...rccmsRejected.map((row) => ({ ...row, Case_Status: row.Case_Status || "Rejected" })),
  ];
  const total = mutations.length + rccms.length + conversions.length + renewableEnergy.length + industrialProjects.length + epouti.length;
  const records = [
    {
      label: "Village summary",
      summary: {
        hasData: total > 0,
        text: `${total} eChawadi item(s) found for ${location.villageName}`,
        rows: [
          ["Category", "Items", "Survey matches"],
          ["Mutations", mutations.length, mutations.filter((row) => rowMatchesSurvey(row, values)).length],
          ["RCCMS", rccms.length, rccms.filter((row) => rowMatchesSurvey(row, values)).length],
          ["Land Conversions", conversions.length, conversions.filter((row) => rowMatchesSurvey(row, values)).length],
          ["Renewable Energy / Industrial Projects", renewableEnergy.length + industrialProjects.length, [...renewableEnergy, ...industrialProjects].filter((row) => rowMatchesSurvey(row, values)).length],
          ["E-Pouti", epouti.length, epouti.filter((row) => rowMatchesSurvey(row, values)).length],
        ],
      },
    },
    eChawadiSummary("Mutations", mutations, values, ["MR Number", "Transaction", "Survey Numbers", "Applicant", "Acquisition", "Status"], (row) => [
      row.MRNumber,
      row.TypeofTransaction,
      row.SurveyNumbers,
      row.applicant,
      row.AcquisitionType,
      row.status,
    ]),
    eChawadiSummary("RCCMS", rccms, values, ["Case ID", "Survey / Surnoc / Hissa", "Owner", "Case Status", "Ack No"], (row) => [
      row.case_id,
      [row.Survey_no, row.surnoc || "-", row.hissano || "-"].filter(Boolean).join(" / "),
      row.ownername,
      row.Case_Status,
      row.Ack_No,
    ]),
    eChawadiSummary("Land Conversions", conversions, values, ["Request", "Survey No", "Applicant", "Purpose", "Sub Purpose", "Status"], (row) => [
      row.REQ_AID || row.REQ_ID,
      row.SurveyNo,
      row.ApplicantName,
      row.Purpose,
      row.SubPurpose,
      row.status,
    ]),
    eChawadiSummary("Renewable Energy / Industrial Projects", [...renewableEnergy, ...industrialProjects], values, ["Request", "Survey No", "Applicant", "Request Type", "Purpose", "Status"], (row) => [
      row.REQ_AID || row.REQ_ID,
      row.SurveyNo,
      row.ApplicantName,
      row.RequestType,
      row.Purpose,
      row.status,
    ]),
    eChawadiSummary("E-Pouti", epouti, values, ["Application No", "Survey No", "Owner", "Extent", "Status"], (row) => [
      row.Owner_Appl_No,
      row.survey_no,
      row.Owner_Name,
      row.Owner_Extent,
      row.Status_Description,
    ]),
  ];

  return {
    title: "eChawadi",
    status: total ? "Fetched" : "No details returned",
    records,
  };
}

async function buildReport(values) {
  const sections = [];
  const disabledSections = new Set();
  const selectedSections = Array.isArray(values.sections)
    ? new Set(values.sections.filter((section) => !disabledSections.has(section)))
    : new Set(["currentRtc", "oldRtc", "khatha", "advancedDetails", "mutationStatus", "mutationRecords", "ownershipMap", "akarband", "echawadi"]);
  const tasks = [
    ["currentRtc", () => fetchRtcSection("current", values), "Current Year RTC", REPORT_TASK_TIMEOUT_MS],
    ["oldRtc", () => fetchRtcSection("old", values), "Old Year RTC", OLD_RTC_TASK_TIMEOUT_MS],
    ["khatha", () => fetchKhathaSection(values), "Khatha Number", REPORT_TASK_TIMEOUT_MS],
    ["advancedDetails", () => fetchAdvancedDetailsSection(values), "Advanced Details", ADVANCED_DETAILS_TASK_TIMEOUT_MS],
    ["ownershipMap", () => fetchOwnershipMapSection(values), "Ownership Map", OWNERSHIP_MAP_TASK_TIMEOUT_MS],
    ["akarband", () => fetchAkarbandSection(values), "Akarband", REPORT_TASK_TIMEOUT_MS],
    ["echawadi", () => fetchEchawadiSection(values), "eChawadi", REPORT_TASK_TIMEOUT_MS],
    ["mutationStatus", () => fetchMutationSection("status", values), "Mutation Status", REPORT_TASK_TIMEOUT_MS],
    ["mutationRecords", () => fetchMutationSection("extract", values), "Mutation Register", REPORT_TASK_TIMEOUT_MS],
  ].filter(([key]) => selectedSections.has(key));

  sections.push(...await Promise.all(tasks.map(async ([, task, title, timeoutMs]) => {
    try {
      return await withReportTimeout(
        task(),
        timeoutMs,
        `${title} took too long to respond from the official service.`,
      );
    } catch (error) {
      return { title, status: "Could not fetch", error: error.message, records: [] };
    }
  })));

  const rtcRows = dedupeRtcRows(sections.flatMap((section) => section.rtcRows || []));
  const khathaSection = sections.find((section) => section.title === "Khatha Number");
  const advancedSection = sections.find((section) => section.title === "Advanced Details");
  const khathaNumber = values.khathaNumber
    || khathaSection?.khathaNumber
    || advancedSection?.khathaNumber
    || firstSummaryValue(sections.flatMap((section) => section.records || []), bilingualFields.khata)
    || "";
  if (khathaNumber) {
    for (const row of rtcRows) row.khataNumber = row.khataNumber || khathaNumber;
    enrichKhathaSection(khathaSection, khathaNumber, advancedSection?.khathaNumber ? "Advanced Details" : "RTC details");
    try {
      await withReportTimeout(
        enrichKhathaSectionByNumber(khathaSection, values, khathaNumber),
        REPORT_ENRICH_TIMEOUT_MS,
        "Khatha details by Katha Number took too long to respond from the official service.",
      );
    } catch (error) {
      if (khathaSection) {
        khathaSection.records = [
          {
            label: "Khatha details by Katha Number",
            summary: {
              hasData: false,
              text: error.message,
              rows: [["Status", error.message]],
            },
          },
          ...(khathaSection.records || []),
        ];
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: BHOOMI_URL,
    relatedServices,
    overview: {
      district: values.districtLabel || values.district || "",
      taluk: values.talukLabel || values.taluk || "",
      hobli: values.hobliLabel || values.hobli || "",
      village: values.villageLabel || values.village || "",
      survey: values.survey || "",
      surnoc: values.surnocLabel || values.surnoc || "",
      hissa: values.hissaLabel || values.hissa || "",
      period: values.periodLabel || values.period || "",
    },
    rtcRows,
    sections,
  };
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error("Session expired. Start a new search.");
  return session;
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      try {
        const response = await officialFetch(BHOOMI_URL, { timeoutMs: 15000, retries: 0 }, "Bhoomi Service2");
        json(res, 200, {
          ok: response.ok,
          service: "Bhoomi Service2",
          status: response.status,
          url: BHOOMI_URL,
          proxyConfigured: Boolean(OFFICIAL_PROXY_URL),
        });
      } catch (error) {
        json(res, 503, {
          ok: false,
          service: "Bhoomi Service2",
          url: BHOOMI_URL,
          proxyConfigured: Boolean(OFFICIAL_PROXY_URL),
          error: error.message,
        });
      }
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/document/")) {
      const id = decodeURIComponent(req.url.split("/").pop() || "");
      const document = documents.get(id);
      if (!document) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Document expired");
        return;
      }
      res.writeHead(200, {
        "content-type": document.contentType,
        "content-disposition": `inline; filename="${document.filename}"`,
        "cache-control": "no-store",
      });
      res.end(document.buffer);
      return;
    }

    if (req.method === "POST" && req.url === "/api/start") {
      const session = await createSession();
      json(res, 200, parseState(session));
      return;
    }

    if (req.method === "POST" && req.url === "/api/select") {
      const body = await readJson(req);
      const session = getSession(body.sessionId);
      const field = fields[body.field];
      if (!field || body.value === undefined) throw new Error("Invalid field selection.");

      const values = { ...(body.values || {}), [body.field]: String(body.value) };
      const form = buildForm(session, values, field.target);
      form.set(field.name, String(body.value));
      await fetchOfficial(session, form);
      json(res, 200, parseState(session));
      return;
    }

    if (req.method === "POST" && req.url === "/api/go") {
      const body = await readJson(req);
      const session = getSession(body.sessionId);
      const form = buildForm(session, body.values || "");
      form.set(fields.survey.name, String(body.values?.survey || ""));
      form.set(buttons.go.name, buttons.go.value);
      await fetchOfficial(session, form);
      json(res, 200, parseState(session));
      return;
    }

    if (req.method === "POST" && req.url === "/api/fetch") {
      const body = await readJson(req);
      const session = getSession(body.sessionId);
      const form = buildForm(session, body.values || {});
      form.set(buttons.fetch.name, buttons.fetch.value);
      await fetchOfficial(session, form);
      const state = parseState(session);
      state.resultHtml = sanitizeResultHtml(session.html);
      const quickSummary = summarizeOfficialHtml(state.resultHtml);
      const quickOwners = extractOwnerRows(quickSummary.rows).map((row) => row.owner);
      state.summary = {
        district: selectedLabel(session.html, "district", body.values?.district),
        taluk: selectedLabel(session.html, "taluk", body.values?.taluk),
        hobli: selectedLabel(session.html, "hobli", body.values?.hobli),
        village: selectedLabel(session.html, "village", body.values?.village),
        survey: body.values?.survey || "",
        surnoc: selectedLabel(session.html, "surnoc", body.values?.surnoc),
        hissa: selectedLabel(session.html, "hissa", body.values?.hissa),
        owner: quickOwners.join("; "),
        period: selectedLabel(session.html, "period", body.values?.period),
      };
      json(res, 200, state);
      return;
    }

    if (req.method === "POST" && req.url === "/api/report") {
      const body = await readJson(req);
      const report = await buildReport(body.values || {});
      json(res, 200, report);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Namma Bhoomi Report running at http://localhost:${PORT}`);
});
