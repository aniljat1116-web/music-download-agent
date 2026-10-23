const fs = require('fs');
const path = require('path');

/**
 * Validates YouTube URL and extracts video ID
 */
function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // If already 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1).split(/[?#&/]/)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(pathParts[0]) && pathParts[1]) {
        const id = pathParts[1].split(/[?#&/]/)[0];
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
    }
  } catch (e) {
    // regex fallback
    const match = trimmed.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
  }

  return null;
}

function isValidYouTubeUrl(url) {
  return !!extractYouTubeId(url);
}

/**
 * Sanitize filename for Windows filesystem
 */
function sanitizeFilename(name, ext = 'm4a') {
  if (!name) name = 'audio';
  // Remove illegal characters: < > : " / \ | ? *
  let safe = name.replace(/[<>:"/\\|?*]+/g, '_')
                 .replace(/[\x00-\x1F\x7F]/g, '')
                 .replace(/\s+/g, ' ')
                 .trim();
  if (safe.length > 100) safe = safe.slice(0, 100).trim();
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  return `${safe}.${cleanExt}`;
}

/**
 * Format bytes to human readable string
 */
function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Locate Chrome, Chromium, or Edge executable across OS platforms
 */
function findBrowserExecutable() {
  // 1. Explicit environment variable override
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  // 2. Candidate paths across Linux, Windows, macOS
  const candidatePaths = [
    // Linux standard paths
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',

    // Windows paths
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),

    // macOS paths
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];

  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Safe process memory and uptime metrics
 */
function getMemoryMetrics() {
  const mem = process.memoryUsage();
  return {
    rssMb: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
    heapUsedMb: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(2)),
    heapTotalMb: parseFloat((mem.heapTotal / 1024 / 1024).toFixed(2))
  };
}

module.exports = {
  extractYouTubeId,
  isValidYouTubeUrl,
  sanitizeFilename,
  formatFileSize,
  findBrowserExecutable,
  getMemoryMetrics
};
