'use strict'
/* global nweWallpaper */

// nweWallpaper is injected via contextBridge from wallpaper-preload.js

const video = document.getElementById('wallpaper-video')

// ── Apply initial params from URL search params ───────────────────────────────
const params = new URLSearchParams(window.location.search)

const videoPath = params.get('videoPath')
const fitMode   = params.get('fitMode') || 'cover'
const speed     = parseFloat(params.get('speed') || '1')

// Always muted — no audio (PRD §3: No audio).
video.muted = true

if (videoPath) {
  video.style.objectFit = fitMode
  video.playbackRate = speed
  video.src = videoPath.startsWith('file://') ? videoPath : `file://${videoPath}`
}

// ── IPC control from main process ────────────────────────────────────────────
if (typeof window.nweWallpaper !== 'undefined') {
  window.nweWallpaper.onCommand((cmd) => {
    switch (cmd.type) {
      case 'set-video':
        video.src = cmd.videoPath.startsWith('file://') ? cmd.videoPath : `file://${cmd.videoPath}`
        video.style.objectFit = cmd.fitMode || fitMode
        video.playbackRate = cmd.speed || speed
        video.play()
        break
      case 'pause':
        video.dataset.manualPause = '1'
        video.pause()
        break
      case 'resume':
        delete video.dataset.manualPause
        video.play()
        break
      case 'set-fit':
        video.style.objectFit = cmd.fitMode
        break
      case 'set-speed':
        video.playbackRate = cmd.speed
        break
    }
  })
}

// Only auto-resume on browser-initiated pause (not our manual pause)
video.addEventListener('pause', () => {
  if (!video.dataset.manualPause) {
    video.play().catch(() => {})
  }
})

video.addEventListener('error', (e) => {
  console.error('Wallpaper video error:', e)
})
