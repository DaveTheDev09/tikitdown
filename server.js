const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const COBALT_URL = process.env.COBALT_URL || "http://localhost:9000";
const OUTPUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const htmlCache = new Map();

const LANGS = ["en", "es", "pt", "fr", "de", "id", "tr", "ru"];
const LOCALES = { en: "en_US", es: "es_ES", pt: "pt_BR", fr: "fr_FR", de: "de_DE", id: "id_ID", tr: "tr_TR", ru: "ru_RU" };
const i18nDicts = {};
for (const l of LANGS) {
  i18nDicts[l] = JSON.parse(fs.readFileSync(path.join(__dirname, "i18n", l + ".json"), "utf8"));
}

let LD_GRAPH = null;
(function loadLdGraph() {
  const raw = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = raw.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      LD_GRAPH = JSON.parse(m[1]);
    } catch (e) {
      console.log("Failed to parse JSON-LD: " + e.message);
    }
  }
})();

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "");
}

function langUrl(lang) {
  return lang === "en" ? "/" : "/" + lang;
}

function buildLocalizedLd(lang, dict) {
  const g = JSON.parse(JSON.stringify(LD_GRAPH));
  const title = dict["meta.title"];
  const desc = dict["meta.desc"];
  const u = langUrl(lang);
  const faqName = stripTags(dict["sec3.title"]);
  const howName = stripTags(dict["sec2.title"]);
  for (const node of g["@graph"]) {
    if (node["@type"] === "WebSite") {
      node.url = u;
      node.description = desc;
      node.inLanguage = lang;
    } else if (node["@type"] === "WebPage") {
      node.url = u;
      node.name = title;
      node.description = desc;
      node.inLanguage = lang;
    } else if (node["@type"] === "SoftwareApplication") {
      node.url = u;
      node.description = desc;
      node.featureList = [dict["meta.nowm"], dict["meta.quality"], dict["meta.noreg"], dict["meta.free"]];
    } else if (node["@type"] === "VideoObject") {
      node.description = desc;
      node.inLanguage = lang;
    } else if (node["@type"] === "FAQPage") {
      node.url = u + "#faq";
      node.name = faqName;
      node.inLanguage = lang;
      node.mainEntity = [];
      for (let i = 1; i <= 14; i++) {
        node.mainEntity.push({
          "@type": "Question",
          name: dict["faq" + i + ".q"],
          acceptedAnswer: { "@type": "Answer", text: dict["faq" + i + ".a"] },
        });
      }
    } else if (node["@type"] === "HowTo") {
      node.name = howName;
      node.step = [];
      for (let i = 1; i <= 3; i++) {
        node.step.push({
          "@type": "HowToStep",
          position: i,
          name: stripTags(dict["step" + i + ".t"]),
          text: stripTags(dict["step" + i + ".d"]),
        });
      }
    }
  }
  return JSON.stringify(g);
}

