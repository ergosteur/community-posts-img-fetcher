// --- Utilities ----------------------------------------------------------
const $ = sel => document.querySelector(sel);
const postInput = $('#postInput');
const goBtn = $('#goBtn');
const saveAllBtn = $('#saveAllBtn');
const statusEl = $('#status');
const useProxy = $('#useProxy');
const proxyUrl = $('#proxyUrl');
const metaCard = $('#meta');
const chanPill = $('#chanPill');
const datePill = $('#datePill');
const postPill = $('#postPill');
const textSnippet = $('#textSnippet');
const results = $('#results');

const SIZE_PARAM_RE = /(=s\d+|=w\d+(?:-h\d+)?(?:-no)?(?:-c[-\w\d]+)?)(?:-.*)?$/;

function normalizeInputToUrl(s) {
  s = s.trim();
  if (!s) return "";
  if (s.startsWith('http')) return s;
  return `https://www.youtube.com/post/${s}`;
}

function toS0(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (u.endsWith('=s0')) return u;
    if (SIZE_PARAM_RE.test(u)) return u.replace(SIZE_PARAM_RE, '=s0');
    if (host.includes('yt3.ggpht.com') || host.includes('googleusercontent.com') || host.includes('ggpht.com')) {
      if (u.includes('?') || u.endsWith('=')) return u + 's0';
      return u + '=s0';
    }
  } catch { }
  return u;
}

