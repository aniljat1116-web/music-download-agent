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
 * Clean up temporary or incomplete download files from disk
 */
function cleanupTempFiles(targetPath) {
  if (!targetPath) return;
  try {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(base + '.part') || file.startsWith(base + '.tmp')) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch (e) {}
        }
      }
    }
    if (fs.existsSync(targetPath)) {
      try {
        const stat = fs.statSync(targetPath);
        if (stat.size === 0) {
          fs.unlinkSync(targetPath);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

/**
 * Downloads a byte range or single stream into a local file
 */
async function streamToFile(url, filePath, headers = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let fileStream = null;

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
      const contentType = res.headers.get('content-type') || '';
      throw new Error(`HTTP download failed with status ${res.status} (${res.statusText || 'Error'}, Content-Type: ${contentType})`);
    }

    fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(res.body), fileStream);
  } finally {
    clearTimeout(timer);
    if (fileStream && !fileStream.destroyed) {
      fileStream.destroy();
    }
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
      try {
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
      } finally {
        if (!outStream.destroyed) {
          outStream.destroy();
        }
      }

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
  const conversionTimeout = options.conversionTimeout || 40000;
  const overallTimeoutMs = options.timeout || 90000;

  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const startTime = Date.now();
  let currentStage = 'validating';

  // Structured timestamped stage logger (no secrets)
  const logStage = (stage, percent, message, data = null) => {
    currentStage = stage;
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [Stage: ${stage}] (+${elapsedSec}s) ${message}`);
    onProgress({
      timestamp,
      phase: stage,
      percent,
      elapsedMs,
      message,
      ...(data ? { data } : {})
    });
  };

  let overallTimer = null;
  const overallTimeoutPromise = new Promise((_, reject) => {
    overallTimer = setTimeout(() => {
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      reject(new Error(`[Stage: ${currentStage}] Workflow timed out after ${elapsedSec}s (overall limit ${Math.round(overallTimeoutMs / 1000)}s)`));
    }, overallTimeoutMs);
  });

  let browser = null;
  let page = null;
  let targetFilePath = null;

  const runWorkflow = async () => {
    // 1. Validate YouTube URL
    logStage('validating', 5, 'Validating YouTube URL...');
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      throw new Error('[Stage: validating] Invalid YouTube video URL. Please provide a valid YouTube link (e.g., https://www.youtube.com/watch?v=...)');
    }

    const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
    logStage('validating', 10, `URL validated (Video ID: ${videoId})`, { videoId, normalizedUrl });

    // 2. Find browser executable
    const browserPath = findBrowserExecutable();
    if (!browserPath) {
      throw new Error('[Stage: launching_browser] No compatible Chromium browser (Microsoft Edge or Google Chrome) found on this system.');
    }

    logStage('launching_browser', 15, `Launching browser automation (${path.basename(browserPath)})...`);

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

    // Capture browser and network errors safely
    let apiData = null;
    let apiError = null;

    page.on('pageerror', (pageErr) => {
      const msg = pageErr ? pageErr.message : 'Unknown browser script error';
      console.warn(`[${new Date().toISOString()}] [Browser Page Error] ${msg}`);
    });

    page.on('requestfailed', (failedReq) => {
      const reqUrl = failedReq.url();
      const failure = failedReq.failure();
      if (reqUrl.includes('youaudiodown.com') || reqUrl.includes('theeztools.com') || reqUrl.includes('challenges.cloudflare.com')) {
        console.warn(`[${new Date().toISOString()}] [Network Failure] ${failedReq.method()} ${reqUrl} - ${failure ? failure.errorText : 'failed'}`);
      }
    });

    page.on('response', async (res) => {
      const resUrl = res.url();
      if (resUrl.includes('/api/youtube/audio-video/audio/new') && res.request().method() === 'POST') {
        const status = res.status();
        const contentType = res.headers()['content-type'] || '';
        try {
          if (contentType.includes('application/json')) {
            const json = await res.json().catch(() => null);
            if (json) {
              if (json.status === 'success' && json.data) {
                apiData = json.data;
                console.log(`[${new Date().toISOString()}] [External API Success] HTTP ${status} (${contentType})`);
              } else {
                const msg = json.message || json.error || json.detail || JSON.stringify(json);
                apiError = `External conversion API error (HTTP ${status}, ${contentType}): ${msg}`;
                console.warn(`[${new Date().toISOString()}] [External API Error] ${apiError}`);
              }
            } else {
              apiError = `External conversion API returned unparseable JSON (HTTP ${status})`;
            }
          } else {
            const bodySnippet = await res.text().catch(() => '');
            apiError = `External conversion API returned unexpected HTTP ${status} (${contentType}): ${bodySnippet.slice(0, 150).trim()}`;
            console.warn(`[${new Date().toISOString()}] [External API Error] ${apiError}`);
          }
        } catch (e) {
          apiError = `Failed to process external response (HTTP ${status}): ${e.message}`;
        }
      }
    });

    // 3. Navigate to https://youaudiodown.com/
    logStage('navigating', 25, 'Navigating to https://youaudiodown.com/ ...');
    let navResponse = null;
    try {
      navResponse = await page.goto('https://youaudiodown.com/', { waitUntil: 'networkidle2', timeout: 35000 });
    } catch (navErr) {
      throw new Error(`[Stage: navigating] Failed to navigate to https://youaudiodown.com/: ${navErr.message}`);
    }

    if (navResponse) {
      const status = navResponse.status();
      const contentType = navResponse.headers()['content-type'] || '';
      if (!navResponse.ok() && status !== 304) {
        throw new Error(`[Stage: navigating] External website returned HTTP ${status} (${navResponse.statusText() || 'Error'}, Content-Type: ${contentType})`);
      }
    }

    // Check if Cloudflare edge blocked navigation
    const pageTitle = await page.title().catch(() => '');
    if (pageTitle.includes('Attention Required!') || pageTitle.includes('Just a moment...') || pageTitle.includes('Access Denied')) {
      throw new Error(`[Stage: navigating] External website blocked access with Cloudflare challenge page (Title: "${pageTitle}"). Automated access from cloud/datacenter IPs is blocked.`);
    }

    // 4. Wait for input field and enter the URL
    logStage('submitting_url', 35, 'Entering URL into website input field...');
    try {
      await page.waitForSelector('#ymdUrlInput', { timeout: 15000 });
    } catch (selErr) {
      throw new Error('[Stage: submitting_url] Input field #ymdUrlInput not found within 15s. The website structure may have changed.');
    }

    await page.click('#ymdUrlInput', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#ymdUrlInput', normalizedUrl, { delay: 20 });

    // 5. Submit the URL
    logStage('submitting_url', 40, 'Submitting URL and initiating processing...');
    const submitBtn = await page.$('#xrespond-tools-turnstile') || await page.$('.ymd-fetch-btn');
    if (!submitBtn) {
      throw new Error('[Stage: submitting_url] Submit button not found on the website interface.');
    }
    await submitBtn.click();

    // 6. Wait for processing to finish (either preview appears, error displays, or anti-bot challenge is detected)
    logStage('processing', 45, 'Waiting for website conversion to complete...');

    const maxWaitTime = conversionTimeout;
    const pollInterval = 500;
    let elapsed = 0;
    let previewReady = false;

    while (elapsed < maxWaitTime) {
      // Check DOM state including anti-bot challenges and rate limits
      const pageState = await page.evaluate(() => {
        const preview = document.getElementById('ymdAudioPreview');
        const err = document.getElementById('ymdErrorMessage');
        const isPreviewVisible = preview && window.getComputedStyle(preview).display !== 'none';
        const hasError = err && window.getComputedStyle(err).display !== 'none' && err.textContent.trim().length > 0;
        const errorText = hasError ? err.textContent.trim() : null;

        // Check for Cloudflare Turnstile verification challenge
        const tsHost = document.getElementById('xrespond-tools-turnstile-host');
        const isTsVisible = tsHost && (tsHost.classList.contains('is-visible') || window.getComputedStyle(tsHost).display !== 'none');
        const tsError = tsHost?.querySelector('.xrespond-ts-error');
        const hasTsError = tsError && (tsError.classList.contains('is-visible') || window.getComputedStyle(tsError).display !== 'none');
        const tsErrorText = hasTsError ? tsError.textContent.trim() : null;

        // Check for Cloudflare captcha widgets or challenge containers
        const cfWidget = document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
        const cfChallenge = document.getElementById('challenge-running') || document.getElementById('cf-challenge-running');

        // Check for rate limit error container
        const rlBox = document.getElementById('xrespond-rl-error-container') || document.querySelector('[id*="xrespond-rl-error"]');
        const isRlVisible = rlBox && window.getComputedStyle(rlBox).display !== 'none';
        const rlText = isRlVisible ? rlBox.textContent.trim() : null;

        return {
          isPreviewVisible,
          hasError,
          errorText,
          isTsVisible: Boolean(isTsVisible || cfWidget || cfChallenge),
          tsErrorText,
          isRlVisible: Boolean(isRlVisible),
          rlText
        };
      });

      // Immediate detection of Cloudflare Turnstile / anti-bot challenges (Requirement 8)
      if (pageState.isTsVisible) {
        const detail = pageState.tsErrorText ? ` (${pageState.tsErrorText})` : '';
        throw new Error(
          `[Stage: processing] External service blocked automated access: Cloudflare Turnstile human verification challenge detected on youaudiodown.com${detail}. ` +
          'Cloudflare blocks automated headless browsers from cloud/datacenter IP addresses (e.g., Render). ' +
          'To ensure reliable downloads in production, please use an authorized YouTube download API, official YouTube Data API, or dedicated yt-dlp backend provider.'
        );
      }

      // Immediate detection of external rate limit
      if (pageState.isRlVisible) {
        throw new Error(`[Stage: processing] External service rate limit exceeded: "${pageState.rlText || 'Rate limit reached on youaudiodown.com'}". Please try again later or use an authorized provider.`);
      }

      // Check external API response error captured by network listener
      if (apiError) {
        throw new Error(`[Stage: processing] ${apiError}`);
      }

      // Check standard website error message
      if (pageState.hasError) {
        throw new Error(`[Stage: processing] Website conversion failed: ${pageState.errorText}`);
      }

      // Check legitimate completion signal
      if (pageState.isPreviewVisible || apiData) {
        previewReady = true;
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      // Update progress slightly while waiting
      const waitPct = Math.min(48, Math.round(45 + (elapsed / maxWaitTime) * 5));
      logStage('processing', waitPct, `Converting audio on youaudiodown.com... (${Math.round(elapsed / 1000)}s)`);
    }

    if (!previewReady && !apiData) {
      throw new Error(`[Stage: processing] Conversion timed out. The website did not finish processing within ${Math.round(maxWaitTime / 1000)} seconds.`);
    }

    // 7. Extract metadata
    logStage('processing', 50, 'Conversion ready! Extracting audio metadata...');

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
      throw new Error('[Stage: processing] Unable to extract audio download URL from the page or external API response.');
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
    logStage('downloading', 55, `Downloading audio file "${filename}"...`, {
      title, duration, uploader, thumbnail, filename, ext, totalSizeBytes
    });

    try {
      await downloadMediaFile(mediaUrl, totalSizeBytes, targetFilePath, (prog) => {
        logStage('downloading', prog.percent, prog.message);
      });
    } catch (dlErr) {
      throw new Error(`[Stage: downloading] Audio download failed: ${dlErr.message}`);
    }

    // 9. Verify downloaded file exists and is not empty
    logStage('verifying', 95, 'Verifying downloaded file on disk...');

    if (!fs.existsSync(targetFilePath)) {
      throw new Error(`[Stage: verifying] Download verification failed: File was not created at ${targetFilePath}`);
    }

    const stat = fs.statSync(targetFilePath);
    if (stat.size === 0) {
      cleanupTempFiles(targetFilePath);
      throw new Error('[Stage: verifying] Download verification failed: Downloaded file is empty (0 bytes).');
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const mem = getMemoryMetrics();
    console.log(`[${new Date().toISOString()}] [Download Verified] ${filename} (${formatFileSize(stat.size)}) in ${durationSeconds}s | RSS: ${mem.rssMb}MB`);

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

    logStage('completed', 100, `Audio successfully downloaded and verified (${result.fileSizeFormatted})!`, result);
    return result;
  };

  try {
    return await Promise.race([runWorkflow(), overallTimeoutPromise]);
  } catch (err) {
    if (targetFilePath) {
      cleanupTempFiles(targetFilePath);
    }
    throw err;
  } finally {
    if (overallTimer) {
      clearTimeout(overallTimer);
    }
    if (page) {
      try {
        await page.close();
      } catch (e) {}
      page = null;
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
      // Terminate lingering process to prevent zombie processes in Linux container
      try {
        const proc = browser.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
      browser = null;
    }
  }
}

module.exports = {
  processYouTubeDownload,
  cleanupTempFiles
};