function localizeHtml(raw, lang) {
  const dict = i18nDicts[lang];
  const title = dict["meta.title"];
  const desc = dict["meta.desc"];
  const u = langUrl(lang);
  let out = raw
    .replace(/<html lang="[^"]*"/, '<html lang="' + lang + '"')
    .replace(/<title>[^<]*<\/title>/, "<title>" + title + "</title>")
    .replace(/(<meta name="description" content=")[^"]*(")/, "$1" + desc + "$2")
    .replace(/(<meta property="og:title" content=")[^"]*(")/, "$1" + title + "$2")
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, "$1" + title + "$2")
    .replace(/(<meta property="og:description" content=")[^"]*(")/, "$1" + desc + "$2")
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, "$1" + desc + "$2")
    .replace(/(<meta property="og:locale" content=")[^"]*(")/, "$1" + LOCALES[lang] + "$2")
    .replace(/(<link rel="canonical" href=")\/[^"]*(")/, "$1" + u + "$2")
    .replace(/(<meta property="og:url" content=")\/[^"]*(")/, "$1" + u + "$2");
  out = out.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    '<script type="application/ld+json">' + buildLocalizedLd(lang, dict) + "</script>"
  );
  const inlineDict = JSON.stringify({
    supported: LANGS,
    defaultLang: "en",
    currentLang: lang,
    strings: { [lang]: dict, en: i18nDicts.en },
  });
  // TIKITDOWN_DOWNLOADER lives in the same script tag — swap only the I18N line.
  out = out.replace(/var TIKITDOWN_I18N\s*=\s*\{[^\n]*\};/, "var TIKITDOWN_I18N = " + inlineDict + ";");
  const hrefs = LANGS.map(
    (l) => '<link rel="alternate" hreflang="' + l + '" href="{{BASE}}' + langUrl(l) + '" />'
  ).join("\n");
  out = out.replace("</head>", hrefs + '\n<link rel="alternate" hreflang="x-default" href="{{BASE}}/" />\n</head>');
  return out;
}

function absolutizeHtml(html, base) {
  return html
    .replace(/(<link rel="canonical" href=")\/([^"]*)(")/g, "$1" + base + "/$2$3")
    .replace(/(<meta property="og:url" content=")\/([^"]*)(")/g, "$1" + base + "/$2$3")
    .replace(/(<meta property="og:image" content=")\/([^"]*)(")/g, "$1" + base + "/$2$3")
    .replace(/(<meta name="twitter:image" content=")\/([^"]*)(")/g, "$1" + base + "/$2$3")
    .replace(/(<meta name="twitter:card" content="summary_large_image"\s*\/?>)/g, function (m) {
      return m;
    });
}

function sendGzip(res, body, contentType, extraHeaders) {
  const headers = {
    "Content-Type": contentType,
    "Content-Encoding": "gzip",
    Vary: "Accept-Encoding",
  };
  Object.assign(headers, extraHeaders || {});
  res.writeHead(200, headers);
  zlib.gzip(body, (err, buf) => {
    if (err) return res.end(body);
    res.end(buf);
  });
}

function serveHtmlFile(req, res, file, lang) {
  const cacheKey = file + "|" + (lang || "en");
  let html = htmlCache.get(cacheKey);
  if (!html) {
    html = fs.readFileSync(file, "utf8");
    if (lang) {
      html = localizeHtml(html, lang);
    }
    htmlCache.set(cacheKey, html);
  }
  const host = req.get("host") || "localhost";
  const proto = req.protocol || "http";
  const base = proto + "://" + host;
  html = html.split("{{BASE}}").join(base);
  const referer = (req.headers.referer || req.headers.referrer || "-").slice(0, 160);
  log("hit " + req.path + " ref=" + referer);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  const acceptGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  if (acceptGzip) {
    sendGzip(res, absolutizeHtml(html, base), "text/html; charset=utf-8");
  } else {
    res.send(absolutizeHtml(html, base));
  }
}

function send404(req, res) {
  res.status(404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(
    "<!doctype html><html lang=\"en-US\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Page not found - TikItDown</title><meta name=\"robots\" content=\"noindex, nofollow\"></head><body style=\"font-family:system-ui,sans-serif;text-align:center;padding:80px 20px;color:#0f1117\"><h1 style=\"font-size:clamp(28px,5vw,44px)\">404 - Page not found</h1><p>The page you are looking for does not exist.</p><p><a href=\"/\" style=\"color:#0d9488\">Go to TikItDown homepage</a></p></body></html>"
  );
}

function isHtmlPath(p) {
  return /\.html?$/i.test(p);
}

function serveSubPage(name) {
  return (req, res) => serveHtmlFile(req, res, path.join(__dirname, name + ".html"));
}

const TOKEN = "eb2d29f073882a99dc5bda9461c19ab12ed648855ac4986303d3a05c910a9c20";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ALLOWED_HOSTS = [
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tikcdn.com",
  "bytedance.com",
  "byteoversea.com",
  "tiktokv.com",
  "muscdn.com",
  "ibyteimg.com",
  "byteimg.com",
  "akamaized.net",
  "bytedn.com",
  "googleapis.com",
  "gstatic.com",
  "w3.org",
  "w3schools.com",
];

const convertCache = new Map();
const convertLocks = new Map();
const convertCacheAge = new Map();

const infoCache = new Map();
const infoInFlight = new Map();
const imageCache = new Map();

const MAX_CACHE_ENTRIES = 60;
const MAX_CONVERSIONS = 2;
let activeConversions = 0;
const convertQueue = [];

function evictOldest(cache, ageMap, cap) {
  while (cache.size > cap) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, ts] of ageMap) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = k;
      }
    }
    if (oldestKey == null) break;
    const file = cache.get(oldestKey);
    if (file && typeof file === "string") {
      try { fs.unlinkSync(file); } catch (e) {}
    }
    cache.delete(oldestKey);
    ageMap.delete(oldestKey);
  }
}

const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 60;
const rateHits = new Map();

function rateLimit(req) {
  const ip = req.ip || req.socket.remoteAddress || "local";
  const nowT = Date.now();
  const rec = rateHits.get(ip) || { count: 0, windowStart: nowT };
  if (nowT - rec.windowStart > RATE_WINDOW) {
    rec.count = 0;
    rec.windowStart = nowT;
  }
  rec.count += 1;
  rateHits.set(ip, rec);
  if (rec.count > RATE_MAX) {
    return { status: "error", code: 429, message: "You have performed the action too quickly. Please slow down!" };
  }
  return null;
}

setInterval(() => {
  const nowT = Date.now();
  for (const [k, v] of rateHits) {
    if (nowT - v.windowStart > RATE_WINDOW) rateHits.delete(k);
  }
  for (const [key, file] of convertCache) {
    const age = nowT - (convertCacheAge.get(key) || 0);
    if (age > 2 * 60 * 60 * 1000) {
      try { fs.unlinkSync(file); } catch (e) {}
      convertCache.delete(key);
      convertCacheAge.delete(key);
    }
  }
  for (const [key, rec] of infoCache) {
    if (nowT - rec.ts > (rec.data ? 60 * 60 * 1000 : 60 * 1000)) infoCache.delete(key);
  }
  for (const [key, rec] of imageCache) {
    if (nowT - rec.ts > 60 * 60 * 1000) imageCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log("[" + now() + "] " + msg);
}

function randId() {
  return crypto.randomBytes(8).toString("hex");
}

function hashKey(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 16);
}

function isAllowedMediaUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch (e) {
    return false;
  }
}

function cleanUrl(input) {
  let u = (input || "").trim();
  if (!/^https?:\/\//i.test(u)) {
    u = "https://" + u;
  }
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("tiktok.com")) return null;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

async function resolveShortLink(url) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(15000),
  });
  return res.url || url;
}

async function fetchTikTokPage(url) {
  let lastErr = null;
  const attempts = [
    { ua: DESKTOP_UA },
    { ua: MOBILE_UA },
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": a.ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        lastErr = new Error("HTTP " + res.status);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error("HTTP " + res.status);
        continue;
      }
      const html = await res.text();
      if (html.includes("captcha") && !html.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
        lastErr = new Error("captcha");
        continue;
      }
      return html;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch TikTok page");
}

function extractRehydrationData(html) {
  const m = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

function pickUrl(list) {
  if (!list) return null;
  const arr = Array.isArray(list) ? list : [list];
  for (const item of arr) {
    if (typeof item === "string" && item) return item;
    if (item && typeof item.src === "string" && item.src) return item.src;
    if (item && typeof item.url === "string" && item.url) return item.url;
    if (item && Array.isArray(item.urlList) && item.urlList.length) return item.urlList[0];
  }
  return null;
}

function noWatermark(playUrl) {
  if (!playUrl) return null;
  const withPlay = playUrl.replace(/\/playwm\//, "/play/");
  const withPlayv2 = withPlay.replace(/\/play\//, "/playv2/");
  if (withPlayv2 !== playUrl) return withPlayv2;
  if (withPlay !== playUrl) return withPlay;
  return null;
}

function parseAweme(data) {
  const module = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__["webapp.video-detail"];
  if (!module || !module.itemInfo || !module.itemInfo.itemStruct) return null;
  const item = module.itemInfo.itemStruct;
  const id = String(item.id || item.aweme_id || "");
  const author =
    item.author && item.author.uniqueId
      ? item.author
      : item.creator && item.creator.uniqueId
      ? item.creator
      : null;
  const nickname = (author && (author.nickname || author.uniqueId)) || "TikTok User";
  const avatar = pickUrl((author && (author.avatarLarger || author.avatarMedium || author.avatarThumb)) || null) || "";
  const cover = pickUrl(item.video && item.video.cover) || pickUrl(item.video && item.video.originCover) || "";
  const desc = (item.desc || "").trim();
  const duration = Math.round(((item.video && item.video.duration) || item.duration || (item.music && item.music.duration) || 0) / 1000);
  const createTime = item.createTime || item.create_time || 0;
  const viewCount = (item.stats && (item.stats.playCount || item.stats.play_count)) || 0;

  const photos = [];
  if (item.imagePost && Array.isArray(item.imagePost.images)) {
    for (const img of item.imagePost.images) {
      const u = pickUrl(img && (img.imageUrl || img.displayImage || img.cover));
      if (u) photos.push({ url: u, title: img.imageURLTag || "" });
    }
  }

  let videoUrl = "";
  let videoWidth = 0;
  let videoHeight = 0;
  if (item.video) {
    videoWidth = parseInt(item.video.width, 10) || parseInt((item.video.playAddr && item.video.playAddr.width) || "0", 10) || 0;
    videoHeight = parseInt(item.video.height, 10) || parseInt((item.video.playAddr && item.video.playAddr.height) || "0", 10) || 0;
    const playAddr = pickUrl(item.video.playAddr || item.video.play_addr);
    const downloadAddr = pickUrl(item.video.downloadAddr || item.video.download_addr);
    if (downloadAddr && isAllowedMediaUrl(downloadAddr)) {
      videoUrl = downloadAddr;
    } else if (playAddr) {
      videoUrl = noWatermark(playAddr) || playAddr;
    } else if (item.video.playUrl) {
      videoUrl = item.video.playUrl;
    }
  }

  const musicUrl =
    pickUrl(item.music && (item.music.playUrl || item.music.play_url)) ||
    pickUrl(item.music && item.music.url) ||
    "";
  const musicTitle = (item.music && (item.music.title || item.music.originalTitle)) || "";
  const musicAuthor = (item.music && (item.music.author || item.music.artists && item.music.artists[0])) || "";

  const type = photos.length > 0 ? "photo" : "video";

  return {
    aweme_id: id,
    title: desc,
    author: { name: nickname, nickname, avatar, uniqueId: (author && author.uniqueId) || "" },
    cover,
    duration,
    create_time: createTime,
    view_count: viewCount,
    type,
    video: videoUrl
      ? { url: videoUrl, url_nwm: videoUrl, watermark: false, width: videoWidth, height: videoHeight }
      : null,
    music: musicUrl ? { title: musicTitle, author: musicAuthor, url: musicUrl, duration } : null,
    photos,
  };
}

function mapTikwmData(j) {
  const d = j && j.data;
  if (!d) return null;
  const photos = Array.isArray(d.images)
    ? d.images.map((u) => ({ url: u, title: "" }))
    : [];
  const author = d.author || {};
  return {
    aweme_id: String(d.id || ""),
    title: (d.title || d.desc || "").trim(),
    author: {
      name: author.nickname || author.unique_id || "TikTok User",
      nickname: author.nickname || author.unique_id || "TikTok User",
      avatar: author.avatar || "",
      uniqueId: author.unique_id || "",
    },
    cover: d.cover || "",
    duration: d.duration || 0,
    create_time: d.create_time || 0,
    view_count: d.play_count || 0,
    type: photos.length > 0 ? "photo" : "video",
    video: d.play
      ? {
          url: d.hdplay || d.play,
          url_nwm: d.play,
          url_hd: d.hdplay || d.play,
          watermark: false,
          width: parseInt(d.width || d.video_width || "0", 10) || 0,
          height: parseInt(d.height || d.video_height || "0", 10) || 0,
        }
      : null,
    music:
      d.music || d.music_info && d.music_info.play_url
        ? {
            title: (d.music_info && (d.music_info.title || d.music_info.author)) || d.music_title || "",
            author: d.music_info ? d.music_info.author : "",
            url: d.music || (d.music_info && d.music_info.play_url) || "",
            duration: d.duration || 0,
          }
        : null,
    photos,
  };
}

async function searchCobalt(url) {
  const res = await fetch(COBALT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ url, videoQuality: "1080", filenameStyle: "basic" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (j.status !== "tunnel" && j.status !== "redirect" && j.status !== "stream") return null;
  const videoUrl = j.url;
  if (!videoUrl) return null;
  // Cobalt tunnel URLs are already proxied through Cobalt's CDN, no need for our proxy
  return {
    aweme_id: j.filename || "",
    title: j.filename || "TikTok Video",
    author: { name: "TikTok User", nickname: "TikTok User", avatar: "", uniqueId: "" },
    cover: "",
    duration: 0,
    create_time: 0,
    view_count: 0,
    type: "video",
    video: { url: videoUrl, url_nwm: videoUrl, url_hd: videoUrl, watermark: false, width: 0, height: 0, need_proxy: false },
    music: null,
    images: [],
    _source: "cobalt",
  };
}

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-j", "--no-warnings", "--no-check-certificates",
      "--no-playlist",
      "--socket-timeout", "20",
      url,
    ];
    const proc = execFile("yt-dlp", args, { timeout: 25000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("Failed to parse yt-dlp output"));
      }
    });
  });
}

function mapYtDlpData(j) {
  const formats = j.formats || [];
  const videoFormats = formats.filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.url);
  const audioFormats = formats.filter(f => f.vcodec === "none" && f.acodec !== "none" && f.url);

  const bestVideo = videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const hdVideo = videoFormats.filter(f => (f.height || 0) >= 720).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const sdVideo = videoFormats.filter(f => (f.height || 0) < 720 && (f.height || 0) >= 360).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const lowVideo = videoFormats.filter(f => (f.height || 0) < 360).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

  const pick = (f) => f ? {
    cdn_url: f.url,
    ext: f.ext || "mp4",
    height: f.height || 0,
    width: f.width || 0,
    label: f.height ? f.height + "p" : f.format_note || "original",
    filesize: f.filesize || f.filesize_approx || 0,
    need_proxy: false,
  } : null;

  const isPhoto = (j._type === "photo") || (j.extractor === "TikTok" && !bestVideo && !j.url);
  let images = [];
  if (isPhoto && j.thumbnails) {
    images = j.thumbnails.map(t => ({ url: t.url, title: "" }));
  }

  return {
    aweme_id: j.id || "",
    title: (j.fulltitle || j.title || "").trim(),
    author: {
      name: j.uploader || j.creator || "TikTok User",
      nickname: j.uploader || j.creator || "TikTok User",
      avatar: j.channel_follower_count ? "" : "",
      uniqueId: j.creator || "",
    },
    cover: (j.thumbnail || (j.thumbnails && j.thumbnails[0] && j.thumbnails[0].url) || ""),
    duration: j.duration || 0,
    create_time: j.upload_date ? Math.floor(new Date(j.upload_date).getTime() / 1000) : 0,
    view_count: j.view_count || 0,
    type: isPhoto ? "photo" : "video",
    video: pick(bestVideo || hdVideo || sdVideo || lowVideo),
    video_hd: pick(hdVideo || bestVideo),
    video_sd: pick(sdVideo || lowVideo),
    music: bestAudio ? {
      title: j.track || "",
      author: j.artist || "",
      url: bestAudio.url,
      duration: j.duration || 0,
    } : null,
    images,
  };
}

async function searchTikwm(url) {
  const res = await fetch("https://www.tikwm.com/api/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": DESKTOP_UA,
      Accept: "application/json",
    },
    body: new URLSearchParams({ url }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (j.code !== 0) return null;
  return mapTikwmData(j);
}

async function searchDirect(url) {
  const resolved = await resolveShortLink(url);
  const page = await fetchTikTokPage(resolved);
  const rehydrated = extractRehydrationData(page);
  if (!rehydrated) return null;
  return parseAweme(rehydrated);
}

async function getVideoData(url) {
  let data = null;
  let source = "unknown";

  // 1. Try Cobalt first (fastest, streaming proxy)
  try {
    data = await searchCobalt(url);
    if (data && data.video) source = "cobalt";
    else data = null;
  } catch (e) {
    log("cobalt failed: " + (e && e.message || e));
    data = null;
  }

  // 2. Fallback to yt-dlp (reliable, works on VPS)
  if (!data) {
    try {
      const raw = await runYtDlp(url);
      data = mapYtDlpData(raw);
      if (data && (data.video || data.images.length > 0)) source = "ytdlp";
      else data = null;
    } catch (e) {
      log("yt-dlp failed: " + (e && e.message || e));
      data = null;
    }
  }

  // 2. Fallback to tikwm (only works with vm.tiktok.com short URLs)
  if (!data) {
    try {
      data = await searchTikwm(url);
      if (data) source = "tikwm";
    } catch (e) {
      data = null;
    }
  }

  // 3. Fallback to direct TikTok scrape
  if (!data) {
    try {
      data = await searchDirect(url);
      if (data) source = "direct";
    } catch (e) {
      data = null;
    }
  }

  if (data) data._source = source;
  return data;
}

async function getVideoDataCached(url) {
  const hit = infoCache.get(url);
  if (hit && Date.now() - hit.ts < (hit.data ? 60 * 60 * 1000 : 60 * 1000)) {
    return hit.data;
  }
  if (infoInFlight.has(url)) {
    return infoInFlight.get(url);
  }
  const p = (async () => {
    const data = await getVideoData(url);
    infoCache.set(url, { ts: Date.now(), data });
    if (infoCache.size > 300) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, rec] of infoCache) {
        if (rec.ts < oldestTs) {
          oldestTs = rec.ts;
          oldestKey = k;
        }
      }
      if (oldestKey != null) infoCache.delete(oldestKey);
    }
    return data;
  })();
  infoInFlight.set(url, p);
  p.finally(() => infoInFlight.delete(url));
  return p;
}

function proxyImageUrl(u) {
  return "/img?u=" + encodeURIComponent(u);
}

const sizeCache = new Map();

const probeCache = new Map();

function probeVideoSize(url) {
  return new Promise((resolve) => {
    const hit = probeCache.get(url);
    if (hit && Date.now() - hit.ts < 60 * 60 * 1000) return resolve(hit.size);
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-rw_timeout",
        "10000000",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        url,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        let size = { width: 0, height: 0 };
        if (!err) {
          const parts = stdout.trim().split(",");
          const w = parseInt(parts[0], 10);
          const h = parseInt(parts[1], 10);
          if (isFinite(w) && isFinite(h) && h > 0) size = { width: w, height: h };
        }
        probeCache.set(url, { ts: Date.now(), size });
        resolve(size);
      }
    );
  });
}

