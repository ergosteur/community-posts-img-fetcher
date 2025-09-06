// --- Utilities ----------------------------------------------------------
const $ = sel => document.querySelector(sel);
const postInput = $('#postInput');
const goBtn = $('#goBtn');
const zipBtn = $('#zipBtn');
const openAllBtn = $('#openAllBtn');
const statusEl = $('#status');
const useProxy = $('#useProxy');
const proxyUrl = $('#proxyUrl');
const metaCard = $('#meta');
const chanPill = $('#chanPill');
const datePill = $('#datePill');
const postPill = $('#postPill');
const textSnippet = $('#textSnippet');
const results = $('#results');
const historyBox = $('#history');
const lightbox = $('#lightbox');
const lightImg = document.querySelector('#lightbox img');

const SIZE_PARAM_RE = /(=s\d+|=w\d+(?:-h\d+)?(?:-no)?(?:-c[-\w\d]+)?)(?:-.*)?$/;

let lastImages = [];

function normalizeInputToUrl(s) {
  s = (s || '').trim();
  if (!s) return '';

  // If it's already an URL, try to parse and canonicalize
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();
      // Accept common YouTube hosts
      if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
        // Try to extract /post/{id}
        const m = u.pathname.match(/\/post\/([^/?#]+)/i);
        if (m && m[1]) {
          const postId = m[1];
          return `https://www.youtube.com/post/${postId}`;
        }
      }
    } catch { /* fall through */ }
    // Unknown URL shape — return as-is so proxy can try
    return s;
  }

  // Bare ID heuristic: many community post IDs start with "Ug"
  if (/^Ug[\w-]+$/i.test(s)) {
    return `https://www.youtube.com/post/${s}`;
  }

  // Maybe user pasted something like "youtube.com/post/ID" without scheme
  if (/^(?:www\.|m\.)?youtube\.com\//i.test(s)) {
    try {
      const u = new URL('https://' + s.replace(/^http:\/\//i, ''));
      const m = u.pathname.match(/\/post\/([^/?#]+)/i);
      if (m && m[1]) {
        return `https://www.youtube.com/post/${m[1]}`;
      }
    } catch { /* ignore */ }
  }

  // Default: treat it as an ID and hope for the best
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
  const idxStr = String(idx).padStart(2, '0');
  const ext = (new URL(url).pathname.split('.').pop() || 'jpg').split('?')[0].slice(0, 5);
  const safeExt = /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext : 'jpg';
  const fname = `${fnameBase}_img${idxStr}.${safeExt}`;

  const el = document.createElement('div');
  el.className = 'thumb';
  el.innerHTML = `
        <img loading="lazy" src="${url}" alt="img ${idx}">
        <div class="meta">
          <div class="small">
            ${fname}
            <span class="res" title="Resolution">(…)</span>
          </div>
          <div class="row" style="margin-top:6px">
            <button class="pill downloadBtn" type="button" data-url="${url}" data-name="${fname}">Download</button>
            <button class="pill openBtn" type="button">Open</button>
            <button class="pill openTabBtn" type="button" data-url="${url}">Open Tab</button>
          </div>
        </div>`;
  // After setting innerHTML, add JS to show resolution
  const imgEl = el.querySelector('img');
  const resEl = el.querySelector('.res');
  imgEl.addEventListener('load', () => {
    if (resEl) resEl.textContent = `${imgEl.naturalWidth}×${imgEl.naturalHeight}`;
  });
  imgEl.addEventListener('error', () => {
    if (resEl) resEl.textContent = '';
  });
  return el;
}

function saveHistory(history) {
  try {
    localStorage.setItem('ytPostHistory', JSON.stringify(history));
  } catch { }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem('ytPostHistory');
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function deleteHistoryIndex(idx) {
  const hist = loadHistory();
  if (idx < 0 || idx >= hist.length) return hist;
  hist.splice(idx, 1);
  saveHistory(hist);
  return hist;
}

function renderHistory(history) {
  historyBox.innerHTML = '';
  if (!history.length) {
    historyBox.innerHTML = '<h3>History</h3><p class="small">No history yet.</p>';
    return;
  }
  const headerBar = document.createElement('div');
  headerBar.style.display = 'flex';
  headerBar.style.justifyContent = 'space-between';
  headerBar.style.alignItems = 'center';

  const header = document.createElement('h3');
  header.textContent = 'History';
  headerBar.appendChild(header);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'pill';
  clearBtn.id = 'clearHistoryBtn';
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear History';
  headerBar.appendChild(clearBtn);

  historyBox.appendChild(headerBar);

  history.forEach((item, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'history-item';

    const pill = document.createElement('button');
    pill.className = 'pill history-toggle';
    pill.type = 'button';
    pill.dataset.index = String(idx);
    pill.textContent = `[${item.date}] ${item.channel} (${item.postId})`;

    const del = document.createElement('button');
    del.className = 'pill history-delete';
    del.type = 'button';
    del.dataset.index = String(idx);
    del.title = 'Remove from history';
    del.textContent = '×';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.appendChild(pill);
    row.appendChild(del);

    const content = document.createElement('div');
    content.className = 'history-content';
    content.style.display = idx === 0 ? 'block' : 'none';
    if (idx === 0) content.innerHTML = '<div class="small">Loading…</div>';

    wrap.appendChild(row);
    wrap.appendChild(content);
    historyBox.appendChild(wrap);

    // Auto-load newest entry
    if (idx === 0) {
      loadAndRenderEntry(item, content).catch(err => {
        console.error(err);
        content.innerHTML = `<div class="small">Failed to load: ${err.message}</div>`;
      });
    }
  });
}

async function loadAndRenderEntry(entry, contentEl) {
  const html = await fetchHtml(entry.url);
  const data = extractInitialData(html);
  const meta = extractPostMeta(data, html);
  const imgs = findBackstageImages(data);
  if (!imgs.length) {
    contentEl.innerHTML = '<div class="small">No images found.</div>';
    return;
  }

  const prefix = buildFilenamePrefix(meta);
  const hires = imgs.map(b => largestThumbUrl(b.thumbnails)).filter(Boolean);

  // refresh the global lastImages for ZIP / Open All
  lastImages = hires.map((url, i) => {
    const idxStr = String(i + 1).padStart(2, '0');
    const ext = (new URL(url).pathname.split('.').pop() || 'jpg').split('?')[0].slice(0, 5);
    const safeExt = /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext : 'jpg';
    const name = `${prefix}_img${idxStr}.${safeExt}`;
    return { url, name, prefix };
  });

  const metaHtml = `
    <div class="card" style="margin-top:10px">
      <div class="small">Channel: ${meta.channel || '(unknown)'} | Date: ${meta.date_iso || meta.date_raw || 'unknown'} | Post: ${meta.postId || '(unknown)'} </div>
      ${meta.text ? `<div class="small" style="margin-top:6px">“${meta.text}”</div>` : ''}
    </div>
  `;

  const grid = document.createElement('div');
  grid.className = 'grid';
  hires.forEach((u, i) => grid.appendChild(cardFor(u, prefix, i + 1)));

  contentEl.innerHTML = metaHtml;
  contentEl.appendChild(grid);
}

async function handleFetch() {
  results.innerHTML = '';
  metaCard.hidden = true;
  const input = normalizeInputToUrl(postInput.value);
  postInput.value = input;
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

  setStatus(`Found ${hires.length} image(s).`, 'ok');

  // Save to history and re-render the accordion (top item auto-loads)
  const history = loadHistory();
  const nowISO = new Date().toISOString();
  const newEntry = {
    url: input,
    channel: meta.channel || '(unknown)',
    postId: meta.postId || '(unknown)',
    date: meta.date_iso || meta.date_raw || '(unknown)',
    text: meta.text || '',
    fetchedAt: nowISO
  };
  // De-dup and move-to-top behavior
  const idx = history.findIndex(h => h.url === newEntry.url);
  if (idx >= 0) {
    // Update existing entry and move it to the top
    history.splice(idx, 1);
    history.unshift(newEntry);
  } else {
    history.unshift(newEntry);
    if (history.length > 50) history.pop();
  }
  saveHistory(history);
  renderHistory(history);
  return; // stop here; images render inside history panel
}

goBtn.onclick = handleFetch;
postInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleFetch(); });

historyBox.addEventListener('click', async (e) => {
  const t = e.target;

  // Clear entire history
  if (t.id === 'clearHistoryBtn') {
    const hist = loadHistory();
    if (!hist.length) return;
    if (confirm('Clear all history? This will remove all saved posts from this device.')) {
      saveHistory([]);
      renderHistory([]);
      setStatus('History cleared.', 'ok');
    }
    return;
  }

  if (t.classList.contains('history-delete')) {
    e.stopPropagation(); // don’t toggle accordion
    const idx = Number(t.dataset.index || '-1');
    const hist = loadHistory();
    const item = hist[idx];
    if (!item) return;
    const label = `[${item.date}] ${item.channel} (${item.postId})`;
    if (confirm(`Remove this entry?\n\n${label}`)) {
      const updated = deleteHistoryIndex(idx);
      renderHistory(updated);
      setStatus('Entry removed from history.', 'ok');
    }
    return;
  }

  // toggle expand/collapse
  if (t.classList.contains('history-toggle')) {
    const item = t.closest('.history-item');
    const content = item.querySelector('.history-content');
    const isHidden = content.style.display === 'none';
    // collapse others
    historyBox.querySelectorAll('.history-content').forEach(el => el.style.display = 'none');
    content.style.display = isHidden ? 'block' : 'none';

    if (isHidden && !content.dataset.loaded) {
      content.innerHTML = '<div class="small">Loading…</div>';
      const idx = Number(t.dataset.index || '0');
      const hist = loadHistory();
      const entry = hist[idx];
      try {
        await loadAndRenderEntry(entry, content);
        content.dataset.loaded = '1';
      } catch (err) {
        console.error(err);
        content.innerHTML = `<div class="small">Failed to load: ${err.message}</div>`;
      }
    }
    return;
  }

  // per-thumbnail open in new tab
  if (t.classList.contains('openTabBtn')) {
    const url = t.getAttribute('data-url');
    if (url) window.open(url, '_blank');
    return;
  }

  // per-thumbnail lightbox open
  if (t.classList.contains('openBtn')) {
    const thumb = t.closest('.thumb');
    const img = thumb && thumb.querySelector('img');
    if (img) {
      lightImg.src = img.src;
      lightbox.style.display = 'flex';
    }
    return;
  }

  // per-thumbnail download via FileSaver
  if (t.classList.contains('downloadBtn')) {
    e.preventDefault();
    const url = t.getAttribute('data-url');
    const name = t.getAttribute('data-name');
    if (!url || !name) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      if (window.saveAs) {
        window.saveAs(blob, name);
        setStatus(`Downloaded ${name}`, 'ok');
      } else {
        setStatus('FileSaver.js is required for download.', 'err');
      }
    } catch (err) {
      console.error(err);
      setStatus(`Download failed: ${err.message}`, 'err');
    }
  }
});

lightbox.addEventListener('click', e => {
  if (e.target === lightbox) {
    lightbox.style.display = 'none';
    lightImg.src = '';
  }
});

zipBtn.onclick = async () => {
  if (!lastImages.length) {
    setStatus('No images to zip.', 'warn');
    return;
  }
  setStatus('Preparing ZIP archive...');
  try {
    const JSZip = window.JSZip;
    const zip = new JSZip();
    await Promise.all(lastImages.map(async img => {
      const res = await fetch(img.url);
      const blob = await res.blob();
      zip.file(img.name, blob);
    }));
    const content = await zip.generateAsync({ type: 'blob' });
    const saveAs = window.saveAs;
    if (saveAs) {
      saveAs(content, `${lastImages[0].prefix}_images.zip`);
      setStatus('ZIP file ready.', 'ok');
    } else {
      setStatus('FileSaver.js is required for ZIP download.', 'err');
    }
  } catch (e) {
    console.error(e);
    setStatus(`ZIP creation failed: ${e.message}`, 'err');
  }
};

openAllBtn.onclick = () => {
  if (!lastImages.length) {
    setStatus('No images to open.', 'warn');
    return;
  }
  let opened = 0;
  lastImages.forEach(img => {
    const w = window.open(img.url, '_blank');
    if (w) opened++;
  });
  if (opened < lastImages.length) {
    alert('Some tabs were blocked by your browser popup blocker. Please allow popups for this site.');
  }
  setStatus(`Opened ${opened} image(s) in new tabs.`, 'ok');
};

// PWA registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

renderHistory(loadHistory());