function sanitizeFilename(name) {
  return (name || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function textish(d) {
  if (!d || typeof d !== 'object') return null;
  if (typeof d.simpleText === 'string') return d.simpleText.trim() || null;
  if (Array.isArray(d.runs)) {
    const parts = d.runs.map(r => (r && r.text) ? r.text : '').join('');
    return parts.trim() || null;
  }
  return null;
}

function parseDateLabelToISOorRaw(label) {
  const raw = (label || '').trim();
  const tryParse = fmts => {
    for (const fmt of fmts) {
      // super-lightweight parser for patterns we expect; fallback returns null
      const m = raw.match(/([A-Za-z]+) (\d{1,2}), (\d{4})/);
      if (m) {
        const [_, monStr, dStr, yStr] = m;
        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const mIdx = months.findIndex(x => x.toLowerCase().startsWith(monStr.toLowerCase()));
        if (mIdx >= 0) {
          const mm = String(mIdx + 1).padStart(2, '0');
          const dd = String(+dStr).padStart(2, '0');
          return [`${yStr}-${mm}-${dd}`, raw];
        }
      }
    }
    return [null, raw || null];
  };
  return tryParse(['dummy']);
}

function walk(obj, fn) {
  if (Array.isArray(obj)) {
    obj.forEach(v => walk(v, fn));
  } else if (obj && typeof obj === 'object') {
    fn(obj);
    Object.values(obj).forEach(v => walk(v, fn));
  }
}

function extractInitialData(html) {
  const patterns = [
    /var ytInitialData = (\{.*?\});<\/script>/s,
    /window\[['"]ytInitialData['"]]\s*=\s*(\{.*?\});/s,
    /ytInitialData\s*=\s*(\{.*?\});/s
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      try { return JSON.parse(m[1].trim().replace(/;$/, '')); } catch { }
    }
  }
  throw new Error('ytInitialData not found');
}

function findBackstageImages(ytdata) {
  const out = [];
  walk(ytdata, node => {
    if (node && node.backstageImageRenderer && node.backstageImageRenderer.image?.thumbnails) {
      out.push(node.backstageImageRenderer.image);
    }
  });
  return out;
}

function extractChannelFromTitle(html) {
  const m = html.match(/<title>(.*?)<\/title>/si);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  const seg = t.split(/\s[-|]\s/)[0];
  if (seg && seg.toLowerCase() !== 'youtube') return seg;
  return t || null;
}

function extractPostMeta(ytdata, html) {
  const meta = { postId: null, channel: null, channelId: null, date_iso: null, date_raw: null, text: null, src_channel: null, src_date: null };
  walk(ytdata, node => {
    const post = node.backstagePostRenderer;
    if (!post) return;
    meta.postId ||= post.postId || null;
    meta.text ||= textish(post.contentText) || null;

    const ch = textish(post.authorText);
    if (ch && !meta.channel) { meta.channel = ch; meta.src_channel = 'authorText'; }

    const bid = post.authorEndpoint?.browseEndpoint?.browseId;
    if (bid && !meta.channelId) meta.channelId = bid;

    const ptt = post.publishedTimeText || {};
    const accLabel = ptt?.accessibility?.accessibilityData?.label;
    if (!meta.date_iso && accLabel) {
      const [iso, raw] = parseDateLabelToISOorRaw(accLabel);
      meta.date_iso = iso; meta.date_raw = raw; meta.src_date = 'accessibility';
    }
    if (!meta.date_iso && !meta.date_raw) {
      const ti = textish(ptt);
      if (ti) { const [iso, raw] = parseDateLabelToISOorRaw(ti); meta.date_iso = iso; meta.date_raw = raw; meta.src_date = 'textish'; }
    }
  });

  if (!meta.channel) {
    const t = extractChannelFromTitle(html);
    if (t) { meta.channel = t; meta.src_channel = 'html-title'; }
  }
  if (!meta.date_iso && !meta.date_raw) { meta.date_raw = 'unknown-date'; meta.src_date = 'fallback'; }
  return meta;
}

function largestThumbUrl(thumbnails = []) {
  const sorted = [...thumbnails].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const url = sorted[0]?.url;
  return url ? toS0(url) : null;
}

function renderMeta(meta) {
  metaCard.hidden = false;
  chanPill.textContent = meta.channel ? `Channel: ${meta.channel}` : 'Channel: (unknown)';
  datePill.textContent = `Date: ${meta.date_iso || meta.date_raw || 'unknown'}`;
  postPill.textContent = `Post: ${meta.postId || '(unknown)'}`;
  textSnippet.textContent = meta.text ? `“${meta.text}”` : '';
}

function setStatus(msg, cls = '') {
  statusEl.className = 'hint ' + (cls || '');
  statusEl.textContent = msg;
}

async function fetchHtml(url) {
  const viaProxy = useProxy.checked;
  if (viaProxy) {
    const p = proxyUrl.value;
    if (!p) throw new Error('Proxy URL is empty.');
    return await (await fetch(p + encodeURIComponent(url))).text();
  }
  // Direct fetch will usually fail due to CORS unless you run this as a browser extension / have permissive headers.
  return await (await fetch(url, { mode: 'cors' })).text();
}

function buildFilenamePrefix(meta) {
  const channel = sanitizeFilename(meta.channel || 'channel');
  const datePiece = sanitizeFilename(meta.date_iso || meta.date_raw || 'unknown-date');
  const postId = sanitizeFilename(meta.postId || 'post');
  return `${channel}_${datePiece}_${postId}`;
}

function cardFor(url, fnameBase, idx) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.innerHTML = `
        <img loading="lazy" src="${url}" alt="img ${idx}">
        <div class="meta">
          <div class="small">${fnameBase}_img${String(idx).padStart(2, '0')}</div>
          <div class="row" style="margin-top:6px">
            <a href="${url}" download class="pill">Download</a>
            <a href="${url}" target="_blank" rel="noreferrer" class="pill">Open</a>
          </div>
        </div>`;
  return el;
}

async function handleFetch() {
  results.innerHTML = '';
  metaCard.hidden = true;
  const input = normalizeInputToUrl(postInput.value);
  if (!input) return setStatus('Enter a URL or post ID.', 'warn');

  setStatus('Fetching post HTML…');
  let html;
  try {
    html = await fetchHtml(input);
  } catch (e) {
    console.error(e);
    return setStatus(`Fetch failed: ${e.message}`, 'err');
  }

  let data;
  try {
    data = extractInitialData(html);
  } catch (e) {
    console.error(e);
    return setStatus('Could not locate ytInitialData in the page.', 'err');
  }

  const meta = extractPostMeta(data, html);
  renderMeta(meta);

  const imgs = findBackstageImages(data);
  if (!imgs.length) return setStatus('No images found in this post.', 'warn');

  const prefix = buildFilenamePrefix(meta);
  const hires = imgs.map(b => largestThumbUrl(b.thumbnails)).filter(Boolean);

  results.innerHTML = '';
  hires.forEach((u, i) => results.appendChild(cardFor(u, prefix, i + 1)));
  setStatus(`Found ${hires.length} image(s).`, 'ok');

  // Hook up "Download All"
  saveAllBtn.onclick = async () => {
    if (!hires.length) return;
    try {
      // Try File System Access API for a nicer UX (Chromium/Edge/Android)
      if ('showDirectoryPicker' in window) {
        const dir = await window.showDirectoryPicker({ id: 'yt-community-images' });
        await Promise.all(hires.map(async (u, i) => {
          const idx = String(i + 1).padStart(2, '0');
          const ext = (new URL(u).pathname.split('.').pop() || 'jpg').split('?')[0].slice(0, 5);
          const fname = `${prefix}_img${idx}.${/^[A-Za-z0-9]{1,5}$/.test(ext) ? ext : 'jpg'}`;
          const f = await dir.getFileHandle(fname, { create: true });
          const w = await f.createWritable();
          const res = await fetch(u);
          await w.write(await res.blob());
          await w.close();
        }));
      } else {
        // Fallback: open all in new tabs; user can save (robust cross-browser fallback)
        hires.forEach(u => window.open(u, '_blank'));
      }
    } catch (e) {
      console.error(e);
      setStatus(`Download-all failed: ${e.message}`, 'err');
    }
  };
}

goBtn.onclick = handleFetch;
postInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleFetch(); });

// PWA registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}