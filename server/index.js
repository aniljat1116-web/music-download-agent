const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { processYouTubeDownload } = require('./browserAgent');
const {
  formatFileSize,
  isValidYouTubeUrl,
  extractYouTubeId,
  getMemoryMetrics
} = require('./utils');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || null;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10);
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || '3600000', 10); // 1 hour TTL
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.resolve(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// In-memory job state and concurrency queue
const jobs = new Map();
const jobQueue = [];
const activeJobs = new Set();

/**
 * Authentication middleware for sensitive or resource-intensive operations
 */
function authenticate(req, res, next) {
  if (!API_KEY) {
    return next(); // Unset API_KEY allows unauthenticated development mode
  }

  const clientKey = req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

  if (clientKey && clientKey === API_KEY) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
}

/**
 * Prune old completed/failed jobs from memory to prevent memory leaks
 */
function pruneExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if ((job.status === 'completed' || job.status === 'error') && !activeJobs.has(id)) {
      const created = new Date(job.createdAt).getTime();
      if (now - created > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  }
}

setInterval(pruneExpiredJobs, 10 * 60 * 1000).unref();

/**
 * Health check endpoint for cloud orchestrators (Kubernetes, Render, Fly.io, Railway)
 */
app.get(['/health', '/api/health'], (req, res) => {
  const mem = getMemoryMetrics();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    activeJobs: activeJobs.size,
    queuedJobs: jobQueue.length,
    totalTrackedJobs: jobs.size,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    memory: mem
  });
});

/**
 * Validate URL endpoint
 */
app.post('/api/validate', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ valid: false, error: 'URL is required' });
  }
  const videoId = extractYouTubeId(url);
  const valid = Boolean(videoId);
  return res.json({ valid, videoId, url });
});

/**
 * Helper to emit SSE progress updates to connected clients
 */
function emitJobProgress(job, event) {
  job.status = event.phase;
  job.percent = event.percent != null ? event.percent : job.percent;
  job.message = event.message || job.message;
  job.logs.push({
    timestamp: new Date().toLocaleTimeString(),
    phase: event.phase,
    percent: event.percent,
    message: event.message
  });

  if (event.data) {
    job.data = { ...(job.data || {}), ...event.data };
  }

  const payload = `data: ${JSON.stringify({
    jobId: job.id,
    status: job.status,
    percent: job.percent,
    message: job.message,
    data: job.data || null
  })}\n\n`;

  job.sseClients.forEach(client => {
    try {
      client.write(payload);
    } catch (e) {}
  });
}

/**
 * Executes a single queued download job
 */
async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  activeJobs.add(jobId);
  const startTime = Date.now();

  try {
    const result = await processYouTubeDownload(job.url, {
      downloadsDir: DOWNLOADS_DIR,
      onProgress: (event) => emitJobProgress(job, event)
    });

    job.status = 'completed';
    job.result = result;
    job.percent = 100;
    job.message = 'Audio successfully downloaded and verified!';

    const donePayload = `data: ${JSON.stringify({
      jobId,
      status: 'completed',
      percent: 100,
      message: job.message,
      result
    })}\n\n`;

    job.sseClients.forEach(c => {
      try {
        c.write(donePayload);
        c.end();
      } catch (e) {}
    });
    job.sseClients = [];

  } catch (err) {
    job.status = 'error';
    job.error = err.message || 'An unexpected error occurred during download';
    job.message = job.error;
    job.logs.push({
      timestamp: new Date().toLocaleTimeString(),
      phase: 'error',
      message: job.error
    });

    const errPayload = `data: ${JSON.stringify({
      jobId,
      status: 'error',
      percent: job.percent,
      error: job.error
    })}\n\n`;

    job.sseClients.forEach(c => {
      try {
        c.write(errPayload);
        c.end();
      } catch (e) {}
    });
    job.sseClients = [];

  } finally {
    activeJobs.delete(jobId);
    processNextJob();
  }
}

