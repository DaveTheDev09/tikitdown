/**
 * DownTik — front-end app.
 * i18n dictionary is injected into the page as DOWNTIK_I18N.
 */
(function () {
  'use strict';

  var supportedLangs = (window.DOWNTIK_I18N && window.DOWNTIK_I18N.supported) || ['en'];
  var dict = (window.DOWNTIK_I18N && window.DOWNTIK_I18N.strings) || {};
  var defaultLng = (window.DOWNTIK_I18N && window.DOWNTIK_I18N.defaultLang) || 'en';
  var routeLng = (window.DOWNTIK_I18N && window.DOWNTIK_I18N.currentLang) || defaultLng;

  var currentLang = routeLng;

  function applyLang(lang) {
    currentLang = lang;
    var d = dict[lang] || {};
    document.documentElement.setAttribute('lang', lang);
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var k = el.getAttribute('data-i18n');
      if (d[k] != null) {
        if (el.hasAttribute('data-i18n-html')) el.innerHTML = d[k];
        else el.textContent = d[k];
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-placeholder');
      if (d[k] != null) el.placeholder = d[k];
    });
    var sw = document.getElementById('langSwitch');
    if (sw) {
      sw.setAttribute('data-lang', lang);
      var select = sw.querySelector('select');
      if (select) {
        select.value = lang;
      }
    }
    localStorage.setItem('downtik_lang', lang);
    document.dispatchEvent(new CustomEvent('downtik:langchange', { detail: { lang: lang } }));
  }

  function t(key) {
    return (dict[currentLang] && dict[currentLang][key]) || key;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var navMenuBtn = document.getElementById('navMenuBtn');
    var mobileNav = document.getElementById('mobileNav');

    function closeMobileNav() {
      if (!navMenuBtn || !mobileNav) return;
      navMenuBtn.classList.remove('is-open');
      navMenuBtn.setAttribute('aria-expanded', 'false');
      mobileNav.setAttribute('hidden', '');
    }

    function toggleMobileNav() {
      if (!navMenuBtn || !mobileNav) return;
      var isOpen = navMenuBtn.getAttribute('aria-expanded') === 'true';
      navMenuBtn.classList.toggle('is-open', !isOpen);
      navMenuBtn.setAttribute('aria-expanded', String(!isOpen));
      if (isOpen) {
        mobileNav.setAttribute('hidden', '');
      } else {
        mobileNav.removeAttribute('hidden');
      }
    }

    if (navMenuBtn && mobileNav) {
      navMenuBtn.addEventListener('click', toggleMobileNav);
      mobileNav.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', closeMobileNav);
      });
      window.addEventListener('resize', function () {
        if (window.innerWidth > 720) closeMobileNav();
      });
    }

    var langSelect = document.getElementById('langSwitchSelect');
    if (langSelect) {
      langSelect.addEventListener('change', function () {
        var selectedOption = langSelect.options[langSelect.selectedIndex];
        var targetLang = langSelect.value;
        if (supportedLangs.indexOf(targetLang) === -1) {
          return;
        }
        var targetUrl = selectedOption ? selectedOption.getAttribute('data-switch-url') : '';
        if (targetUrl) {
          var absoluteTarget = new URL(targetUrl, window.location.origin).href;
          if (absoluteTarget !== window.location.href) {
            localStorage.setItem('downtik_lang', targetLang);
            window.location.href = absoluteTarget;
            return;
          }
        }
        applyLang(targetLang);
      });
    }
    if (supportedLangs.indexOf(currentLang) === -1) {
      currentLang = defaultLng;
    }
    applyLang(currentLang);