async function getRemoteSize(url) {
  const hit = sizeCache.get(url);
  if (hit && Date.now() - hit.ts < 60 * 60 * 1000) return hit.bytes;
  let bytes = 0;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": DESKTOP_UA, Referer: "https://www.tiktok.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const cl = parseInt(res.headers.get("content-length") || "", 10);
      if (isFinite(cl) && cl > 0) bytes = cl;
    }
  } catch (e) {}
  if (!bytes) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": DESKTOP_UA, Referer: "https://www.tiktok.com/", Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const cr = res.headers.get("content-range");
        const m = cr && cr.match(/\/(\d+)\s*$/);
        if (m) bytes = parseInt(m[1], 10) || 0;
      }
    } catch (e) {}
  }
  sizeCache.set(url, { ts: Date.now(), bytes });
  return bytes;
}

function toTemplateData(data, sizes) {
  const qualities = {};
  sizes = sizes || { video: 0, music: 0 };
  const source = data._source || "unknown";
  const needsProxy = source === "direct" || source === "ytdlp" || source === "cobalt"; // cobalt tunnel URLs need attachment header via proxy
  if (data.video && data.video.url_nwm) {
    const hdUrl = data.video.url_hd || data.video.url_nwm;
    const sdUrl = data.video.url_nwm;
    qualities.best = {
      cdn_url: hdUrl,
      ext: "mp4",
      height: data.video.height || 0,
      width: data.video.width || 0,
      label: "original",
      filesize: sizes.video || 0,
      need_proxy: needsProxy,
    };
    qualities.sd = {
      cdn_url: sdUrl,
      ext: "mp4",
      height: 0,
      width: 0,
      label: "sd",
      filesize: sizes.video || 0,
      need_proxy: needsProxy,
    };
  }
  if (data.music && data.music.url) {
    qualities.audio = { cdn_url: data.music.url, ext: "mp3", label: "audio", filesize: sizes.music || 0, need_proxy: needsProxy };
  }
  const images = data.photos && data.photos.length ? data.photos.map((p) => proxyImageUrl(p.url)) : [];
  return {
    source,
    qualities,
    images,
    thumbnail: data.cover ? proxyImageUrl(data.cover) : "",
    thumbnail_raw: data.cover || "",
    author: data.author && (data.author.name || data.author.nickname) || "",
    description: data.title || "",
    view_count: data.view_count || 0,
    duration: data.duration || 0,
  };
}

