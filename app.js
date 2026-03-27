// ── Config (loaded from config.js) ──
const CLIENT_ID = CONFIG.GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send';
const FOLDER_NAMES = {
  work: CONFIG.WORK_FOLDER_NAME,
  personal: CONFIG.PERSONAL_FOLDER_NAME
};
const WORK_EMAIL = CONFIG.WORK_EMAIL;
const SENT_MARKER = '\n---SENT---\n';

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
const sendBtn = document.getElementById('sendBtn');
const transcriptEl = document.getElementById('transcript');
const interimEl = document.getElementById('interim');
const placeholderText = document.getElementById('placeholderText');
const dateLabel = document.getElementById('dateLabel');
const driveStatus = document.getElementById('driveStatus');
const discardBtnL = document.getElementById('discardBtnL');
const discardBtnR = document.getElementById('discardBtnR');
const versionLabel = document.getElementById('versionLabel');
const toastEl = document.getElementById('toast');

const APP_VERSION = 'v12';
versionLabel.textContent = APP_VERSION;

// Force re-auth on version change (new scope needs consent)
if (localStorage.getItem('vs_app_version') !== APP_VERSION) {
  localStorage.removeItem('vs_access_token');
  localStorage.removeItem('vs_token_expiry');
  accessToken = null;
  tokenExpiry = 0;
  localStorage.setItem('vs_app_version', APP_VERSION);
}

// ── Date helpers ──
function getDayFileName() {
  return new Date().toISOString().slice(0, 10) + '.md';
}

function updateDateLabel() {
  dateLabel.textContent = new Date().toISOString().slice(0, 10);
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
      const text = result[0].transcript.replace(/\bhashtag\s+/gi, '#');
      finalTranscript = savedTranscript + text + ' ';
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
    savedTranscript = finalTranscript;
    if (isRecording) {
      try { recognition.start(); } catch (_) {}
    }
  };

  showToast('Speech ready');
}

function startRecording() {
  if (!recognition || isRecording) return;
  placeholderText.style.display = 'none';
  savedTranscript = finalTranscript;
  isRecording = true;
  recBtn.classList.add('recording');
  navigator.vibrate?.(50);
  recognition.start();
  updateSaveButtons();
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recognition.stop();
  recBtn.classList.remove('recording');
  navigator.vibrate?.([30, 30, 30]);
  updateSaveButtons();
}

function updateSaveButtons() {
  const hasText = finalTranscript.trim().length > 0;
  workBtn.disabled = !hasText || isRecording;
  personalBtn.disabled = !hasText || isRecording;
  // Send button: disable if active unsaved transcript or recording
  if (hasText || isRecording) {
    sendBtn.disabled = true;
  }
  // Otherwise sendBtn state is managed by updateSendButton()
  discardBtnL.disabled = !hasText && !isRecording;
  discardBtnR.disabled = !hasText && !isRecording;
}

function clearTranscript() {
  finalTranscript = '';
  savedTranscript = '';
  transcriptEl.textContent = '';
  interimEl.textContent = '';
  placeholderText.style.display = 'block';
  updateSaveButtons();
}

function discard() {
  if (isRecording) {
    isRecording = false;
    recognition.stop();
    recBtn.classList.remove('recording');
  }
  clearTranscript();
  showToast('Discarded');
}

// ── Google Identity Services ──
function initGoogleAuth() {
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
          showToast('Connected');
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
      showToast('Connected');
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
    throw new Error(`API error: ${resp.status} ${resp.statusText}`);
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
    updateSendButton();
  } catch (e) {
    showToast('Folder setup failed', true);
  }
}

async function findDailyFile(folderId, fileName) {
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

// ── Sent tracking ──
function getUnsentContent(fileContent) {
  const lastMarker = fileContent.lastIndexOf('---SENT---');
  if (lastMarker === -1) {
    // No marker — everything after first line (header) is unsent
    const firstNewline = fileContent.indexOf('\n');
    return firstNewline === -1 ? '' : fileContent.slice(firstNewline + 1).trim();
  }
  return fileContent.slice(lastMarker + '---SENT---'.length).trim();
}

function hasUnsentContent(fileContent) {
  return getUnsentContent(fileContent).length > 0;
}

// ── Gmail send ──
async function sendEmail(to, subject, body) {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body
  ].join('\r\n');

  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await driveRequest('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
}

// ── Send to Work button state ──
async function updateSendButton() {
  // Don't enable send if there's unsaved transcript
  if (finalTranscript.trim().length > 0 || isRecording) {
    sendBtn.disabled = true;
    return;
  }

  try {
    if (!isTokenValid() || !driveFolderIds.work) {
      sendBtn.disabled = true;
      return;
    }
    const fileName = getDayFileName();
    const fileId = await findDailyFile(driveFolderIds.work, fileName);
    if (!fileId) {
      sendBtn.disabled = true;
      return;
    }
    const content = await getFileContent(fileId);
    sendBtn.disabled = !hasUnsentContent(content);
  } catch (e) {
    sendBtn.disabled = true;
  }
}

// ── Save Note ──
async function saveNote(context) {
  const text = finalTranscript.trim();
  if (!text) return;

  workBtn.disabled = true;
  personalBtn.disabled = true;
  sendBtn.disabled = true;

  try {
    await ensureAuth();
    if (!driveFolderIds.work) await ensureFolders();

    const folderId = driveFolderIds[context];
    const fileName = getDayFileName();
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5);

    const entry = `\n### ${timeStr}\n${text}\n`;

    const existingId = await findDailyFile(folderId, fileName);

    if (existingId) {
      const existing = await getFileContent(existingId);
      await updateFile(existingId, existing + entry);
    } else {
      const header = `# Voice Notes — ${context} — ${fileName.replace('.md', '')}\n`;
      await createFile(folderId, fileName, header + entry);
    }

    showToast(`Saved to ${context}`);
    navigator.vibrate?.(100);
    clearTranscript();

    // Update send button after saving to work
    if (context === 'work') {
      await updateSendButton();
    }

  } catch (e) {
    console.error(e);
    showToast('Save failed: ' + e.message, true);
    updateSaveButtons();
  }
}

// ── Send to Work ──
async function sendToWork() {
  sendBtn.disabled = true;

  try {
    await ensureAuth();
    if (!driveFolderIds.work) await ensureFolders();

    const fileName = getDayFileName();
    const fileId = await findDailyFile(driveFolderIds.work, fileName);

    if (!fileId) {
      showToast('Nothing to send', true);
      return;
    }

    const content = await getFileContent(fileId);
    const unsent = getUnsentContent(content);

    if (!unsent) {
      showToast('Nothing to send', true);
      return;
    }

    // Email unsent content
    const dateStr = fileName.replace('.md', '');
    await sendEmail(WORK_EMAIL, `COS:${dateStr}`, unsent);

    // Append sent marker to Drive file
    await updateFile(fileId, content + SENT_MARKER);

    showToast('Sent to work');
    navigator.vibrate?.([50, 50, 100]);
    sendBtn.disabled = true;

  } catch (e) {
    console.error(e);
    showToast('Send failed: ' + e.message, true);
    await updateSendButton();
  }
}

// ── Init ──
updateDateLabel();
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
sendBtn.addEventListener('click', () => sendToWork());

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