// ----- toast -----
    var toast = document.getElementById('toast');
    var toastMsg = document.getElementById('toastMsg');
    var toastTimer;
    var shareCountValue = document.getElementById('shareCountValue');
    function showToast(msg) {
      if (!toast || !toastMsg) return;
      toastMsg.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2400);
    }

    function formatShareCount(count) {
      try {
        return new Intl.NumberFormat().format(count);
      } catch (e) {
        return String(count);
      }
    }

    function updateShareCountUi(count) {
      if (!shareCountValue) return;
      shareCountValue.textContent = formatShareCount(count);
    }

    // ----- downloader input -----
    var urlInput = document.getElementById('urlInput');
    var downloader = document.getElementById('downloader');
    var pasteBtn = document.getElementById('pasteBtn');
    var downloadBtn = document.getElementById('downloadBtn');
    var dlPreview = document.getElementById('dlPreview');
    var dlActions = document.getElementById('dlActions');
    var dlImageGrid = document.getElementById('dlImageGrid');
    var dlResultCard = document.getElementById('dlResultCard');
    var dlStatus = document.getElementById('dlStatus');
    var dlConfig = window.DOWNTIK_DOWNLOADER || {};
    var dlDict = dlConfig.i18n || {};
    var apiBase = dlConfig.apiBase || window.location.origin;
    var dlBase = dlConfig.dlBase || window.location.origin;

    // ----- download telemetry -----
    // Downloads that go straight to the CDN never touch the backend, so the client
    // reports their outcome to /stats/download. Proxied /download requests are
    // already recorded server-side — beaconing those too would double-count them.
    var STATS_ENDPOINT = apiBase + '/stats/download';
    var pendingDownloads = new Set();
    var pagehideFlushInstalled = false;

    function now() {
      return (window.performance && performance.now) ? performance.now() : Date.now();
    }

    function reportDownload(meta, outcome, extra) {
      var body = Object.assign({}, meta, { outcome: outcome, kind: 'video' }, extra || {});
      try {
        fetch(STATS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
          mode: 'cors'
        }).catch(function () {});
      } catch (e) {
        // Telemetry must never break a download.
      }
    }

    // sendBeacon variant for pagehide. The text/plain Blob is deliberate: it keeps
    // the request CORS-simple, so the browser doesn't attempt a preflight it can't
    // finish during teardown. The backend parses the body as JSON regardless.
    function sendDownloadBeacon(body) {
      try {
        navigator.sendBeacon(STATS_ENDPOINT, new Blob([JSON.stringify(body)], { type: 'text/plain' }));
      } catch (e) {
        // ignore
      }
    }

    // pagehide, not unload — it also fires on bfcache eviction and is reliable on
    // mobile Safari. Installed lazily on the first pending download.
    function installPagehideFlush() {
      if (pagehideFlushInstalled) return;
      pagehideFlushInstalled = true;
      window.addEventListener('pagehide', function () {
        if (!pendingDownloads.size) return;
        var ts = now();
        pendingDownloads.forEach(function (entry) {
          sendDownloadBeacon(Object.assign({}, entry.meta, {
            outcome: 'client_abort',
            kind: entry.kind,
            bytes_sent: entry.bytesSeen || null,
            duration_ms: Math.round(ts - entry.startedAt)
          }));
        });
        pendingDownloads.clear();
      });
    }

    // Entries hold everything the beacon needs, so a tab closing mid-download can
    // be reported without reaching back into UI state that may already be gone.
    function beginPending(meta, kind) {
      installPagehideFlush();
      var entry = { meta: meta, kind: kind || 'video', startedAt: now(), bytesSeen: 0 };
      pendingDownloads.add(entry);
      return entry;
    }

    function updatePendingBytes(entry, bytes) {
      if (entry) entry.bytesSeen = bytes;
    }

    function endPending(entry) {
      if (entry) pendingDownloads.delete(entry);
    }

    // Map a (url, source) pair to its beacon meta. Returns null for proxied paths —
    // the server records those itself.
    function directCdnTelemetry(cleanUrl, source) {
      switch (source) {
        case 'tikwm':
          return { platform: 'tiktok', source: 'tikwm' };
        case 'hybrid':
          // Douyin-side hybrid goes through /douyin/redirect (handled separately);
          // TikTok-side hybrid hands back the CDN URL directly.
          return isDouyinUrl(cleanUrl) ? null : { platform: 'tiktok', source: 'hybrid' };
        case 'fb':
          return { platform: 'facebook', source: 'fb' };
        case 'ig':
          return { platform: 'instagram', source: 'ig' };
        case 'xhs':
          return { platform: 'xhs', source: 'xhs' };
        case 'pinterest_image':
          return { platform: 'pinterest', source: 'pinterest_image' };
        default:
          return null;
      }
    }

    var downloadUiState = {
      url: '',
      source: 'scrape',
      qualities: {},
      images: [],
      previewData: null,
      statusKey: '',
      statusText: '',
      statusType: 'idle'
    };

    function td(key) {
      var langPack = dlDict[currentLang] || dlDict[defaultLng] || {};
      return langPack[key] || key;
    }

    function extractUrl(text) {
      if (!text || !text.trim()) return '';
      var trimmed = text.trim();
      if (!/\s/.test(trimmed)) {
        try {
          var directUrl = new URL(trimmed);
          if (directUrl.protocol === 'http:' || directUrl.protocol === 'https:') return trimmed;
        } catch (e) { }
      }
      var platformMatch = trimmed.match(
        /https?:\/\/[^\s]*(?:tiktok\.com|douyin\.com|iesdouyin\.com|facebook\.com|fb\.watch|fb\.com|instagram\.com|pinterest\.[a-z.]+|pin\.it|xiaohongshu\.com|xhslink\.com)[^\s]*/i
      );
      if (platformMatch) return platformMatch[0];
      var anyUrl = trimmed.match(/https?:\/\/[^\s]+/);
      if (anyUrl) return anyUrl[0];
      return trimmed;
    }


    function isDouyinUrl(url) {
      return /douyin\.com|iesdouyin\.com/i.test(url);
    }

    function isFacebookUrl(url) {
      return /facebook\.com|fb\.watch|fb\.com/i.test(url);
    }

    function isInstagramUrl(url) {
      return /instagram\.com/i.test(url);
    }

    function isPinterestUrl(url) {
      return /pinterest\.[a-z.]+|pin\.it/i.test(url);
    }

    function isXiaohongshuUrl(url) {
      return /xiaohongshu\.com|xhslink\.com/i.test(url);
    }

    function isSupportedUrl(url) {
      return /tiktok\.com|vm\.tiktok|vt\.tiktok|douyin\.com|iesdouyin\.com|facebook\.com|fb\.watch|fb\.com|instagram\.com|pinterest\.[a-z.]+|pin\.it|xiaohongshu\.com|xhslink\.com/i.test(url);
    }

    // Canonical tiktok.com pages that can never be a single video (profile,
    // livestream, music/tag/search sections). Mirrors tiktok_nonvideo_page()
    // in the backend (tiktok_dl/utils.py) — keep the two in sync. Short links
    // (vt./vm./tiktok.com/t/) pass through: their target is unknown until
    // resolved, so the backend stays the safety net for those.
    var TIKTOK_PAGE_PREFIXES = ['/music', '/discover', '/tag', '/search', '/explore', '/foryou', '/following', '/friends', '/upload', '/tiktoklite', '/about', '/legal'];

    function tiktokNonVideoKind(url) {
      if (!url) return null;
      var raw = url.indexOf('://') === -1 ? 'https://' + url : url;
      var parsed;
      try { parsed = new URL(raw); } catch (e) { return null; }
      var host = (parsed.hostname || '').toLowerCase();
      if (host !== 'tiktok.com' && host !== 'www.tiktok.com' && host !== 'm.tiktok.com') return null;
      var path = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
      if (/^\/@[^/]+\/live$/.test(path) || path === '/live') return 'live';
      if (/^\/@[^/]+$/.test(path)) return 'profile';
      if (path === '/') return 'page';
      for (var i = 0; i < TIKTOK_PAGE_PREFIXES.length; i++) {
        if (path === TIKTOK_PAGE_PREFIXES[i] || path.indexOf(TIKTOK_PAGE_PREFIXES[i] + '/') === 0) return 'page';
      }
      return null;
    }

    // Brand token prepended to every saved filename so files downloaded from this
    // site carry the DownTik name.
    var FILENAME_BRAND = 'downtik_';

    function getFilenamePrefix(cleanUrl) {
      if (isDouyinUrl(cleanUrl)) return 'douyin_';
      if (isFacebookUrl(cleanUrl)) return 'facebook_';
      if (isInstagramUrl(cleanUrl)) return 'instagram_';
      if (isPinterestUrl(cleanUrl)) return 'pinterest_';
      if (isXiaohongshuUrl(cleanUrl)) return 'xiaohongshu_';
      return 'tiktok_';
    }

    /**
     * Short, filesystem-safe id segment for a download filename.
     *
     * The last path segment isn't always the content id: Douyin jingxuan/search
     * links carry it in a `modal_id` query param while the path tail is
     * URL-encoded hashtag text, which yields an enormous garbled filename. Prefer
     * a known id param, fall back to the path tail, then decode, strip and cap.
     */
    function filenameId(cleanUrl) {
      var raw = '';
      try {
        var parsed = new URL(cleanUrl);
        raw = parsed.searchParams.get('modal_id') ||
          parsed.searchParams.get('aweme_id') ||
          parsed.pathname.split('/').filter(Boolean).pop() ||
          '';
      } catch (e) {
        raw = cleanUrl.split('?')[0].split('/').filter(Boolean).pop() || '';
      }
      try {
        raw = decodeURIComponent(raw);
      } catch (e) {
        // leave raw as-is on malformed percent-escapes
      }
      var safe = raw
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
      return safe || 'video';
    }

    function buildFilename(cleanUrl, ext) {
      return FILENAME_BRAND + getFilenamePrefix(cleanUrl) + filenameId(cleanUrl) + '.' + ext;
    }

    /**
     * One id per logical download, shared by every stall-retry leg of it. Lets the
     * backend collapse "stalled leg + resumed leg" into a single row rather than
     * counting a client_abort plus a finished. Required now that fetchAndSave
     * retries — see stats.query_downloads_summary in the backend.
     */
    function makeDlId() {
      try {
        return crypto.randomUUID();
      } catch (e) {
        // randomUUID needs a secure context; fall back on http/non-localhost.
        return 'dl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      }
    }

    function buildDownloadUrl(qualityKey, chosen) {
      var cleanUrl = downloadUiState.url;
      var source = downloadUiState.source;
      var ext = chosen.ext || 'mp4';
      var filename = buildFilename(cleanUrl, ext);
      if (qualityKey !== 'best' && qualityKey !== 'audio' && qualityKey.indexOf('p') !== -1) {
        filename = filename.replace(/\.[^.]+$/, '_' + qualityKey + '.$&'.slice(1));
      }
      var dlId = makeDlId();

      // Non-best video quality: always re-encode server-side via ffmpeg
      if (qualityKey !== 'best' && qualityKey !== 'audio' && qualityKey.indexOf('p') !== -1) {
        var qParams = new URLSearchParams({
          source: 'scrape',
          cdn_url: chosen.cdn_url,
          quality: qualityKey,
          filename: filename,
          dl_id: dlId,
          platform_hint: isDouyinUrl(cleanUrl) ? 'douyin' : 'tiktok'
        });
        if (chosen.cookies) qParams.set('cookies', chosen.cookies);
        if (chosen.cdn_headers) qParams.set('cdn_headers', chosen.cdn_headers);
        return { url: dlBase + '/download?' + qParams.toString(), filename: filename };
      }

      if (
        (source === 'tikwm' ||
          source === 'fb' ||
          source === 'ig' ||
          source === 'xhs' ||
          source === 'pinterest_image') &&
        qualityKey === 'best'
      ) {
        return {
          url: chosen.cdn_url,
          filename: filename,
          telemetry: directCdnTelemetry(cleanUrl, source)
        };
      }

      if (source === 'tikwm' || (source === 'hybrid' && !isDouyinUrl(cleanUrl))) {
        var scrapeParams = new URLSearchParams({
          source: 'scrape',
          cdn_url: chosen.cdn_url,
          filename: filename,
          format: ext,
          dl_id: dlId,
          platform_hint: 'tiktok'
        });
        if (chosen.cookies) scrapeParams.set('cookies', chosen.cookies);
        if (chosen.cdn_headers) scrapeParams.set('cdn_headers', chosen.cdn_headers);
        return { url: dlBase + '/download?' + scrapeParams.toString(), filename: filename };
      }

      if (source === 'hybrid') {
        var encoded = btoa(chosen.cdn_url).replace(/\+/g, '-').replace(/\//g, '_');
        var fallbackParams = new URLSearchParams({
          source: 'scrape',
          cdn_url: chosen.cdn_url,
          filename: filename,
          format: ext,
          dl_id: dlId,
          platform_hint: 'douyin'
        });
        if (chosen.cdn_headers) fallbackParams.set('cdn_headers', chosen.cdn_headers);
        return {
          url: dlBase + '/douyin/redirect?u=' + encoded,
          filename: filename,
          fallbackUrl: dlBase + '/download?' + fallbackParams.toString(),
          // The redirect streams CDN bytes straight to the browser, so the server
          // never sees them — beacon it like any other direct-CDN path. Only the
          // proxied fallbackUrl is server-recorded, and triggerDownload falls
          // silent once it drops to that.
          telemetry: { platform: 'douyin', source: 'douyin_redirect' }
        };
      }

      if (source === 'yt-dlp') {
        var ytParams = new URLSearchParams({
          source: 'yt-dlp',
          url: cleanUrl,
          quality: qualityKey,
          filename: filename,
          dl_id: dlId
        });
        if (chosen.filesize) ytParams.set('filesize', chosen.filesize);
        return { url: dlBase + '/download?' + ytParams.toString(), filename: filename };
      }

      if (source === 'pinterest_hls') {
        var hlsParams = new URLSearchParams({
          source: 'pinterest_hls',
          cdn_url: chosen.cdn_url,
          filename: filename,
          dl_id: dlId
        });
        if (chosen.audio_url) hlsParams.set('audio_url', chosen.audio_url);
        if (chosen.filesize) hlsParams.set('filesize', chosen.filesize);
        return { url: dlBase + '/download?' + hlsParams.toString(), filename: filename };
      }

      // Default: the scrape proxy. scrape is shared between TikTok and Douyin, so
      // name the platform outright instead of letting the server guess it from the
      // CDN hostname.
      var scrapeParams = new URLSearchParams({
        source: 'scrape',
        cdn_url: chosen.cdn_url,
        filename: filename,
        format: ext,
        dl_id: dlId,
        platform_hint: isDouyinUrl(cleanUrl) ? 'douyin' : 'tiktok'
      });
      if (chosen.cookies) scrapeParams.set('cookies', chosen.cookies);
      if (chosen.cdn_headers) scrapeParams.set('cdn_headers', chosen.cdn_headers);
      return { url: dlBase + '/download?' + scrapeParams.toString(), filename: filename };
    }

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function setStatus(msg, type, key) {
      if (!dlStatus) return;
      downloadUiState.statusText = msg || '';
      downloadUiState.statusType = type || 'idle';
      downloadUiState.statusKey = key || '';
      if (!msg) {
        dlStatus.textContent = '';
        dlStatus.setAttribute('hidden', '');
        dlStatus.className = 'dl-status idle';
        return;
      }
      dlStatus.removeAttribute('hidden');
      dlStatus.className = 'dl-status ' + (type || 'idle');
      dlStatus.textContent = msg;
    }

    function setStatusByKey(key, type) {
      setStatus(key ? td(key) : '', type, key);
    }

    // downloadBtn is an <a> with role=button, so `disabled` is not available:
    // .is-loading is what actually blocks a second tap, via pointer-events:none in
    // the stylesheet plus the keyboard guard in the click handler.
    function setDownloadButtonLoading(loading) {
      if (!downloadBtn) return;
      var label = downloadBtn.querySelector('span');
      downloadBtn.setAttribute('aria-disabled', loading ? 'true' : 'false');
      if (loading) {
        downloadBtn.classList.add('is-loading');
        if (label) label.dataset.originalHtml = label.innerHTML;
      } else {
        downloadBtn.classList.remove('is-loading');
      }
    }

    function resetDownloadButtonLabel() {
      if (!downloadBtn) return;
      var label = downloadBtn.querySelector('span');
      if (label && label.dataset.originalHtml) label.innerHTML = label.dataset.originalHtml;
    }

    function setPrimaryButtonProgress(text) {
      if (!downloadBtn) return;
      var label = downloadBtn.querySelector('span');
      if (label) label.textContent = text;
    }

    function setPhoneBackground(url) {
      var phoneBg = document.querySelector('.phone .vid-bg');
      if (!phoneBg) return;
      phoneBg.style.backgroundImage = url ? 'url("' + url + '")' : '';
    }

    function clearResults() {
      downloadUiState.qualities = {};
      downloadUiState.images = [];
      downloadUiState.previewData = null;
      setPhoneBackground('');
      if (dlResultCard) {
        dlResultCard.setAttribute('hidden', '');
      }
      if (dlPreview) {
        dlPreview.innerHTML = '';
      }
      if (dlActions) {
        dlActions.innerHTML = '';
      }
      if (dlImageGrid) {
        dlImageGrid.innerHTML = '';
        dlImageGrid.setAttribute('hidden', '');
      }
    }

    function renderPreview(data) {
      if (!dlPreview) return;
      downloadUiState.previewData = data;
      var imgs = Array.isArray(data.images) ? data.images : [];
      var thumb = (imgs.length ? imgs[0] : data.thumbnail) || '';
      var author = data.author ? '<div class="dl-preview__author">' + escHtml(data.author) + '</div>' : '';
      var desc = data.description ? '<div class="dl-preview__desc">' + escHtml(data.description) + '</div>' : '';
      var views = Number(data.view_count || 0).toLocaleString();
      var sub = escHtml((data.duration || 0) + 's · ' + views + ' ' + td('views'));
      var thumbHtml = thumb
        ? '<div class="dl-preview__thumb-wrap"><img class="dl-preview__thumb" src="' + escHtml(thumb) + '" alt="' + escHtml(td('videoThumbnail')) + '" loading="lazy"><div class="dl-preview__play">&#9654;</div></div>'
        : '';
      dlPreview.innerHTML = thumbHtml +
        '<div class="dl-preview__meta">' + author + desc + '<div class="dl-preview__sub">' + sub + '</div></div>';
      if (dlResultCard) dlResultCard.removeAttribute('hidden');
      setPhoneBackground(thumb);
    }

    // Action controls are <a> elements, not <button>s (see makeActionElement), so
    // `disabled` is not available — the class is what actually blocks a second tap,
    // via pointer-events:none in ensureActionStyles plus the guard in the click
    // handler for keyboard activation.
    function setActionButtonState(button, active, pct, restoreText) {
      if (!button) return;
      button.classList.toggle('is-busy', !!active);
      button.setAttribute('aria-disabled', active ? 'true' : 'false');
      if (active) {
        button.textContent = pct != null ? td('downloading') + ' ' + pct + '%' : td('downloading') + '...';
      } else {
        button.textContent = restoreText;
      }
    }

    function triggerFileDownload(blob, filename) {
      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
    }

    /** No bytes for this long ⇒ the connection is treated as stalled and aborted. */
    var STALL_MS = 20000;
    /** Total stream attempts (1 initial + up to 4 resumes/restarts). */
    var MAX_ATTEMPTS = 5;
    /** Delay before each retry, indexed by (attempt - 1); the last value repeats. */
    var BACKOFF_MS = [500, 1000, 2000, 4000];

    function delay(ms) {
      return ms > 0 ? new Promise(function (resolve) { setTimeout(resolve, ms); }) : Promise.resolve();
    }

    /** A stall abort or a network drop — both are safe to retry. A non-2xx response
     *  is not retryable and runAttempt throws on it instead. */
    function isRetryable(err) {
      return err instanceof TypeError || (!!err && err.name === 'AbortError');
    }

    /**
     * Stream a URL to disk with progress, surviving an unstable connection.
     *
     * A watchdog aborts the request when no bytes arrive for STALL_MS, then the
     * download is retried — resuming from the byte offset already received via an
     * HTTP Range request when the source is seekable, or restarting cleanly when it
     * isn't (yt-dlp / pinterest_hls streams advertise no accept-ranges). Resuming is
     * silent: progress simply pauses and continues.
     *
     * Throws immediately on a non-2xx response, so the Douyin redirect→proxy
     * fallback still fires fast, and throws after maxAttempts stalls or drops.
     *
     * Resolves with the saved byte count so callers can report bytes_sent. onBytes
     * fires on every chunk with the running total, which keeps a pagehide
     * client_abort report accurate.
     */
    async function fetchAndSave(targetUrl, filename, onProgress, onBytes) {
      var chunks = [];
      var received = 0;
      var total = null;
      var contentType = 'video/mp4';

      // Read one attempt's stream into the shared accumulator:
      //   'done'       — full file in hand, save it.
      //   'stalled'    — dropped after a response arrived (mid-stream); resume.
      //   'early-fail' — couldn't even get a response. Twice in a row on a resume
      //                  means the endpoint won't serve our Range, so the caller
      //                  discards the partial and restarts cleanly.
      //
      // We always send Range once we hold some bytes and let the response decide:
      // range-capable sources reply 206 (append), the rest reply 200 (restart). It
      // can't be settled up front, because accept-ranges / content-range aren't
      // CORS-exposed on cross-origin CDN responses.
      async function runAttempt(rangeStart) {
        var controller = new AbortController();
        var timer;
        function arm() {
          clearTimeout(timer);
          timer = setTimeout(function () { controller.abort(); }, STALL_MS);
        }
        function disarm() {
          clearTimeout(timer);
        }

        arm();
        var res;
        try {
          var headers = {};
          if (rangeStart > 0) headers.Range = 'bytes=' + rangeStart + '-';
          res = await fetch(targetUrl, { signal: controller.signal, headers: headers });
        } catch (err) {
          disarm();
          if (isRetryable(err)) return 'early-fail';
          throw err;
        }

        if (!res.ok) {
          disarm();
          throw new Error('Server error ' + res.status);
        }

        if (res.status === 200) {
          // Full body: either this is the first attempt, or the server ignored our
          // Range header. Either way, restart accumulation from scratch.
          chunks = [];
          received = 0;
          total = parseInt(res.headers.get('content-length') || res.headers.get('x-expected-size') || '0', 10) || null;
        } else if (res.status === 206 && total == null) {
          // Partial body: recover the full size from the Content-Range total tail.
          var contentRange = res.headers.get('content-range');
          var match = contentRange && contentRange.match(/\/(\d+)\s*$/);
          if (match) total = parseInt(match[1], 10) || null;
        }
        contentType = res.headers.get('content-type') || contentType;

        var reader = res.body.getReader();
        try {
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value) {
              chunks.push(chunk.value);
              received += chunk.value.length;
              arm(); // bytes are flowing — reset the stall watchdog
              if (onBytes) onBytes(received);
              if (total && onProgress) onProgress(Math.round((received / total) * 100));
              // Every advertised byte is in hand — finish without waiting for the
              // stream to close. Avoids a near-100% hang (and a doomed
              // `Range: bytes=<total>-` → 416 retry) when a server delivers the
              // whole body but never signals EOF promptly.
              if (total !== null && received >= total) break;
            }
          }
        } catch (err) {
          disarm();
          // A stall firing once we already hold the whole file is still a success.
          if (total !== null && received >= total) return 'done';
          if (isRetryable(err)) return 'stalled';
          throw err;
        }
        disarm();
        return 'done';
      }

      var earlyFailStreak = 0;
      for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await delay(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
        // Resume from wherever we got to; runAttempt restarts cleanly by itself if
        // the server replies 200 (i.e. ignored the Range).
        var outcome = await runAttempt(received);
        if (outcome === 'done') {
          var blob = new Blob(chunks, { type: contentType });
          triggerFileDownload(blob, filename);
          return { bytes: blob.size };
        }
        // A resume that can't even get a response twice running likely means this
        // endpoint won't serve our Range — throw the partial away and fall back to a
        // clean full download. A single blip is tolerated so a transient hiccup
        // doesn't discard an otherwise good partial.
        if (outcome === 'early-fail' && received > 0 && ++earlyFailStreak >= 2) {
          chunks = [];
          received = 0;
          earlyFailStreak = 0;
        } else if (outcome !== 'early-fail') {
          earlyFailStreak = 0;
        }
      }

      throw new Error('Download stalled after ' + MAX_ATTEMPTS + ' attempts');
    }

    // ----- action controls -----
    // Every download control is a real <a> (with role=button): keeping one element
    // type across every state means nothing is ever removed from the DOM mid-click.
    function ensureActionStyles() {
      if (document.getElementById('downtik-action-styles')) return;
      var style = document.createElement('style');
      style.id = 'downtik-action-styles';
      style.textContent = [
        '.dl-actions a,.image-dl-btn,.download-btn{cursor:pointer;text-decoration:none;}',
        // Stands in for the `disabled` attribute an <a> cannot have.
        '.dl-actions a.is-busy,.image-dl-btn.is-busy{pointer-events:none;opacity:0.65;}'
      ].join('');
      document.head.appendChild(style);
    }

    /**
     * Build one action control as a plain download button (anchor with role=button).
     * Pass `html` to render inner markup (e.g. a label plus a size line).
     */
    function makeActionElement(className, label, onDownload, html) {
      ensureActionStyles();

      var el = document.createElement('a');
      el.className = className;
      if (html) el.innerHTML = html;
      else el.textContent = label;
      // An href-less <a> is neither focusable nor Enter-activatable on its own; these
      // two lines plus the keydown handler below keep the keyboard parity these
      // controls had as <button>s.
      el.setAttribute('role', 'button');
      el.tabIndex = 0;

      el.addEventListener('click', function (event) {
        event.preventDefault();
        // pointer-events:none already blocks taps while busy; this catches keyboard
        // activation, which ignores it.
        if (el.classList.contains('is-busy')) return;
        onDownload(el);
      });

      // Space never activates an <a>, and Enter only does so when it has an href.
      el.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        el.click();
      });

      return el;
    }

    function triggerDownload(qualityKey, button, restoreText) {
      var chosen = downloadUiState.qualities[qualityKey];
      if (!chosen && qualityKey !== 'audio') {
        chosen = downloadUiState.qualities.best;
      }
      if (!chosen) {
        setStatusByKey('noUrlFound', 'error');
        showToast(td('noUrlFound'));
        return;
      }
      var built = buildDownloadUrl(qualityKey, chosen);
      if (!built.url) {
        setStatusByKey('noUrlFound', 'error');
        return;
      }
      setActionButtonState(button, true, null, restoreText);
      setStatusByKey('downloading', 'loading');

      function onProgress(pct) {
        setActionButtonState(button, true, pct, restoreText);
      }

      // Telemetry rides only on direct-CDN paths; proxied /download requests are
      // recorded server-side.
      var kind = qualityKey === 'audio' ? 'audio' : 'video';
      var telemetry = built.telemetry;
      var pending = telemetry ? beginPending(telemetry, kind) : null;
      var onBytes = pending ? function (n) { updatePendingBytes(pending, n); } : null;
      var startedAt = now();

      // Set once we drop to the proxied fallback: the server records that path, so
      // the client has to stay quiet or the download gets counted twice.
      var usedFallback = false;

      fetchAndSave(built.url, built.filename, onProgress, onBytes).catch(function (err) {
        if (!built.fallbackUrl) throw err;
        usedFallback = true;
        endPending(pending);
        return fetchAndSave(built.fallbackUrl, built.filename, onProgress);
      }).then(function (result) {
        if (telemetry && !usedFallback) {
          endPending(pending);
          reportDownload(telemetry, 'finished', {
            kind: kind,
            bytes_sent: result.bytes,
            duration_ms: Math.round(now() - startedAt)
          });
        }
        setStatusByKey('downloadComplete', 'success');
        showToast(td('downloadComplete'));
      }).catch(function (err) {
        if (telemetry && !usedFallback) {
          endPending(pending);
          reportDownload(telemetry, 'error', {
            kind: kind,
            duration_ms: Math.round(now() - startedAt),
            error: String((err && err.message) || err).slice(0, 200)
          });
        }
        setStatus(err.message || td('extractionFailed'), 'error');
      }).finally(function () {
        endPending(pending);
        setActionButtonState(button, false, null, restoreText);
      });
    }

    function downloadImage(src, index, button) {
      var cleanUrl = downloadUiState.url;
      var filename = FILENAME_BRAND + getFilenamePrefix(cleanUrl) + filenameId(cleanUrl) + '-' + (index + 1) + '.jpeg';
      setActionButtonState(button, true, null, td('downloadImage'));

      var telemetry = directCdnTelemetry(cleanUrl, downloadUiState.source);
      var pending = telemetry ? beginPending(telemetry, 'image') : null;
      var startedAt = now();

      // cache: 'no-store' bypasses the opaque cache entry the <img> tag leaves
      // behind — it loads without crossOrigin, so the cached response carries no
      // CORS headers, and a CORS-mode fetch can't read an opaque response. Without
      // this, downloading an image fails once its thumbnail has rendered.
      fetch(src, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('Server error ' + res.status);
        return res.blob();
      }).then(function (blob) {
        triggerFileDownload(blob, filename);
        if (telemetry) {
          endPending(pending);
          reportDownload(telemetry, 'finished', {
            kind: 'image',
            bytes_sent: blob.size,
            duration_ms: Math.round(now() - startedAt)
          });
        }
        setStatusByKey('downloadComplete', 'success');
      }).catch(function (err) {
        if (telemetry) {
          endPending(pending);
          reportDownload(telemetry, 'error', {
            kind: 'image',
            duration_ms: Math.round(now() - startedAt),
            error: String((err && err.message) || err).slice(0, 200)
          });
        }
        setStatus(err.message || td('extractionFailed'), 'error');
      }).finally(function () {
        endPending(pending);
        setActionButtonState(button, false, null, td('downloadImage'));
      });
    }

    function formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    function renderDownloadButtons() {
      if (!dlActions) return;
      dlActions.innerHTML = '';

      var best = downloadUiState.qualities.best;
      var audio = downloadUiState.qualities.audio;
      if (!best && !audio) return;

      var srcH = best && best.height || 0;
      var srcSize = best && best.filesize || 0;

      // Original quality button (blue)
      if (best) {
        var origBtn = makeActionElement('dl-video-btn', '\u2193 ' + td('downloadVideo') + ' (No Watermark)', function (el) {
          triggerDownload('best', el, '\u2193 ' + td('downloadVideo') + ' (No Watermark)');
        });
        dlActions.appendChild(origBtn);
      }

      // HD button with ad (orange) - only if source is tall enough for HD
      if (best && srcH >= 720) {
        var hdBtn = document.createElement('a');
        hdBtn.className = 'dl-hd-btn';
        hdBtn.setAttribute('role', 'button');
        hdBtn.tabIndex = 0;
        hdBtn.innerHTML = '\u2193 ' + td('downloadVideo') + ' HD (No Watermark) <span class="dl-hd-badge">HD</span><span class="dl-hd-ad-label">\u{1F4F7} Watch Ad</span>';
        var hdLabel = '\u2193 ' + td('downloadVideo') + ' HD (No Watermark)';
        hdBtn.addEventListener('click', function (e) {
          e.preventDefault();
          if (hdBtn.classList.contains('is-busy')) return;
          showAdOverlay(function () {
            triggerDownload('720p', hdBtn, hdLabel);
          });
        });
        hdBtn.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          hdBtn.click();
        });
        dlActions.appendChild(hdBtn);
      }

      // Audio button
      if (audio) {
        var audioBtn = makeActionElement('dl-audio-btn', td('downloadAudio') + ' (MP3)', function (el) {
          triggerDownload('audio', el, td('downloadAudio') + ' (MP3)');
        });
        dlActions.appendChild(audioBtn);
      }

      dlActions.removeAttribute('hidden');
    }

    // ----- ad overlay -----
    var AD_DURATION_MS = 8000;
    var adOverlayEl = null;

    function ensureAdOverlay() {
      if (adOverlayEl) return adOverlayEl;
      var overlay = document.createElement('div');
      overlay.className = 'dl-ad-overlay';
      overlay.hidden = true;
      overlay.innerHTML =
        '<div class="dl-ad-box">' +
          '<div class="dl-ad-progress-wrap">' +
            '<div class="dl-ad-progress-bar"><div class="dl-ad-progress-fill"></div></div>' +
            '<span class="dl-ad-progress-text">Preparing your download... 0%</span>' +
          '</div>' +
          '<div class="dl-ad-image-wrap">' +
            '<div class="dl-ad-label">Advertisement</div>' +
            '<div class="dl-ad-image" id="dlAdImage"></div>' +
          '</div>' +
          '<div class="dl-ad-skip" id="dlAdSkip" hidden><a href="#">Skip \u2192</a></div>' +
        '</div>';
      dlActions.parentNode.insertBefore(overlay, dlActions.nextSibling);
      adOverlayEl = overlay;
      return overlay;
    }

    function showAdOverlay(onComplete) {
      var overlay = ensureAdOverlay();
      var fill = overlay.querySelector('.dl-ad-progress-fill');
      var text = overlay.querySelector('.dl-ad-progress-text');
      var adImg = overlay.querySelector('.dl-ad-image');
      var skipBtn = overlay.querySelector('#dlAdSkip');

      // Set ad image
      if (adImg) {
        adImg.innerHTML = '<div class="dl-ad-placeholder">Your ad here</div>';
      }

      overlay.hidden = false;
      fill.style.width = '0%';
      text.textContent = 'Preparing your download... 0%';
      if (skipBtn) skipBtn.hidden = true;

      var startTime = Date.now();
      var timer = setInterval(function () {
        var elapsed = Date.now() - startTime;
        var pct = Math.min(100, Math.round((elapsed / AD_DURATION_MS) * 100));
        fill.style.width = pct + '%';
        text.textContent = 'Preparing your download... ' + pct + '%';
        if (pct >= 100) {
          clearInterval(timer);
          if (skipBtn) skipBtn.hidden = false;
        }
      }, 100);

      // Skip button
      if (skipBtn) {
        skipBtn.onclick = function (e) {
          e.preventDefault();
          clearInterval(timer);
          hideAdOverlay();
          if (onComplete) onComplete();
        };
      }

      // Auto-complete after duration
      setTimeout(function () {
        clearInterval(timer);
        hideAdOverlay();
        if (onComplete) onComplete();
      }, AD_DURATION_MS);
    }

    function hideAdOverlay() {
      if (adOverlayEl) adOverlayEl.hidden = true;
    }

    function renderImageGrid() {
      if (!dlImageGrid) return;
      dlImageGrid.innerHTML = '';

      if (!downloadUiState.images.length) {
        dlImageGrid.setAttribute('hidden', '');
        return;
      }

      downloadUiState.images.forEach(function (src, index) {
        var card = document.createElement('div');
        card.className = 'image-card';
        var img = document.createElement('img');
        img.src = src;
        img.alt = 'Slide ' + (index + 1);
        img.loading = 'lazy';
        var button = makeActionElement('image-dl-btn', td('downloadImage'), function (el) {
          downloadImage(src, index, el);
        });
        card.appendChild(img);
        card.appendChild(button);
        dlImageGrid.appendChild(card);
      });

      dlImageGrid.removeAttribute('hidden');
    }

    // A backend 400 body carries a stable machine `code` (see tiktok_dl
    // main.py). Map it to a dl-dict key so the UI shows localized copy rather than
    // the backend's raw `detail`. Unknown/absent code → the generic invalid-link
    // hint.
    var BACKEND_ERROR_KEYS = {
      invalid_url: 'invalidLink',
      nonvideo_profile: 'nonVideoProfile',
      nonvideo_live: 'nonVideoLive',
      nonvideo_page: 'nonVideoPage'
    };
    function backendErrorKey(payload) {
      var code = payload && payload.code;
      return (code && BACKEND_ERROR_KEYS[code]) || 'invalidLink';
    }

    function fetchInfo() {
      var cleanUrl = extractUrl(urlInput.value);
      if (!cleanUrl) {
        setStatusByKey('pleaseEnterUrl', 'error');
        showToast(t('toast.empty'));
        urlInput.focus();
        return;
      }

      // Profile/livestream/section links can never be a video — tell the user
      // what to paste instead of burning a request that's guaranteed to 400.
      var nonVideoKind = tiktokNonVideoKind(cleanUrl);
      if (nonVideoKind) {
        var nonVideoKey = nonVideoKind === 'profile' ? 'nonVideoProfile'
          : nonVideoKind === 'live' ? 'nonVideoLive' : 'nonVideoPage';
        setStatusByKey(nonVideoKey, 'error');
        showToast(td(nonVideoKey));
        urlInput.focus();
        return;
      }

      var endpoint = isDouyinUrl(cleanUrl) ? '/douyin/info'
        : isFacebookUrl(cleanUrl) ? '/fb/info'
          : isInstagramUrl(cleanUrl) ? '/ig/info'
            : isPinterestUrl(cleanUrl) ? '/pinterest/info'
              : isXiaohongshuUrl(cleanUrl) ? '/xiaohongshu/info'
                : '/info';

      downloadUiState.url = cleanUrl;
      urlInput.value = cleanUrl;
      clearResults();
      setStatusByKey('fetchingInfo', 'loading');
      setDownloadButtonLoading(true);
      setPrimaryButtonProgress(td('fetchingInfo'));

      fetch(apiBase + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      }).then(function (res) {
        if (!res.ok) {
          // 400 = input problem → localized hint keyed by the backend's machine
          // `code`. Parse the body to read the code; non-400s stay a generic
          // server error.
          return res.json().catch(function () { return null; }).then(function (payload) {
            var key = res.status === 400 ? backendErrorKey(payload) : null;
            var httpErr = new Error(key ? td(key) : 'Server error ' + res.status);
            if (key) httpErr.statusKey = key;
            throw httpErr;
          });
        }
        return res.json();
      }).then(function (data) {
        if (!data) throw new Error(td('extractionFailed'));
        downloadUiState.source = data.source || 'scrape';
        downloadUiState.qualities = data.qualities || {};
        downloadUiState.images = Array.isArray(data.images) ? data.images : [];

        renderPreview(data);
        renderDownloadButtons();
        renderImageGrid();
        setStatusByKey('downloadReady', 'success');
        showToast(td('downloadReady'));
      }).catch(function (err) {
        setStatusByKey(err.statusKey || 'extractionFailed', 'error');
        showToast(err.message || td('extractionFailed'));
      }).finally(function () {
        setDownloadButtonLoading(false);
        resetDownloadButtonLabel();
      });
    }

    if (urlInput) {
      urlInput.addEventListener('focus', function () { downloader.classList.add('is-focus'); });
      urlInput.addEventListener('blur', function () { downloader.classList.remove('is-focus'); });
      urlInput.addEventListener('paste', function (e) {
        var text = e.clipboardData.getData('text');
        var clean = extractUrl(text);
        if (clean && clean !== text) {
          e.preventDefault();
          urlInput.value = clean;
        }
        setTimeout(function () { showToast(t('toast.ready')); }, 50);
      });
      // Every path that starts a fetch goes through downloadBtn.click() rather than
      // calling fetchInfo() directly, so Enter on the field behaves exactly like a tap
      // on the button.
      urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (downloadBtn) downloadBtn.click();
          else fetchInfo();
        }
      });
    }

    if (pasteBtn) {
      pasteBtn.addEventListener('click', async function () {
        try {
          var txt = await navigator.clipboard.readText();
          urlInput.value = extractUrl(txt);
          // Deliberately no focus(): a pasted URL rarely needs editing, and focusing
          // pops the iOS keyboard over the Download button, forcing a dismiss. The
          // user's next tap is Download; they can still tap the field to edit.
          showToast(t('toast.pasted'));
        } catch (e) {
          // Clipboard read denied — fall back to manual long-press-paste, which needs
          // the field focused with the keyboard up.
          urlInput.focus();
          showToast(t('toast.manual'));
        }
      });
    }

    if (downloadBtn) {
      ensureActionStyles();

      downloadBtn.addEventListener('click', function (event) {
        event.preventDefault();
        // .is-loading blocks taps via pointer-events:none; this catches keyboard
        // activation, which ignores it.
        if (downloadBtn.classList.contains('is-loading')) return;
        fetchInfo();
      });

      // Keyboard parity for the href-less <a>: Space never activates it natively,
      // and Enter only does when it has an href.
      downloadBtn.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        downloadBtn.click();
      });
    }

    document.querySelectorAll('[data-share-copy]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var shareUrl = button.getAttribute('data-share-copy') || window.location.href;
        try {
          await navigator.clipboard.writeText(shareUrl);
          showToast('Copied share link');
        } catch (e) {
          showToast('Copy failed');
        }
      });
    });

    document.querySelectorAll('[data-share-native]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var shareData = {
          title: button.getAttribute('data-share-title') || document.title,
          url: button.getAttribute('data-share-url') || window.location.href
        };

        if (navigator.share) {
          try {
            await navigator.share(shareData);
          } catch (e) {}
          return;
        }

        try {
          await navigator.clipboard.writeText(shareData.url);
          showToast('Copied share link');
        } catch (e) {
          window.open(shareData.url, '_blank', 'noopener');
        }
      });
    });

    setStatus('', 'idle');

    // ----- faq -----
    document.querySelectorAll('.faq-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var open = item.getAttribute('aria-expanded') === 'true';
        item.setAttribute('aria-expanded', !open);
      });
    });

    // ----- steps -----
    var steps = document.querySelectorAll('.step');
    var illusts = document.querySelectorAll('.step-illust');
    function activate(n) {
      steps.forEach(function (s) { s.classList.toggle('is-active', s.dataset.step === n); });
      illusts.forEach(function (i) { i.classList.toggle('is-active', i.dataset.illust === n); });
    }
    steps.forEach(function (s) {
      s.addEventListener('mouseenter', function () { activate(s.dataset.step); });
      s.addEventListener('click', function () { activate(s.dataset.step); });
    });
    if (steps.length) {
      var stepN = 1;
      var stepTimer = null;
      function startStepCycle() {
        if (stepTimer) return;
        stepTimer = setInterval(function () {
          stepN = stepN >= 3 ? 1 : stepN + 1;
          activate(String(stepN));
        }, 3500);
      }
      function stopStepCycle() {
        if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
      }
      startStepCycle();
      // Don't keep the carousel ticking in a hidden/backgrounded/bfcached tab — it
      // forces style recalcs the whole time the user is away, which Safari then has
      // to replay when the tab is restored. Pause on the way out, resume on the way
      // back. visibilitychange is the reliable mobile-Safari signal;
      // pageshow/pagehide also cover bfcache, freeze/resume cover Chrome.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') stopStepCycle();
        else startStepCycle();
      });
      window.addEventListener('pagehide', stopStepCycle);
      window.addEventListener('pageshow', startStepCycle);
      document.addEventListener('freeze', stopStepCycle);
      document.addEventListener('resume', startStepCycle);
    }

    // ----- reveal on scroll -----
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('in'); });
    }, { threshold: 0.12 });
    document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });

    // ----- subtle parallax phone -----
    var phone = document.querySelector('.phone');
    var stage = document.querySelector('.phone-stage');
    if (stage && phone) {
      stage.addEventListener('mousemove', function (e) {
        var r = e.currentTarget.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        phone.style.transform = 'rotate(' + (-6 + x * 4) + 'deg) rotateY(' + (8 + x * 8) + 'deg) rotateX(' + (-y * 5) + 'deg)';
      });
      stage.addEventListener('mouseleave', function () { phone.style.transform = ''; });
    }
  });
})();
