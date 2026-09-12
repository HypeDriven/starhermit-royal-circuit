/**
 * bootstrap.js — entry module loaded by index.html.
 *
 * Boot sequence: progress feedback → host handshake (platform) → audio →
 * WebGL capability detection (renderer, with a 2D-mode fallback) → UI init,
 * which takes the app from boot to the title screen. Nothing here touches
 * rules state; wiring lives in ui.js.
 */

import { Platform } from './platform.js';
import { createAudio } from './audio.js';
import { init as initUI } from './ui.js';
import { themeById } from './content.js';
import { loadSettings } from './save.js';

const $ = (sel) => document.querySelector(sel);

function bootProgress(pct, text) {
  const fill = $('#boot-fill');
  const bar = fill?.closest('.progress');
  if (fill) fill.style.width = `${pct}%`;
  if (bar) bar.setAttribute('aria-valuenow', String(pct));
  const status = $('#boot-status');
  if (status && text) status.textContent = text;
}

async function boot() {
  bootProgress(8, 'Reading the festival ledger…');
  const settings = loadSettings();

  // Host handshake: clock sync + launch scope; degrades to local when static.
  const platform = await new Platform().init();
  bootProgress(30, platform.hosted ? 'Signed in — your festival pass is active.' : 'Playing locally (no host).');

  // Audio is fully procedural; safe to construct before the first gesture.
  const audio = createAudio();
  bootProgress(48, 'Tuning the instruments…');

  // WebGL capability detection: the DOM game remains fully playable without it.
  let renderer = null;
  try {
    const { createRenderer } = await import('./render.js');
    bootProgress(66, 'Lighting the lanterns…');
    renderer = await new Promise((resolve, reject) => {
      try {
        const r = createRenderer($('#gl'), {
          theme: themeById(settings.theme),
          reducedMotion: settings.accessibility.reducedMotion,
          quality: settings.graphics.tier === 'auto' ? 'medium' : settings.graphics.tier,
          palette: settings.accessibility.palette,
          onReady: () => resolve(r),
        });
        // Safety net: if the first frame never arrives, fall back to 2D.
        setTimeout(() => reject(new Error('first frame timeout')), 4000);
      } catch (err) {
        reject(err);
      }
    });
  } catch (err) {
    console.error('WebGL unavailable — continuing in 2D mode:', err);
    renderer = null;
    document.body.classList.add('no-gl');
    const fb = $('#gl-fallback');
    if (fb) {
      fb.hidden = false;
      $('#gl-fallback-continue')?.addEventListener('click', () => { fb.hidden = true; }, { once: true });
    }
  }

  bootProgress(88, 'Setting the tables…');
  initUI({ platform, renderer, audio });
  bootProgress(100, 'Welcome to the festival.');
}

boot().catch((err) => {
  console.error('boot failed', err);
  const status = $('#boot-status');
  if (status) status.textContent = 'Something went wrong while loading — please refresh.';
});
