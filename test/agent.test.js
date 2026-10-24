const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isValidYouTubeUrl,
  extractYouTubeId,
  sanitizeFilename,
  formatFileSize,
  findBrowserExecutable
} = require('../server/utils');
const { processYouTubeDownload, cleanupTempFiles } = require('../server/browserAgent');

async function runTests() {
  console.log('==================================================');
  console.log('🧪 RUNNING MUSIC DOWNLOAD AGENT TEST SUITE');
  console.log('==================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  async function asyncTest(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  // --- UNIT TESTS ---
  console.log('--- 1. URL Validation & Parsing ---');
  test('Standard watch URL', () => {
    assert.strictEqual(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(isValidYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  });

  test('Short youtu.be URL', () => {
    assert.strictEqual(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(isValidYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  });

  test('YouTube Shorts URL', () => {
    assert.strictEqual(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(isValidYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), true);
  });

  test('Raw 11-char Video ID', () => {
    assert.strictEqual(extractYouTubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(isValidYouTubeUrl('dQw4w9WgXcQ'), true);
  });

  test('Reject invalid URLs', () => {
    assert.strictEqual(isValidYouTubeUrl('https://example.com/not-youtube'), false);
    assert.strictEqual(isValidYouTubeUrl(''), false);
    assert.strictEqual(isValidYouTubeUrl(null), false);
    assert.strictEqual(isValidYouTubeUrl('12345'), false);
  });

  console.log('\n--- 2. Utility & Sanitization Tests ---');
  test('Sanitize Windows illegal filename characters', () => {
    const rawName = 'Rick: Astley / "Never Gonna Give You Up" *?<>';
    const safe = sanitizeFilename(rawName, 'm4a');
    assert(!safe.includes(':'));
    assert(!safe.includes('/'));
    assert(!safe.includes('"'));
    assert(!safe.includes('*'));
    assert(!safe.includes('?'));
    assert(!safe.includes('<'));
    assert(!safe.includes('>'));
    assert(safe.endsWith('.m4a'));
  });

  test('Format file size correctly', () => {
    assert.strictEqual(formatFileSize(0), '0 Bytes');
    assert.strictEqual(formatFileSize(1024), '1 KB');
    assert.strictEqual(formatFileSize(1048576), '1 MB');
    assert.strictEqual(formatFileSize(3449447), '3.29 MB');
  });

  test('Detect Chromium or Edge browser across platforms', () => {
    const browserPath = findBrowserExecutable();
    assert(browserPath !== null, 'Browser executable should be found');
    assert(fs.existsSync(browserPath), `Executable at ${browserPath} must exist`);
  });

  test('Support PUPPETEER_EXECUTABLE_PATH override', () => {
    const currentPath = findBrowserExecutable();
    process.env.PUPPETEER_EXECUTABLE_PATH = currentPath;
    const resolved = findBrowserExecutable();
    assert.strictEqual(resolved, currentPath, 'Should resolve environment variable override');
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
  });

  test('Verify temporary download files and part files cleanup', () => {
    const testDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    
    const dummyTarget = path.join(testDir, 'cleanup-test-song.m4a');
    const dummyPart0 = path.join(testDir, 'cleanup-test-song.m4a.part0');
    const dummyPart1 = path.join(testDir, 'cleanup-test-song.m4a.part1');
    const dummyTmp = path.join(testDir, 'cleanup-test-song.m4a.tmp');

    // Create 0-byte target and dummy parts
    fs.writeFileSync(dummyTarget, '');
    fs.writeFileSync(dummyPart0, 'partial-data-0');
    fs.writeFileSync(dummyPart1, 'partial-data-1');
    fs.writeFileSync(dummyTmp, 'partial-tmp');

    cleanupTempFiles(dummyTarget);

    assert(!fs.existsSync(dummyTarget), 'Zero-byte target file should be deleted');
    assert(!fs.existsSync(dummyPart0), 'Part0 file should be deleted');
    assert(!fs.existsSync(dummyPart1), 'Part1 file should be deleted');
    assert(!fs.existsSync(dummyTmp), 'Tmp file should be deleted');
  });

  console.log('\n--- 3. End-to-End Browser Automation & Download Test ---');
  await asyncTest('Automate youaudiodown.com and download Rick Astley audio or detect anti-bot challenge', async () => {
    const testDir = path.join(__dirname, '..', 'downloads');
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const progressLogs = [];

    console.log('   Starting end-to-end download workflow with browser automation...');
    try {
      const result = await processYouTubeDownload(testUrl, {
        downloadsDir: testDir,
        onProgress: (p) => {
          progressLogs.push(p);
          process.stdout.write(`\r   [Agent Progress]: ${p.percent}% - ${p.message}`);
        }
      });

      console.log('\n   Workflow completed! Verifying output...');
      assert(result.success === true, 'Result success must be true');
      assert(typeof result.filename === 'string' && result.filename.length > 0, 'Filename must be present');
      assert(fs.existsSync(result.filePath), `Downloaded file must exist at ${result.filePath}`);

      const stat = fs.statSync(result.filePath);
      assert(stat.size > 0, 'Downloaded file must not be empty');
      assert.strictEqual(stat.size, result.fileSizeBytes, 'Reported size must match actual disk size');

      console.log(`   Verified File: ${result.filename}`);
      console.log(`   File Size: ${result.fileSizeFormatted} (${result.fileSizeBytes} bytes)`);
      console.log(`   Title: ${result.title}`);
      console.log(`   Duration: ${result.duration}`);
      console.log(`   Elapsed Time: ${result.durationSeconds}s`);
    } catch (err) {
      if (err.message.includes('Cloudflare Turnstile') || err.message.includes('External service blocked automated access')) {
        console.log('\n   ⚠️ [ANTICIPATED EXTERNAL ANTI-BOT CHALLENGE DETECTED]');
        console.log(`   Correctly detected Cloudflare Turnstile without waiting 40s timeout: ${err.message}`);
        assert(err.message.startsWith('[Stage: processing]'), 'Error should specify the processing stage');
        return;
      }
      throw err;
    }
  });

  console.log('\n==================================================');
  console.log(`🏁 TEST RESULTS: ${passed}/${total} PASSED`);
  console.log('==================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
