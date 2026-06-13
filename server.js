import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const FALLOUT_NV_STATUS_CACHE_TTL_MS = clampInteger(process.env.FALLOUT_NV_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const FALLOUT_NV_STEAM_APP_ID = 22380;
const FALLOUT_NV_STEAM_URL = "https://store.steampowered.com/app/22380/Fallout_New_Vegas/";
const FALLOUT_NV_GOG_URL = "https://www.gog.com/en/game/fallout_new_vegas_ultimate_edition";
const FALLOUT_NV_VIVA_URL = "https://vivanewvegas.moddinglinked.com/";
const FALLOUT_NV_XNVSE_URL = "https://github.com/xNVSE/NVSE";
const FALLOUT_NV_XNVSE_STATUS_URL = "https://api.github.com/repos/xNVSE/NVSE";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

async function fetchJson(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "falloutfanatics-falloutnv-api/1.0",
        Accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${sourceLabel} returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "falloutfanatics-falloutnv-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = FALLOUT_NV_STEAM_APP_ID) {
  const payload = await fetchJson(
    `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
    "Steam current players API"
  );

  return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
}

function extractPlainTextFromHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return sanitizeDisplayText(match ? extractPlainTextFromHtml(match[1]) : "", 160);
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getFalloutNewVegasStatusPayload() {
  const cacheKey = "falloutnv:status";
  const cached = getCachedPayload(cacheKey, FALLOUT_NV_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [steamPlayersResult, gogPageResult, vivaPageResult, xnvsePageResult] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(FALLOUT_NV_GOG_URL, "Fallout New Vegas GOG page"),
    fetchPageStatus(FALLOUT_NV_VIVA_URL, "Viva New Vegas page"),
    fetchPageStatus(FALLOUT_NV_XNVSE_STATUS_URL, "xNVSE GitHub API")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const gogPage = gogPageResult.status === "fulfilled" ? gogPageResult.value : null;
  const gogPageError = gogPageResult.status === "rejected"
    ? sanitizeDisplayText(gogPageResult.reason?.message || "GOG page request failed.", 180)
    : "";

  const vivaPage = vivaPageResult.status === "fulfilled" ? vivaPageResult.value : null;
  const vivaPageError = vivaPageResult.status === "rejected"
    ? sanitizeDisplayText(vivaPageResult.reason?.message || "Viva New Vegas request failed.", 180)
    : "";

  const xnvsePage = xnvsePageResult.status === "fulfilled" ? xnvsePageResult.value : null;
  const xnvsePageError = xnvsePageResult.status === "rejected"
    ? sanitizeDisplayText(xnvsePageResult.reason?.message || "xNVSE page request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam Web API",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: FALLOUT_NV_STEAM_URL,
      title: "Fallout: New Vegas on Steam",
      description: "Текущий онлайн Fallout New Vegas в Steam. Это число игроков в PC Steam, а не публичный серверный онлайн.",
      note: steamPlayersError ? "Steam API временно не ответил." : "Данные получены из официального Steam current players endpoint."
    },
    {
      key: "gog-page",
      kind: "store",
      name: "Страница GOG",
      sourceLabel: "gog.com",
      status: getStateFromStatus(Boolean(gogPage?.ok)),
      value: gogPage?.status ?? null,
      valueLabel: toHttpValueLabel(gogPage?.status ?? null),
      httpStatus: gogPage?.status ?? null,
      url: gogPage?.url || FALLOUT_NV_GOG_URL,
      title: "Fallout: New Vegas Ultimate Edition on GOG",
      description: "Публичная страница Fallout New Vegas Ultimate Edition в GOG.",
      note: gogPageError ? "Страница GOG временно не ответила." : (gogPage?.ok ? "Страница GOG доступна." : "Страница GOG не подтвердила корректный ответ.")
    },
    {
      key: "viva-new-vegas",
      kind: "guide",
      name: "Viva New Vegas",
      sourceLabel: "moddinglinked.com",
      status: getStateFromStatus(Boolean(vivaPage?.ok)),
      value: vivaPage?.status ?? null,
      valueLabel: toHttpValueLabel(vivaPage?.status ?? null),
      httpStatus: vivaPage?.status ?? null,
      url: vivaPage?.url || FALLOUT_NV_VIVA_URL,
      title: vivaPage?.title || "Viva New Vegas",
      description: "Популярный актуальный гайд по моддингу Fallout New Vegas.",
      note: vivaPageError ? "Viva New Vegas временно не ответил." : (vivaPage?.ok ? "Гайд Viva New Vegas доступен." : "Страница Viva New Vegas не подтвердила корректный ответ.")
    },
    {
      key: "xnvse-github",
      kind: "tool",
      name: "xNVSE GitHub",
      sourceLabel: "GitHub API",
      status: getStateFromStatus(Boolean(xnvsePage?.ok)),
      value: xnvsePage?.status ?? null,
      valueLabel: toHttpValueLabel(xnvsePage?.status ?? null),
      httpStatus: xnvsePage?.status ?? null,
      url: FALLOUT_NV_XNVSE_URL,
      title: xnvsePage?.title || "xNVSE / NVSE",
      description: "Репозиторий xNVSE — одного из главных инструментов для современного моддинга Fallout New Vegas.",
      note: xnvsePageError ? "GitHub API xNVSE временно не ответил." : (xnvsePage?.ok ? "GitHub API xNVSE доступен." : "Источник xNVSE не подтвердил корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "falloutfanatics-falloutnv-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "Fallout New Vegas is not an online service with a public server list. This monitor tracks real Steam player count and the availability of key public game pages.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics Fallout New Vegas API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-falloutnv-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/fallout-new-vegas-status", async (_req, res) => {
  try {
    const payload = await getFalloutNewVegasStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "FALLOUT_NEW_VEGAS_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build Fallout New Vegas status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Fallout New Vegas API listening on http://${HOST}:${PORT}`);
});