/**
 * Process next job from FIFO queue if workers are available
 */
function processNextJob() {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) {
    return;
  }

  const nextJobId = jobQueue.shift();
  runJob(nextJobId);
}

/**
 * Start a download job with concurrency queue and duplicate detection
 */
app.post('/api/download', authenticate, (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Please enter a valid YouTube video link (e.g., https://www.youtube.com/watch?v=...)'
    });
  }

  // Prevent duplicate concurrent processing of the exact same video
  for (const activeId of activeJobs) {
    const existing = jobs.get(activeId);
    if (existing && existing.videoId === videoId) {
      return res.json({
        jobId: existing.id,
        videoId,
        status: existing.status,
        message: 'A download for this video is already in progress'
      });
    }
  }

  for (const queuedId of jobQueue) {
    const existing = jobs.get(queuedId);
    if (existing && existing.videoId === videoId) {
      return res.json({
        jobId: existing.id,
        videoId,
        status: 'queued',
        message: 'A download for this video is already queued'
      });
    }
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const isQueued = activeJobs.size >= MAX_CONCURRENT_JOBS;

  const job = {
    id: jobId,
    videoId,
    url,
    status: isQueued ? 'queued' : 'pending',
    percent: 0,
    message: isQueued ? 'Job queued (waiting for worker slot)...' : 'Job initialized',
    logs: [],
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    sseClients: []
  };

  jobs.set(jobId, job);

  if (isQueued) {
    jobQueue.push(jobId);
  } else {
    runJob(jobId);
  }

  res.json({
    jobId,
    videoId,
    status: job.status,
    queued: isQueued,
    queuePosition: isQueued ? jobQueue.length : 0
  });
});

/**
 * SSE progress stream
 */
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({
    jobId,
    status: job.status,
    percent: job.percent,
    message: job.message,
    data: job.data || null,
    result: job.result || null,
    error: job.error || null
  })}\n\n`);

  if (job.status === 'completed' || job.status === 'error') {
    return res.end();
  }

  job.sseClients.push(res);

  req.on('close', () => {
    job.sseClients = job.sseClients.filter(c => c !== res);
  });
});

/**
 * Polling status fallback
 */
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    id: job.id,
    videoId: job.videoId,
    status: job.status,
    percent: job.percent,
    message: job.message,
    logs: job.logs,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt
  });
});

/**
 * List downloaded audio files
 */
app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const fileList = files
      .filter(f => !f.endsWith('.part') && !f.includes('.part') && !f.endsWith('.tmp') && f !== '.gitkeep')
      .map(filename => {
        const fullPath = path.join(DOWNLOADS_DIR, filename);
        const stats = fs.statSync(fullPath);
        return {
          filename,
          sizeBytes: stats.size,
          sizeFormatted: formatFileSize(stats.size),
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    res.json({ downloads: fileList, count: fileList.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read downloads directory' });
  }
});

/**
 * Stream/Download specific audio file with Range support
 */
app.get('/api/downloads/:filename', (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(DOWNLOADS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const ext = path.extname(safeFilename).toLowerCase();
  const contentType = ext === '.webm' ? 'audio/webm' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4');

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeFilename)}"`
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

/**
 * Delete a downloaded file
 */
app.delete('/api/downloads/:filename', authenticate, (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(DOWNLOADS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Deleted ${safeFilename}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Serve frontend static build if exists
const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

let server = null;
if (require.main === module) {
  server = app.listen(PORT, HOST, () => {
    console.log(`🎵 Music Download Agent Server running on http://${HOST}:${PORT}`);
    console.log(`📁 Downloads folder: ${DOWNLOADS_DIR}`);
    console.log(`🔒 Authentication: ${API_KEY ? 'Enabled' : 'Disabled (Public/Dev mode)'}`);
    console.log(`⚡ Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
  });

  const gracefulShutdown = () => {
    console.log('\nReceived shutdown signal. Closing server...');
    if (server) {
      server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    }
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

module.exports = app;
