const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { processYouTubeDownload } = require('./browserAgent');
const { formatFileSize, isValidYouTubeUrl } = require('./utils');

const app = express();
const PORT = process.env.PORT || 5000;
const DOWNLOADS_DIR = path.resolve(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// In-memory active and completed jobs
const jobs = new Map();

/**
 * Validate URL endpoint
 */
app.post('/api/validate', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ valid: false, error: 'URL is required' });
  }
  const valid = isValidYouTubeUrl(url);
  return res.json({ valid, url });
});

/**
 * Start a download job
 */
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Please enter a valid YouTube video link (e.g., https://www.youtube.com/watch?v=...)'
    });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const job = {
    id: jobId,
    url,
    status: 'pending',
    percent: 0,
    message: 'Job initialized',
    logs: [],
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    sseClients: []
  };

  jobs.set(jobId, job);

  // Helper to broadcast progress
  const emitProgress = (event) => {
    job.status = event.phase;
    job.percent = event.percent || job.percent;
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
      jobId,
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
  };

  // Run the agent in background
  (async () => {
    try {
      const result = await processYouTubeDownload(url, {
        downloadsDir: DOWNLOADS_DIR,
        onProgress: emitProgress
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
    }
  })();

  res.json({ jobId, status: 'started' });
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

  // Send current state
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
      .filter(f => !f.endsWith('.part') && !f.includes('.part') && !f.endsWith('.tmp'))
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
  // Prevent directory traversal
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
app.delete('/api/downloads/:filename', (req, res) => {
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🎵 Music Download Agent Server running on http://localhost:${PORT}`);
    console.log(`📁 Downloads folder: ${DOWNLOADS_DIR}`);
  });
}

module.exports = app;
