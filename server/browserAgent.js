const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const {
  isValidYouTubeUrl,
  extractYouTubeId,
  sanitizeFilename,
  formatFileSize,
  findBrowserExecutable,
  getMemoryMetrics
} = require('./utils');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

/**
 * Downloads a byte range or single stream into a local file
 */
async function streamToFile(url, filePath, headers = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://youaudiodown.com/',
        ...headers
      },
      signal: controller.signal
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP download failed with status ${res.status} (${res.statusText})`);
    }

    const fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(res.body), fileStream);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback to curl if native fetch experiences protocol or network errors
 */
function curlFallback(url, filePath, range = null, timeoutMs = 60000) {
  const args = [
    '-4',
    '-L',
    '-s',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Referer: https://youaudiodown.com/'
  ];

  if (range) {
    args.push('-r', range);
  }

  args.push(url, '-o', filePath);
  execFileSync(CURL_BIN, args, { timeout: timeoutMs });
}

/**
 * Downloads audio file using chunked Range requests or fallback stream
 */
async function downloadMediaFile(mediaUrl, totalBytes, targetPath, onProgress) {
  const CHUNK_SIZE = 1024 * 1024; // 1 MB chunks
  const numChunks = (totalBytes && totalBytes > 0) ? Math.ceil(totalBytes / CHUNK_SIZE) : 1;

  if (totalBytes && totalBytes > 0 && numChunks > 1) {
    const tempParts = [];
    try {
      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min((i + 1) * CHUNK_SIZE - 1, totalBytes - 1);
        const partPath = `${targetPath}.part${i}`;
        tempParts.push(partPath);

        const pct = Math.round(50 + ((i + 1) / numChunks) * 40);
        if (onProgress) {
          onProgress({
            phase: 'downloading',
            percent: pct,
            message: `Downloading audio chunk ${i + 1}/${numChunks} (${formatFileSize(start)} - ${formatFileSize(end)})...`
          });
        }

        try {
          await streamToFile(mediaUrl, partPath, { 'Range': `bytes=${start}-${end}` }, 45000);
        } catch (fetchErr) {
          // Fallback to curl binary if fetch fails
          curlFallback(mediaUrl, partPath, `${start}-${end}`, 45000);
        }
      }

      // Merge parts into targetPath using streaming (avoids buffering large files in RAM)
      if (onProgress) {
        onProgress({ phase: 'downloading', percent: 92, message: 'Assembling audio stream...' });
      }

      const outStream = fs.createWriteStream(targetPath);
      for (const part of tempParts) {
        const inStream = fs.createReadStream(part);
        await new Promise((resolve, reject) => {
          inStream.pipe(outStream, { end: false });
          inStream.on('end', resolve);
          inStream.on('error', reject);
        });
        try { fs.unlinkSync(part); } catch (e) {}
      }
      outStream.end();

      await new Promise((resolve, reject) => {
        outStream.on('finish', resolve);
        outStream.on('error', reject);
      });

      return;
    } catch (chunkErr) {
      tempParts.forEach(p => { if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} } });
      console.warn('Chunked download encountered error, trying single-stream fallback:', chunkErr.message);
    }
  }

  // Single-stream fallback
  if (onProgress) {
    onProgress({ phase: 'downloading', percent: 70, message: 'Downloading audio stream directly...' });
  }

  try {
    await streamToFile(mediaUrl, targetPath, {}, 120000);
  } catch (fetchErr) {
    curlFallback(mediaUrl, targetPath, null, 120000);
  }
}

/**
 * Main Agent: Automates https://youaudiodown.com/ and downloads YouTube audio
 */
async function processYouTubeDownload(youtubeUrl, options = {}) {
  const downloadsDir = options.downloadsDir || path.join(__dirname, '..', 'downloads');
  const onProgress = options.onProgress || (() => {});
  const overallTimeoutMs = options.timeout || 90000;

  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // 1. Validate YouTube URL
  onProgress({ phase: 'validating', percent: 5, message: 'Validating YouTube URL...' });
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    throw new Error('Invalid YouTube video URL. Please provide a valid YouTube link (e.g., https://www.youtube.com/watch?v=...)');
  }

  const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
  onProgress({
    phase: 'validating',
    percent: 10,
    message: `URL validated (Video ID: ${videoId})`,
    data: { videoId, normalizedUrl }
  });

  // 2. Find browser executable
  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    throw new Error('No compatible Chromium browser (Microsoft Edge or Google Chrome) found on this Windows system.');
  }

  onProgress({
    phase: 'launching_browser',
    percent: 15,
    message: `Launching browser automation (${path.basename(browserPath)})...`
  });

  let browser = null;
  let page = null;
  let targetFilePath = null;
  const startTime = Date.now();

  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Capture the API response from the site safely
    let apiData = null;
    let apiError = null;

    page.on('response', async (res) => {
      if (res.url().includes('/api/youtube/audio-video/audio/new') && res.request().method() === 'POST') {
        try {
          const status = res.status();
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const json = await res.json();
            if (json.status === 'success' && json.data) {
              apiData = json.data;
            } else if (json.message || json.status === 'error') {
              apiError = json.message || 'API conversion failed';
            }
          } else {
            apiError = `External conversion API returned unexpected HTTP ${status} (${contentType})`;
          }
        } catch (e) {
          apiError = `Failed to process external response: ${e.message}`;
        }
      }
    });

    // 3. Navigate to https://youaudiodown.com/
    onProgress({ phase: 'navigating', percent: 25, message: 'Navigating to https://youaudiodown.com/ ...' });
    await page.goto('https://youaudiodown.com/', { waitUntil: 'networkidle2', timeout: 35000 });

    // 4. Wait for input field and enter the URL
    onProgress({ phase: 'submitting_url', percent: 35, message: 'Entering URL into website input field...' });
    await page.waitForSelector('#ymdUrlInput', { timeout: 15000 });
    
    // Clear any existing input and type the URL
    await page.click('#ymdUrlInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#ymdUrlInput', normalizedUrl, { delay: 20 });

    // 5. Submit the URL
    onProgress({ phase: 'submitting_url', percent: 40, message: 'Submitting URL and initiating processing...' });
    const submitBtn = await page.$('#xrespond-tools-turnstile') || await page.$('.ymd-fetch-btn');
    if (!submitBtn) {
      throw new Error('Submit button not found on the website interface.');
    }
    await submitBtn.click();

    // 6. Wait for processing to finish (either preview appears or error displays)
    onProgress({ phase: 'processing', percent: 45, message: 'Waiting for website conversion to complete...' });

    const maxWaitTime = 40000;
    const pollInterval = 500;
    let elapsed = 0;
    let previewReady = false;

    while (elapsed < maxWaitTime) {
      // Check DOM state
      const status = await page.evaluate(() => {
        const preview = document.getElementById('ymdAudioPreview');
        const err = document.getElementById('ymdErrorMessage');
        const isPreviewVisible = preview && window.getComputedStyle(preview).display !== 'none';
        const hasError = err && window.getComputedStyle(err).display !== 'none' && err.textContent.trim().length > 0;
        const errorText = hasError ? err.textContent.trim() : null;

        return { isPreviewVisible, hasError, errorText };
      });

      if (status.hasError || apiError) {
        throw new Error(`Website conversion failed: ${status.errorText || apiError}`);
      }

      if (status.isPreviewVisible || apiData) {
        previewReady = true;
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      // Update progress slightly while waiting
      const waitPct = Math.min(48, Math.round(45 + (elapsed / maxWaitTime) * 5));
      onProgress({
        phase: 'processing',
        percent: waitPct,
        message: `Converting audio on youaudiodown.com... (${Math.round(elapsed / 1000)}s)`
      });
    }

    if (!previewReady && !apiData) {
      throw new Error('Conversion timed out. The website did not finish processing within 40 seconds.');
    }

    // 7. Extract metadata
    onProgress({ phase: 'processing', percent: 50, message: 'Conversion ready! Extracting audio metadata...' });

    const domInfo = await page.evaluate(() => {
      const title = document.getElementById('ymdAudioTitle')?.textContent?.trim() || '';
      const duration = document.getElementById('ymdAudioDuration')?.textContent?.trim() || '';
      const uploader = document.getElementById('ymdAudioUploader')?.textContent?.trim() || '';
      const thumb = document.getElementById('ymdThumbnailPreview')?.getAttribute('src') || '';
      return { title, duration, uploader, thumb };
    });

    const title = apiData?.title || domInfo.title || 'YouTube Audio';
    const duration = apiData?.duration || domInfo.duration || '';
    const uploader = apiData?.uploader || domInfo.uploader || '';
    const thumbnail = apiData?.thumbnail || domInfo.thumb || '';

    // Determine download URL and total size
    let mediaUrl = apiData?.audio_url || apiData?.download_url || (apiData?.versions && apiData.versions[0]?.url);
    let ext = 'm4a';
    let totalSizeBytes = 0;

    if (apiData?.versions && apiData.versions.length > 0) {
      const best = apiData.versions[0];
      mediaUrl = best.url || mediaUrl;
      ext = best.ext || 'm4a';
      totalSizeBytes = best.size_bytes || 0;
    }

    // If mediaUrl not in apiData, trigger the download button and intercept window.open
    if (!mediaUrl) {
      await page.evaluate(() => {
        window.__interceptedUrl = null;
        window.open = function(url) {
          window.__interceptedUrl = url;
          return { focus: () => {} };
        };
      });

      const dlBtn = await page.$('#ymdDownloadBtn') || await page.$('button[data-ymd-download]');
      if (dlBtn) await dlBtn.click();

      await page.waitForFunction(() => window.__interceptedUrl !== null, { timeout: 8000 }).catch(() => {});
      mediaUrl = await page.evaluate(() => window.__interceptedUrl);
    }

    if (!mediaUrl) {
      throw new Error('Unable to extract audio download URL from the page.');
    }

    // If totalSizeBytes wasn't in API, check clen param in mediaUrl
    if (!totalSizeBytes) {
      const clenMatch = mediaUrl.match(/[?&]clen=(\d+)/);
      if (clenMatch) {
        totalSizeBytes = parseInt(clenMatch[1], 10);
      }
    }

    const filename = sanitizeFilename(title, ext);
    targetFilePath = path.join(downloadsDir, filename);

    // 8. Download audio file to dedicated downloads folder
    onProgress({
      phase: 'downloading',
      percent: 55,
      message: `Downloading audio file "${filename}"...`,
      data: { title, duration, uploader, thumbnail, filename, ext, totalSizeBytes }
    });

    await downloadMediaFile(mediaUrl, totalSizeBytes, targetFilePath, onProgress);

    // 9. Verify downloaded file exists and is not empty
    onProgress({ phase: 'verifying', percent: 95, message: 'Verifying downloaded file on disk...' });

    if (!fs.existsSync(targetFilePath)) {
      throw new Error(`Download verification failed: File was not created at ${targetFilePath}`);
    }

    const stat = fs.statSync(targetFilePath);
    if (stat.size === 0) {
      fs.unlinkSync(targetFilePath);
      throw new Error('Download verification failed: Downloaded file is empty (0 bytes).');
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const mem = getMemoryMetrics();
    console.log(`[Download Verified] ${filename} (${formatFileSize(stat.size)}) in ${durationSeconds}s | RSS: ${mem.rssMb}MB`);

    const result = {
      success: true,
      filename,
      filePath: targetFilePath,
      fileSizeBytes: stat.size,
      fileSizeFormatted: formatFileSize(stat.size),
      title,
      uploader,
      duration,
      thumbnail,
      ext,
      durationSeconds,
      downloadedAt: new Date().toISOString()
    };

    onProgress({
      phase: 'completed',
      percent: 100,
      message: `Audio successfully downloaded and verified (${result.fileSizeFormatted})!`,
      data: result
    });

    return result;

  } catch (err) {
    if (targetFilePath && fs.existsSync(targetFilePath)) {
      try {
        const s = fs.statSync(targetFilePath);
        if (s.size === 0) {
          fs.unlinkSync(targetFilePath);
        }
      } catch (e) {}
    }
    throw err;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // ignore close error
      }
    }
  }
}

module.exports = {
  processYouTubeDownload
};
