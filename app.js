// ── Config (loaded from config.js) ──
const CLIENT_ID = CONFIG.GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAMES = {
  work: CONFIG.WORK_FOLDER_NAME,
  personal: CONFIG.PERSONAL_FOLDER_NAME
};

// ── State ──
let recognition = null;
let isRecording = false;
let finalTranscript = '';
let savedTranscript = ''; // accumulated text across auto-restarts
let tokenClient = null;
let accessToken = localStorage.getItem('vs_access_token');
let tokenExpiry = parseInt(localStorage.getItem('vs_token_expiry') || '0');
let driveFolderIds = {}; // { work, personal }

// ── DOM ──
const recBtn = document.getElementById('recBtn');
const workBtn = document.getElementById('workBtn');
const personalBtn = document.getElementById('personalBtn');
const transcriptEl = document.getElementById('transcript');
const interimEl = document.getElementById('interim');
const placeholderText = document.getElementById('placeholderText');
const weekLabel = document.getElementById('weekLabel');
const driveStatus = document.getElementById('driveStatus');
const discardBtnL = document.getElementById('discardBtnL');
const discardBtnR = document.getElementById('discardBtnR');
const versionLabel = document.getElementById('versionLabel');
const toastEl = document.getElementById('toast');

const APP_VERSION = 'v11';
versionLabel.textContent = APP_VERSION;

// ── Week calculation ──
function getISOWeek(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return {
    year: date.getFullYear(),
    week: Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7) + 1
  };
}

function getWeekFileName() {
  const { year, week } = getISOWeek(new Date());
  return `${year}-W${String(week).padStart(2, '0')}.md`;
}

function updateWeekLabel() {
  const { year, week } = getISOWeek(new Date());
  weekLabel.textContent = `W${week} · ${year}`;
}

// ── Toast ──
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toastEl.className = 'toast'; }, 2500);
}

// ── Speech Recognition ──
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Speech API not available', true);
    placeholderText.textContent = 'Speech recognition not supported on this browser.';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    showToast('Listening...');
  };

  recognition.onresult = (e) => {
    const result = e.results[0];
    if (result.isFinal) {
      finalTranscript = savedTranscript + result[0].transcript + ' ';
      savedTranscript = finalTranscript;
      transcriptEl.textContent = finalTranscript;
      interimEl.textContent = '';
    } else {
      transcriptEl.textContent = savedTranscript;
      interimEl.textContent = result[0].transcript;
    }
    placeholderText.style.display = 'none';
    updateSaveButtons();
  };

  recognition.onerror = (e) => {
    showToast('Mic error: ' + e.error, true);
    if (e.error === 'not-allowed') {
      placeholderText.textContent = 'Microphone blocked. Tap the lock icon in the address bar to allow.';
      placeholderText.style.display = 'block';
      isRecording = false;
      recBtn.classList.remove('recording');
    }
  };

  recognition.onend = () => {
    // Save accumulated text before auto-restart
    savedTranscript = finalTranscript;
    // Auto-restart if still in recording mode (Android kills it periodically)
    if (isRecording) {
      try { recognition.start(); } catch (_) {}
    }
  };

  showToast('Speech ready');
}

function startRecording() {
  if (!recognition || isRecording) return;
  placeholderText.style.display = 'none';
  savedTranscript = finalTranscript; // preserve any existing text from previous presses
  isRecording = true;
  recBtn.classList.add('recording');
  recognition.start();
  updateSaveButtons();
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recognition.stop();
  recBtn.classList.remove('recording');
  updateSaveButtons();
}

function updateSaveButtons() {
  const hasText = finalTranscript.trim().length > 0;
  workBtn.disabled = !hasText || isRecording;
  personalBtn.disabled = !hasText || isRecording;
  discardBtnL.disabled = !hasText && !isRecording;
  discardBtnR.disabled = !hasText && !isRecording;
}

function discard() {
  if (isRecording) {
    isRecording = false;
    recognition.stop();
    recBtn.classList.remove('recording');
  }
  finalTranscript = '';
  savedTranscript = '';
  transcriptEl.textContent = '';
  interimEl.textContent = '';
  placeholderText.style.display = 'block';
  updateSaveButtons();
  showToast('Discarded');
}

// ── Google Identity Services ──
function initGoogleAuth() {
  // Load the GIS library
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.onerror = () => showToast('Failed to load Google auth script', true);
  script.onload = () => {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) {
            showToast('Auth: ' + resp.error + ' - ' + (resp.error_description || ''), true);
            return;
          }
          saveToken(resp.access_token, resp.expires_in || 3600);
          showToast('Drive connected');
          ensureFolders();
        }
      });
      showToast('Auth ready');
    } catch (e) {
      showToast('Auth init error: ' + e.message, true);
    }
  };
  document.head.appendChild(script);
}