app.get("/api", (req, res) => {
  res.json({ status: "success", message: "TikItDown Downloader API", version: "2", token: TOKEN });
});

app.post("/info", async (req, res) => {
  const limited = rateLimit(req);
  if (limited) return res.status(429).json({ code: "too_many_requests", detail: limited.message });
  const rawUrl = (req.body && req.body.url || "").trim();

  // TEST MODE: if URL contains "testmode", return mock data for UI testing
  if (rawUrl.includes("testmode")) {
    log("test mode triggered");
    return res.json({
      source: "hybrid",
      qualities: {
        best: {
          cdn_url: "https://media.w3.org/2010/05/sintel/trailer_hd.mp4",
          ext: "mp4",
          height: 1080,
          width: 1920,
          label: "original",
          filesize: 14621544,
        },
        sd: {
          cdn_url: "https://media.w3.org/2010/05/sintel/trailer.mp4",
          ext: "mp4",
          height: 360,
          width: 640,
          label: "sd",
          filesize: 5000000,
        },
        audio: {
          cdn_url: "https://media.w3.org/2010/05/sintel/trailer.mp3",
          ext: "mp3",
          label: "audio",
          filesize: 1500000,
        },
      },
      images: [],
      thumbnail: "https://media.w3.org/2010/05/sintel/poster.png",
      thumbnail_raw: "https://media.w3.org/2010/05/sintel/poster.png",
      author: "Test Creator",
      description: "Test video for UI debugging - paste any URL with 'testmode' to trigger this",
      view_count: 31400000,
      duration: 35,
    });
  }

  const clean = cleanUrl(rawUrl);
  if (!clean) {
    return res.status(400).json({ code: "invalid_url", detail: "Wrong link format. Paste the TikTok URL and try again!" });
  }

  let data = null;
  try {
    data = await getVideoDataCached(clean);
  } catch (e) {
    log("info error: " + (e && e.message || e));
    data = null;
  }
  if (!data) {
    log("info no data for " + clean);
    return res.status(400).json({ code: "fetch_failed", detail: "Could not fetch video data. Please try again." });
  }
  const sizes = { video: 0, music: 0 };
  await Promise.all([
    (async () => {
      if (data.video && data.video.url_nwm) sizes.video = await getRemoteSize(data.video.url_nwm);
    })(),
    (async () => {
      if (data.music && data.music.url) sizes.music = await getRemoteSize(data.music.url);
    })(),
  ]);
  if (data.video && data.video.url_nwm && (!data.video.height || data.video.height <= 0)) {
    const probed = await probeVideoSize(data.video.url_nwm);
    if (probed && probed.height > 0) {
      data.video.width = probed.width;
      data.video.height = probed.height;
    }
  }
  res.json(toTemplateData(data, sizes));
});

