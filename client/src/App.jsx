import React, { useState, useEffect, useRef } from 'react';
import {
  Music,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  Pause,
  Trash2,
  ExternalLink,
  RefreshCw,
  Terminal,
  Clock,
  HardDrive,
  FileAudio,
  Sparkles,
  ArrowRight
} from 'lucide-react';

const STEPS = [
  { id: 'validating', label: 'Validate URL' },
  { id: 'launching_browser', label: 'Launch Browser' },
  { id: 'navigating', label: 'Connect to Site' },
  { id: 'submitting_url', label: 'Enter & Submit' },
  { id: 'processing', label: 'Convert Stream' },
  { id: 'downloading', label: 'Save Audio' },
  { id: 'verifying', label: 'Verify File' }
];

export default function App() {
  const [url, setUrl] = useState('');
  const [isValid, setIsValid] = useState(null);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [percent, setPercent] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [logs, setLogs] = useState([]);
  const [downloadResult, setDownloadResult] = useState(null);
  const [error, setError] = useState(null);
  
  // Library of downloaded files
  const [downloads, setDownloads] = useState([]);
  const [loadingDownloads, setLoadingDownloads] = useState(false);

  // Audio player state
  const [playingFile, setPlayingFile] = useState(null);
  const audioRef = useRef(null);

  const eventSourceRef = useRef(null);
  const logsEndRef = useRef(null);

  // Validate URL as user types
  useEffect(() => {
    if (!url.trim()) {
      setIsValid(null);
      return;
    }
    const isYt = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/.test(url.trim());
    setIsValid(isYt);
  }, [url]);

  // Scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Load downloads on mount
  useEffect(() => {
    fetchDownloads();
  }, []);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const fetchDownloads = async () => {
    setLoadingDownloads(true);
    try {
      const res = await fetch('/api/downloads');
      const data = await res.json();
      if (data.downloads) {
        setDownloads(data.downloads);
      }
    } catch (e) {
      console.error('Failed to load downloads:', e);
    } finally {
      setLoadingDownloads(false);
    }
  };

  const handleStartDownload = async (e) => {
    if (e) e.preventDefault();
    if (!url.trim() || loading) return;

    setError(null);
    setDownloadResult(null);
    setLoading(true);
    setPercent(5);
    setCurrentPhase('validating');
    setStatusMessage('Initiating download agent...');
    setLogs([{ timestamp: new Date().toLocaleTimeString(), message: 'Initiating download agent...' }]);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to start download job');
      }

      setJobId(data.jobId);
      listenToProgress(data.jobId);
    } catch (err) {
      setError(err.message);
      setLoading(false);
      setCurrentPhase('error');
    }
  };

  const listenToProgress = (id) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/progress/${id}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.status) setCurrentPhase(payload.status);
        if (payload.percent != null) setPercent(payload.percent);
        if (payload.message) {
          setStatusMessage(payload.message);
          setLogs(prev => [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: payload.message,
            phase: payload.status
          }]);
        }

        if (payload.status === 'completed') {
          setDownloadResult(payload.result);
          setLoading(false);
          es.close();
          fetchDownloads();
        } else if (payload.status === 'error') {
          setError(payload.error || 'Download workflow failed');
          setLoading(false);
          es.close();
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    es.onerror = (err) => {
      console.warn('SSE disconnected or completed');
      // If still loading, fallback to polling status
      setTimeout(() => pollJobStatus(id), 2000);
    };
  };

  const pollJobStatus = async (id) => {
    try {
      const res = await fetch(`/api/status/${id}`);
      if (!res.ok) return;
      const job = await res.json();
      if (job.status === 'completed') {
        setCurrentPhase('completed');
        setPercent(100);
        setStatusMessage(job.message);
        setDownloadResult(job.result);
        setLoading(false);
        fetchDownloads();
      } else if (job.status === 'error') {
        setCurrentPhase('error');
        setError(job.error);
        setLoading(false);
      } else if (job.status !== 'completed') {
        setTimeout(() => pollJobStatus(id), 2000);
      }
    } catch (e) {}
  };

  const handleDeleteFile = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    try {
      const res = await fetch(`/api/downloads/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (res.ok) {
        if (playingFile === filename) {
          setPlayingFile(null);
          if (audioRef.current) audioRef.current.pause();
        }
        fetchDownloads();
      }
    } catch (e) {
      alert('Failed to delete file');
    }
  };

  const handlePlayToggle = (filename) => {
    if (playingFile === filename) {
      if (audioRef.current.paused) {
        audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
    } else {
      setPlayingFile(filename);
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.src = `/api/downloads/${encodeURIComponent(filename)}`;
          audioRef.current.play();
        }
      }, 50);
    }
  };

  const fillSampleUrl = () => {
    setUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  };

  // Find active step index
  const activeStepIdx = STEPS.findIndex(s => s.id === currentPhase);

  return (
    <div className="agent-app">
      {/* Background ambient glow */}
      <div className="ambient-glow top-left"></div>
      <div className="ambient-glow bottom-right"></div>

      {/* Header */}
      <header className="agent-header">
        <div className="brand-group">
          <div className="logo-icon">
            <Music className="icon-pulse" size={24} />
          </div>
          <div>
            <h1 className="brand-title">Music Download Agent</h1>
            <p className="brand-subtitle">Automated YouTube Audio Downloader via youaudiodown.com</p>
          </div>
        </div>
        <div className="header-badge">
          <span className="status-dot online"></span>
          <span>Standalone Mode</span>
        </div>
      </header>

      {/* Main Container */}
      <main className="agent-main">
        {/* Input Card */}
        <section className="glass-card main-card">
          <div className="card-header">
            <h2 className="card-title">YouTube Audio Extraction</h2>
            <span className="card-desc">Enter any public YouTube video link to initiate automated browser conversion</span>
          </div>

          <form onSubmit={handleStartDownload} className="url-form">
            <div className="input-container">
              <input
                type="text"
                className={`url-input ${isValid === false ? 'invalid' : ''} ${isValid === true ? 'valid' : ''}`}
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
              />
              {isValid === true && (
                <span className="validity-indicator valid" title="Valid YouTube URL">
                  <CheckCircle2 size={18} />
                </span>
              )}
              {isValid === false && (
                <span className="validity-indicator invalid" title="Invalid YouTube URL">
                  <AlertCircle size={18} />
                </span>
              )}
            </div>

            <div className="form-actions">
              <button
                type="button"
                className="sample-btn"
                onClick={fillSampleUrl}
                disabled={loading}
              >
                <Sparkles size={14} />
                Sample: Rick Astley
              </button>

              <button
                type="submit"
                className="submit-btn"
                disabled={loading || !url.trim() || isValid === false}
              >
                {loading ? (
                  <>
                    <Loader2 className="spinner" size={18} />
                    <span>Processing Agent...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    <span>Download Audio</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Error Message */}
          {error && (
            <div className="alert-box error-alert">
              <AlertCircle size={20} className="alert-icon" />
              <div className="alert-content">
                <strong>Workflow Failed</strong>
                <p>{error}</p>
              </div>
            </div>
          )}

          {/* Progress Section */}
          {loading && (
            <div className="progress-section">
              <div className="progress-header">
                <span className="status-text">{statusMessage}</span>
                <span className="percent-text">{percent}%</span>
              </div>

              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${percent}%` }}
                ></div>
              </div>

              {/* Visual Pipeline Steps */}
              <div className="pipeline-steps">
                {STEPS.map((step, idx) => {
                  let stepState = 'pending';
                  if (idx < activeStepIdx || currentPhase === 'completed') stepState = 'done';
                  else if (idx === activeStepIdx) stepState = 'active';

                  return (
                    <div key={step.id} className={`step-item ${stepState}`}>
                      <div className="step-bullet">
                        {stepState === 'done' ? <CheckCircle2 size={12} /> : idx + 1}
                      </div>
                      <span className="step-label">{step.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Success Result Card */}
          {downloadResult && (
            <div className="success-card">
              <div className="success-header">
                <CheckCircle2 size={24} className="success-icon" />
                <div>
                  <h3 className="success-title">Download & Verification Complete!</h3>
                  <p className="success-subtitle">Audio stream saved and verified in downloads folder</p>
                </div>
              </div>

              <div className="result-details">
                {downloadResult.thumbnail && (
                  <img
                    src={downloadResult.thumbnail}
                    alt={downloadResult.title}
                    className="result-thumb"
                  />
                )}
                <div className="result-info">
                  <h4 className="track-title">{downloadResult.title}</h4>
                  <div className="track-meta">
                    {downloadResult.uploader && <span>👤 {downloadResult.uploader}</span>}
                    {downloadResult.duration && <span>⏱️ {downloadResult.duration}</span>}
                    <span>📦 {downloadResult.fileSizeFormatted}</span>
                    <span>⚡ {downloadResult.durationSeconds}s</span>
                  </div>
                  <div className="track-filename">
                    <FileAudio size={14} />
                    <code>{downloadResult.filename}</code>
                  </div>
                </div>
              </div>

              {/* Inline Player */}
              <div className="player-row">
                <button
                  className="play-btn-large"
                  onClick={() => handlePlayToggle(downloadResult.filename)}
                >
                  {playingFile === downloadResult.filename ? (
                    <>
                      <Pause size={18} /> Pause Preview
                    </>
                  ) : (
                    <>
                      <Play size={18} /> Play Downloaded Audio
                    </>
                  )}
                </button>

                <a
                  href={`/api/downloads/${encodeURIComponent(downloadResult.filename)}`}
                  download={downloadResult.filename}
                  className="download-file-btn"
                >
                  <Download size={18} /> Save to Disk
                </a>
              </div>
            </div>
          )}

          {/* Live Agent Terminal Logs */}
          {(loading || logs.length > 0) && (
            <div className="terminal-container">
              <div className="terminal-header">
                <div className="terminal-controls">
                  <span className="ctrl red"></span>
                  <span className="ctrl yellow"></span>
                  <span className="ctrl green"></span>
                </div>
                <div className="terminal-title">
                  <Terminal size={14} />
                  <span>Agent Execution Log</span>
                </div>
              </div>
              <div className="terminal-body">
                {logs.map((log, index) => (
                  <div key={index} className="log-line">
                    <span className="log-time">[{log.timestamp}]</span>
                    <span className="log-msg">{log.message}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
        </section>

        {/* Downloads Library Section */}
        <section className="glass-card library-card">
          <div className="library-header">
            <div>
              <h3 className="section-title">
                <HardDrive size={18} />
                <span>Downloaded Audio Files ({downloads.length})</span>
              </h3>
              <p className="section-desc">Dedicated folder: <code>downloads/</code></p>
            </div>
            <button
              className="refresh-btn"
              onClick={fetchDownloads}
              disabled={loadingDownloads}
              title="Refresh list"
            >
              <RefreshCw size={15} className={loadingDownloads ? 'spinner' : ''} />
              <span>Refresh</span>
            </button>
          </div>

          {downloads.length === 0 ? (
            <div className="empty-state">
              <FileAudio size={40} className="empty-icon" />
              <p>No audio files downloaded yet.</p>
              <span>Paste a YouTube link above to download your first track.</span>
            </div>
          ) : (
            <div className="downloads-list">
              {downloads.map((item) => {
                const isCurrentPlaying = playingFile === item.filename;
                return (
                  <div key={item.filename} className={`download-item ${isCurrentPlaying ? 'playing' : ''}`}>
                    <div className="item-icon-box">
                      <FileAudio size={20} />
                    </div>
                    <div className="item-details">
                      <span className="item-name" title={item.filename}>{item.filename}</span>
                      <div className="item-meta">
                        <span>{item.sizeFormatted}</span>
                        <span>•</span>
                        <span>{new Date(item.modifiedAt).toLocaleDateString()} {new Date(item.modifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>

                    <div className="item-actions">
                      <button
                        className={`action-btn play ${isCurrentPlaying ? 'active' : ''}`}
                        onClick={() => handlePlayToggle(item.filename)}
                        title={isCurrentPlaying ? 'Pause' : 'Play'}
                      >
                        {isCurrentPlaying ? <Pause size={16} /> : <Play size={16} />}
                      </button>

                      <a
                        href={`/api/downloads/${encodeURIComponent(item.filename)}`}
                        download={item.filename}
                        className="action-btn download"
                        title="Download to PC"
                      >
                        <Download size={16} />
                      </a>

                      <button
                        className="action-btn delete"
                        onClick={() => handleDeleteFile(item.filename)}
                        title="Delete file"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Hidden global audio element */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingFile(null)}
        style={{ display: 'none' }}
      />
    </div>
  );
}