function saveToken(token, expiresIn) {
  accessToken = token;
  tokenExpiry = Date.now() + (expiresIn * 1000);
  localStorage.setItem('vs_access_token', token);
  localStorage.setItem('vs_token_expiry', String(tokenExpiry));
  driveStatus.classList.add('connected');
}

function clearToken() {
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem('vs_access_token');
  localStorage.removeItem('vs_token_expiry');
  driveStatus.classList.remove('connected');
}

function isTokenValid() {
  return accessToken && Date.now() < tokenExpiry;
}

function ensureAuth() {
  return new Promise((resolve, reject) => {
    if (isTokenValid()) { resolve(); return; }
    clearToken();
    tokenClient.callback = (resp) => {
      if (resp.error) {
        showToast('Auth: ' + resp.error + ' - ' + (resp.error_description || ''), true);
        reject(resp.error);
        return;
      }
      saveToken(resp.access_token, resp.expires_in || 3600);
      showToast('Drive connected');
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// ── Google Drive Operations ──
async function driveRequest(url, opts = {}, _retried = false) {
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...(opts.headers || {})
    }
  });
  if (resp.status === 401 && !_retried) {
    clearToken();
    await ensureAuth();
    return driveRequest(url, opts, true);
  }
  if (!resp.ok) {
    throw new Error(`Drive API error: ${resp.status} ${resp.statusText}`);
  }
  return resp;
}

async function findOrCreateFolder(name, parentId = null) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const resp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
  );
  const data = await resp.json();

  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create it
  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {})
  };
  const createResp = await driveRequest('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const created = await createResp.json();
  return created.id;
}

async function ensureFolders() {
  try {
    driveFolderIds.work = await findOrCreateFolder(FOLDER_NAMES.work);
    driveFolderIds.personal = await findOrCreateFolder(FOLDER_NAMES.personal);
  } catch (e) {
    showToast('Folder setup failed', true);
  }
}

async function findWeeklyFile(folderId, fileName) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const resp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
  );
  const data = await resp.json();
  return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

async function getFileContent(fileId) {
  const resp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  );
  return resp.text();
}

async function createFile(folderId, fileName, content) {
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'text/markdown'
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'text/markdown' }));

  const resp = await driveRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', body: form }
  );
  return resp.json();
}

async function updateFile(fileId, content) {
  const resp = await driveRequest(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/markdown' },
      body: content
    }
  );
  return resp.json();
}

// ── Save Note ──
async function saveNote(context) {
  const text = finalTranscript.trim();
  if (!text) return;

  workBtn.disabled = true;
  personalBtn.disabled = true;

  try {
    await ensureAuth();
    if (!driveFolderIds.work) await ensureFolders();

    const folderId = driveFolderIds[context];
    const fileName = getWeekFileName();
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');

    const entry = `\n### ${timestamp}\n${text}\n`;

    const existingId = await findWeeklyFile(folderId, fileName);

    if (existingId) {
      const existing = await getFileContent(existingId);
      await updateFile(existingId, existing + entry);
    } else {
      const header = `# Voice Notes — ${context} — ${fileName.replace('.md', '')}\n`;
      await createFile(folderId, fileName, header + entry);
    }

    showToast(`Saved to ${context}`);

    // Reset
    finalTranscript = '';
    savedTranscript = '';
    transcriptEl.textContent = '';
    interimEl.textContent = '';
    placeholderText.style.display = 'block';
    updateSaveButtons();

  } catch (e) {
    console.error(e);
    showToast('Save failed: ' + e.message, true);
    updateSaveButtons();
  }
}

// ── Init ──
updateWeekLabel();
if (isTokenValid()) driveStatus.classList.add('connected');
initSpeech();
initGoogleAuth();

// Push-to-talk: hold to record, release to stop
recBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
recBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });
recBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); stopRecording(); });
// Mouse fallback for desktop testing
recBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startRecording(); });
recBtn.addEventListener('mouseup', (e) => { e.preventDefault(); stopRecording(); });
recBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });

discardBtnL.addEventListener('click', discard);
discardBtnR.addEventListener('click', discard);
workBtn.addEventListener('click', () => saveNote('work'));
personalBtn.addEventListener('click', () => saveNote('personal'));

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