app.get("/geo", (req, res) => {
  res.json({ code: "US" });
});

app.post("/stats/download", (req, res) => {
  res.status(204).end();
});

async function downloadToFile(url, file) {
  const isTikTok = /tiktok|tikcdn|bytedance|byteoversea|muscdn|ibyteimg|byteimg|akamaized|bytedn/i.test(url);
  const headers = { "User-Agent": DESKTOP_UA };
  if (isTikTok) headers.Referer = "https://www.tiktok.com/";
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error("download failed " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return file;
}

function runFfmpeg(args, onProgress) {
  const fullArgs = onProgress ? args.concat(["-progress", "pipe:1"]) : args;
  return new Promise((resolve, reject) => {
    const child = execFile("ffmpeg", fullArgs, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
    if (onProgress) {
      child.stdout.on("data", (chunk) => {
        const m = chunk.toString().match(/out_time_ms=(\d+)/);
        if (m) onProgress(parseInt(m[1], 10) / 1e6);
      });
    }
  });
}

function singleFlight(key, fn) {
  const lock = convertLocks.get(key);
  if (lock) return lock;
  const p = fn().then((file) => {
    convertCache.set(key, file);
    convertCacheAge.set(key, Date.now());
    evictOldest(convertCache, convertCacheAge, MAX_CACHE_ENTRIES);
    return file;
  });
  convertLocks.set(key, p);
  p.then(
    () => convertLocks.delete(key),
    () => convertLocks.delete(key)
  );
  return p;
}

async function withConvertSlot(fn) {
  if (activeConversions >= MAX_CONVERSIONS) {
    await new Promise((resolve) => convertQueue.push(resolve));
  }
  activeConversions += 1;
  try {
    return await fn();
  } finally {
    activeConversions -= 1;
    if (convertQueue.length) convertQueue.shift()();
  }
}

async function convertToMp3File(cdnUrl) {
  const key = "mp3|" + hashKey(cdnUrl);
  return singleFlight(key, () => withConvertSlot(async () => {
    const cached = convertCache.get(key);
    if (cached && fs.existsSync(cached)) return cached;
    const id = randId();
    const tmp = path.join(OUTPUT_DIR, id + ".src");
    await downloadToFile(cdnUrl, tmp);
    const out = path.join(OUTPUT_DIR, id + ".mp3");
    try {
      await runFfmpeg(["-y", "-i", tmp, "-vn", "-acodec", "libmp3lame", "-q:a", "2", out]);
      try { fs.unlinkSync(tmp); } catch (e) {}
    } catch (e) {
      log("mp3 re-encode failed, serving source audio: " + e.message.slice(0, 120));
      fs.renameSync(tmp, out);
    }
    log("mp3 ready " + key);
    return out;
  }));
}

const QUALITY_HEIGHT = { "720p": 720, "480p": 480, "360p": 360, "240p": 240 };

async function convertToQualityFile(cdnUrl, quality) {
  const height = QUALITY_HEIGHT[quality];
  if (!height) throw new Error("unsupported quality " + quality);
  const key = quality + "|" + hashKey(cdnUrl);
  return singleFlight(key, () => withConvertSlot(async () => {
    const cached = convertCache.get(key);
    if (cached && fs.existsSync(cached)) return cached;
    const id = randId();
    const tmp = path.join(OUTPUT_DIR, id + ".src");
    await downloadToFile(cdnUrl, tmp);
    const out = path.join(OUTPUT_DIR, id + ".mp4");
    try {
      await runFfmpeg([
        "-y", "-i", tmp,
        "-vf", "scale=-2:" + height,
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        out,
      ]);
      try { fs.unlinkSync(tmp); } catch (e) {}
    } catch (e) {
      log("quality re-encode failed for " + quality + ": " + e.message.slice(0, 120));
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
    log("quality ready " + key);
    return out;
  }));
}

function streamFile(req, res, file, contentType) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isFinite(start) && start < stat.size && end >= start) {
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": "bytes " + start + "-" + end + "/" + stat.size,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

async function proxyMedia(req, res, cdnUrl) {
  const isTikTok = /tiktok|tikcdn|bytedance|byteoversea|muscdn|ibyteimg|byteimg|akamaized|bytedn/i.test(cdnUrl);
  const headers = {};
  if (isTikTok) {
    headers["User-Agent"] = DESKTOP_UA;
    headers["Referer"] = "https://www.tiktok.com/";
  }
  const r = await fetch(cdnUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("upstream " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const filename = req.query.filename;
  const contentDisp = filename
    ? 'attachment; filename="' + String(filename).replace(/[^\w.\s-]/g, "").slice(0, 100) + '"'
    : "inline";
  res.writeHead(200, {
    "Content-Type": r.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": contentDisp,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

app.get("/download", async (req, res) => {
  const cdnUrl = req.query.cdn_url;
  if (!cdnUrl || !isAllowedMediaUrl(cdnUrl)) {
    return res.status(400).json({ code: "invalid_url", detail: "Invalid media URL." });
  }
  try {
    const isTikTok = /tiktok|tikcdn|bytedance|byteoversea|muscdn|ibyteimg|byteimg|akamaized|bytedn/i.test(cdnUrl);
    const headers = {};
    if (isTikTok) {
      headers["User-Agent"] = DESKTOP_UA;
      headers["Referer"] = "https://www.tiktok.com/";
    }
    const r = await fetch(cdnUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error("upstream " + r.status);
    const filename = req.query.filename || "tikdownloader.mp4";
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="' + String(filename).replace(/[^\w.\s-]/g, "").slice(0, 100) + '"');
    res.setHeader("Cache-Control", "no-store");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    log("download error: " + e.message);
    if (!res.headersSent) {
      res.status(502).json({ code: "download_failed", detail: "Download failed, try again." });
    }
  }
});

// Direct CDN proxy (like snapcdn.app - server fetches with proper headers, sends to browser)
app.get("/api/fetch", async (req, res) => {
  const u = req.query.url;
  const name = req.query.name || "tikdownloader.mp4";
  if (!u) {
    return res.status(400).json({ code: "invalid_url", detail: "Invalid URL." });
  }
  try {
    const isTikTok = /tiktok|tikcdn|bytedance|byteoversea|muscdn|ibyteimg|byteimg|akamaized|bytedn|tikwm/i.test(u);
    const opts = { redirect: "follow", signal: AbortSignal.timeout(60000) };
    if (isTikTok) {
      opts.headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://www.tiktok.com/",
        "Accept": "video/mp4,*/*",
      };
    }
    const r = await fetch(u, opts);
    if (!r.ok) {
      log("fetch upstream " + r.status + " for " + u.substring(0, 80));
      return res.status(502).json({ code: "download_failed", detail: "Upstream returned " + r.status });
    }
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="' + String(name).replace(/[^\w.\s-]/g, "").slice(0, 100) + '"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const reader = r.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    await pump();
  } catch (e) {
    log("fetch error: " + e.message);
    if (!res.headersSent) {
      res.status(502).json({ code: "download_failed", detail: "Download failed: " + e.message });
    }
  }
});

app.get("/img", async (req, res) => {
  const u = req.query.u;
  if (!u || !isAllowedMediaUrl(u)) {
    return res.status(400).json({ code: "invalid_url", detail: "Invalid image URL." });
  }
  const hit = imageCache.get(u);
  if (hit && Date.now() - hit.ts < 60 * 60 * 1000) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", hit.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(hit.buf);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(u, {
      headers: { "User-Agent": MOBILE_UA, Referer: "https://www.tiktok.com/" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error("upstream " + r.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = Buffer.from(await r.arrayBuffer());
    imageCache.set(u, { ts: Date.now(), type: r.headers.get("content-type") || "image/jpeg", buf });
    if (imageCache.size > 200) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, rec] of imageCache) {
        if (rec.ts < oldestTs) {
          oldestTs = rec.ts;
          oldestKey = k;
        }
      }
      if (oldestKey != null) imageCache.delete(oldestKey);
    }
    res.send(buf);
  } catch (e) {
    res.status(502).json({ code: "download_failed", detail: "An error occurred, please try again." });
  }
});

app.get("/sitemap.xml", (req, res) => {
  const host = req.get("host") || "localhost";
  const proto = req.protocol || "http";
  const base = proto + "://" + host;
  const pages = [
    ["/", "daily", "1.0", "2026-08-17"],
    ["/es", "daily", "0.9", "2026-08-18"],
    ["/pt", "daily", "0.9", "2026-08-18"],
    ["/fr", "daily", "0.9", "2026-08-18"],
    ["/de", "daily", "0.9", "2026-08-18"],
    ["/id", "daily", "0.9", "2026-08-18"],
    ["/tr", "daily", "0.9", "2026-08-18"],
    ["/ru", "daily", "0.9", "2026-08-18"],
    ["/tiktok-video-download", "weekly", "0.9", "2026-08-18"],
    ["/how-to-download-tiktok-videos", "weekly", "0.8", "2026-08-17"],
    ["/tiktok-mp3-downloader", "weekly", "0.7", "2026-08-17"],
    ["/douyin-downloader", "weekly", "0.7", "2026-08-17"],
    ["/tiktok-slideshow-downloader", "weekly", "0.7", "2026-08-18"],
    ["/tiktok-downloader-for-iphone", "weekly", "0.7", "2026-08-18"],
    ["/tiktok-downloader-for-android", "weekly", "0.7", "2026-08-18"],
    ["/tiktok-watermark-remover", "weekly", "0.7", "2026-08-18"],
    ["/snaptik-alternative", "weekly", "0.7", "2026-08-18"],
    ["/is-tiktok-downloader-safe", "weekly", "0.6", "2026-08-18"],
    ["/blog", "weekly", "0.6", "2026-08-17"],
    ["/blog/tikitdown-vs-ssstik-vs-snaptik", "monthly", "0.6", "2026-08-17"],
    ["/blog/tiktok-downloader-for-pc", "weekly", "0.7", "2026-08-17"],
    ["/about", "monthly", "0.3", "2026-08-17"],
    ["/privacy-policy", "yearly", "0.2", "2026-08-17"],
    ["/dmca", "yearly", "0.2", "2026-08-17"],
    ["/terms-of-use", "yearly", "0.2", "2026-08-17"],
    ["/cookie-policy", "yearly", "0.2", "2026-08-17"],
    ["/disclaimer", "yearly", "0.2", "2026-08-17"],
  ];
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    pages
      .map(
        ([p, freq, pri, lastmod]) =>
          "<url><loc>" +
          base +
          p +
          "</loc><lastmod>" +
          lastmod +
          "</lastmod><changefreq>" +
          freq +
          "</changefreq><priority>" +
          pri +
          "</priority></url>"
      )
      .join("") +
    "</urlset>";
  if ((req.headers["accept-encoding"] || "").includes("gzip")) {
    sendGzip(res, Buffer.from(xml), "application/xml; charset=utf-8");
  } else {
    res.send(xml);
  }
});

app.get("/robots.txt", (req, res) => {
  const host = req.get("host") || "localhost";
  const proto = req.protocol || "http";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /output/\n" +
      "Disallow: /deploy/\n" +
      "Disallow: /server.js\n" +
      "Disallow: /package.json\n" +
      "Disallow: /package-lock.json\n" +
      "Disallow: /*.html$\n\n" +
      "Sitemap: " +
      proto +
      "://" +
      host +
      "/sitemap.xml\n"
  );
});

app.use((req, res, next) => {
  const p = req.path;
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (p.length > 1 && p.endsWith("/")) {
    const clean = p.replace(/\/+$/, "") || "/";
    return res.redirect(301, clean + (req.url.replace(p, "")));
  }
  if (isHtmlPath(p)) {
    let clean = p.replace(/\.html?$/i, "");
    if (clean.endsWith("/index")) clean = clean.slice(0, -"/index".length) || "/";
    return res.redirect(301, clean);
  }
  next();
});

const subPages = [
  "/how-to-download-tiktok-videos",
  "/tiktok-mp3-downloader",
  "/douyin-downloader",
  "/tiktok-video-download",
  "/snaptik-alternative",
  "/tiktok-slideshow-downloader",
  "/tiktok-downloader-for-iphone",
  "/tiktok-downloader-for-android",
  "/tiktok-watermark-remover",
  "/is-tiktok-downloader-safe",
  "/about",
  "/privacy-policy",
  "/dmca",
  "/terms-of-use",
  "/cookie-policy",
  "/disclaimer",
];
subPages.forEach((p) => {
  app.get(p, serveSubPage(p.slice(1)));
});

app.get("/blog", serveSubPage("blog"));
app.get("/blog/tikitdown-vs-ssstik-vs-snaptik", serveSubPage("blog/tikitdown-vs-ssstik-vs-snaptik"));
app.get("/blog/tiktok-downloader-for-pc", serveSubPage("blog/tiktok-downloader-for-pc"));

app.use(
  "/output",
  (req, res) => {
    res.status(403).end();
  }
);

app.get("/", (req, res) => serveHtmlFile(req, res, path.join(__dirname, "index.html"), "en"));

app.use((req, res, next) => {
  if (req.path.indexOf("/i18n/") === 0) return res.status(403).end();
  next();
});

app.use(
  express.static(__dirname, {
    setHeaders(res, filePath) {
      if (/[\\/]wp-content[\\/]|[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    },
  })
);

app.get("/:lang", (req, res, next) => {
  if (!LANGS.includes(req.params.lang)) return next();
  if (req.params.lang === "en") return res.redirect(301, "/");
  serveHtmlFile(req, res, path.join(__dirname, "index.html"), req.params.lang);
});

// Clean URL routes for SEO pages
const SEO_PAGES = [
  "tiktok-no-watermark",
  "tiktok-hd-downloader",
  "tiktok-mp4",
  "tiktok-photo-downloader",
  "tiktok-slideshow-downloader",
  "tiktok-story-downloader",
  "tiktok-profile-downloader",
  "tiktok-downloader-mac",
  "tiktok-downloader-windows",
  "tiktok-downloader-for-iphone",
  "tiktok-downloader-for-android",
  "tiktok-mp3-downloader",
  "tiktok-video-download",
  "tiktok-watermark-remover",
  "how-to-download-tiktok-videos",
  "how-to-download-tiktok-photos",
  "how-to-download-tiktok-slideshows",
  "ssstik-alternative",
  "snaptik-alternative",
  "best-tiktok-downloaders",
  "douyin-downloader",
  "is-tiktok-downloader-safe",
  "about",
  "blog",
  "terms-of-use",
  "privacy-policy",
  "dmca",
  "disclaimer",
  "cookie-policy",
  // Tier 2 - Content type
  "tiktok-carousel-downloader",
  "tiktok-image-downloader",
  "tiktok-live-downloader",
  "tiktok-avatar-downloader",
  "tiktok-music-downloader",
  "tiktok-video-saver",
  "tiktok-link-downloader",
  "tiktok-url-downloader",
  // Tier 3 - Advanced
  "tiktok-batch-downloader",
  "tiktok-bulk-downloader",
  "tiktok-playlist-downloader",
  "tiktok-video-downloader-api",
  "tiktok-api",
  "tiktok-audio-extractor",
  "tiktok-zip-download",
  // Tier 4 - Device
  "tiktok-downloader-ipad",
  "tiktok-downloader-ios",
  "tiktok-downloader-pc",
  "tiktok-downloader-chromebook",
  // Tier 5 - Browser
  "tiktok-downloader-chrome",
  "tiktok-downloader-safari",
  "tiktok-downloader-firefox",
  "tiktok-downloader-edge",
  // Tier 6 - How-to
  "how-to-download-tiktok-videos-without-watermark",
  "how-to-save-tiktok-videos",
  "how-to-download-tiktok-audio",
  "how-to-download-tiktok-videos-on-iphone",
  "how-to-download-tiktok-videos-on-android",
  "how-to-download-tiktok-videos-on-pc",
  "how-to-download-tiktok-videos-on-mac",
  "tiktok-downloader-not-working",
  "tiktok-download-failed",
  "why-cant-i-download-tiktok-videos",
  // Tier 7 - Comparison
  "savetik-alternative",
  "tikmate-alternative",
  "tiktokio-alternative",
  "ssstik-vs-snaptik",
  "best-tiktok-downloader-without-watermark",
  "musicallydown-alternative",
  // Quality pages
  "tiktok-4k-downloader",
  "tiktok-1080p-downloader",
  "tiktok-720p-downloader",
  "tiktok-480p-downloader",
  "tiktok-240p-downloader",
  "tiktok-120p-downloader",
];
SEO_PAGES.forEach((slug) => {
  app.get("/" + slug, (req, res) => {
    serveHtmlFile(req, res, path.join(__dirname, slug + ".html"));
  });
});

// Blog sub-pages
app.get("/blog/tiktok-downloader-for-pc", (req, res) => {
  serveHtmlFile(req, res, path.join(__dirname, "blog", "tiktok-downloader-for-pc.html"));
});
app.get("/blog/tikitdown-vs-ssstik-vs-snaptik", (req, res) => {
  serveHtmlFile(req, res, path.join(__dirname, "blog", "tikitdown-vs-ssstik-vs-snaptik.html"));
});

app.get("*", (req, res) => {
  if (req.path.indexOf("/api/") === 0) {
    return res.status(404).json({ status: "error", code: 404, message: "No data found. Please try again." });
  }
  send404(req, res);
});

app.listen(PORT, async () => {
  console.log("TikItDown v2 running at http://localhost:" + PORT);
  // Check Cobalt availability
  try {
    const cobaltRes = await fetch(COBALT_URL, { signal: AbortSignal.timeout(3000) });
    if (cobaltRes.ok) console.log("Cobalt: connected");
    else console.warn("Cobalt: responded with " + cobaltRes.status);
  } catch (e) {
    console.warn("WARNING: Cobalt not reachable at " + COBALT_URL);
    console.warn("Install: docker compose up -d cobalt");
  }
  // Check yt-dlp availability
  try {
    await new Promise((resolve, reject) => {
      execFile("yt-dlp", ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else { console.log("yt-dlp version: " + stdout.trim()); resolve(); }
      });
    });
  } catch (e) {
    console.warn("WARNING: yt-dlp not found. Install: pip install yt-dlp");
  }
});