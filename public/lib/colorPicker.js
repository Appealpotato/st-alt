// ── Color math ────────────────────────────────────────────────────────────────

function hsvToRgb(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, q, p, p, t, v],
    [t, v, v, q, p, p],
    [p, p, t, v, v, q],
  ].map(a => Math.round(a[i] * 255));
  return { r, g, b };
}

function hsvToHex(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, v };
}

function isValidHex(str) {
  return /^#[0-9a-f]{6}$/i.test(str);
}

// ── Canvas drawing ─────────────────────────────────────────────────────────────

function drawSpectrum(ctx, width, height, hue) {
  const { r, g, b } = hsvToRgb(hue, 1, 1);
  const gradH = ctx.createLinearGradient(0, 0, width, 0);
  gradH.addColorStop(0, '#ffffff');
  gradH.addColorStop(1, `rgb(${r},${g},${b})`);
  ctx.fillStyle = gradH;
  ctx.fillRect(0, 0, width, height);
  const gradV = ctx.createLinearGradient(0, 0, 0, height);
  gradV.addColorStop(0, 'rgba(0,0,0,0)');
  gradV.addColorStop(1, '#000000');
  ctx.fillStyle = gradV;
  ctx.fillRect(0, 0, width, height);
}

function drawCrosshair(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHueStrip(ctx, width, height) {
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

function drawHueMarker(ctx, x, height) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x - 2, 0, 4, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - 1, 0, 2, height);
}

// ── Component ──────────────────────────────────────────────────────────────────

export function createColorPicker({ anchor, initialColor, presets, onChange, onClose }) {
  let hsv = hexToHsv(isValidHex(initialColor) ? initialColor : '#ef6b6b');
  let lastCommitted = hsvToHex(hsv.h, hsv.s, hsv.v);

  // ── Build DOM ────────────────────────────────────────────────────────────────

  const popover = document.createElement('div');
  popover.className = 'color-picker-popover';
  popover.innerHTML = `
    <canvas class="color-picker-spectrum" width="190" height="130"></canvas>
    <canvas class="color-picker-hue" width="190" height="14"></canvas>
    <div class="color-picker-hex-row">
      <div class="color-picker-preview"></div>
      <input class="color-picker-hex-input" type="text" maxlength="7" spellcheck="false" />
    </div>
    <div class="color-picker-presets"></div>
  `;
  document.body.appendChild(popover);

  const specCanvas  = popover.querySelector('.color-picker-spectrum');
  const hueCanvas   = popover.querySelector('.color-picker-hue');
  const preview     = popover.querySelector('.color-picker-preview');
  const hexInput    = popover.querySelector('.color-picker-hex-input');
  const presetsEl   = popover.querySelector('.color-picker-presets');
  const specCtx     = specCanvas.getContext('2d');
  const hueCtx      = hueCanvas.getContext('2d');
  const SW = specCanvas.width, SH = specCanvas.height;
  const HW = hueCanvas.width,  HH = hueCanvas.height;

  // ── Preset swatches ──────────────────────────────────────────────────────────

  (presets || []).forEach(hex => {
    const s = document.createElement('div');
    s.className = 'color-picker-preset';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('mousedown', e => { e.preventDefault(); applyHex(hex); fireChange(); });
    presetsEl.appendChild(s);
  });

  // ── Draw helpers ─────────────────────────────────────────────────────────────

  function redrawSpectrum() {
    drawSpectrum(specCtx, SW, SH, hsv.h);
    const cx = hsv.s * SW;
    const cy = (1 - hsv.v) * SH;
    drawCrosshair(specCtx, cx, cy);
  }

  function redrawHue() {
    drawHueStrip(hueCtx, HW, HH);
    drawHueMarker(hueCtx, (hsv.h / 360) * HW, HH);
  }

  function redrawAll() {
    redrawSpectrum();
    redrawHue();
    const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
    preview.style.background = hex;
    hexInput.value = hex;
  }

  function fireChange() {
    const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
    onChange?.(hex);
  }

  function applyHex(hex) {
    if (!isValidHex(hex)) return;
    hsv = hexToHsv(hex);
    redrawAll();
  }

  // ── Spectrum interaction ─────────────────────────────────────────────────────

  function specPick(e) {
    const rect = specCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(SW, e.clientX - rect.left));
    const y = Math.max(0, Math.min(SH, e.clientY - rect.top));
    hsv.s = x / SW;
    hsv.v = 1 - y / SH;
    redrawAll();
    fireChange();
  }

  let specDragging = false;
  specCanvas.addEventListener('mousedown', e => { specDragging = true; specPick(e); });
  document.addEventListener('mousemove', e => { if (specDragging) specPick(e); });
  document.addEventListener('mouseup', () => { specDragging = false; });

  // ── Hue interaction ──────────────────────────────────────────────────────────

  function huePick(e) {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(HW, e.clientX - rect.left));
    hsv.h = (x / HW) * 360;
    redrawAll();
    fireChange();
  }

  let hueDragging = false;
  hueCanvas.addEventListener('mousedown', e => { hueDragging = true; huePick(e); });
  document.addEventListener('mousemove', e => { if (hueDragging) huePick(e); });
  document.addEventListener('mouseup', () => { hueDragging = false; });

  // ── Hex input ────────────────────────────────────────────────────────────────

  hexInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { commitHex(); hexInput.blur(); }
  });
  hexInput.addEventListener('blur', commitHex);

  function commitHex() {
    let val = hexInput.value.trim();
    if (!val.startsWith('#')) val = '#' + val;
    if (isValidHex(val)) { applyHex(val); fireChange(); }
    else hexInput.value = hsvToHex(hsv.h, hsv.s, hsv.v);
  }

  // ── Positioning ──────────────────────────────────────────────────────────────

  function reposition() {
    const aRect = anchor.getBoundingClientRect();
    const pW = popover.offsetWidth  || 220;
    const pH = popover.offsetHeight || 270;
    const vp = { w: window.innerWidth, h: window.innerHeight };

    let top = aRect.bottom + 6;
    if (aRect.bottom + pH + 6 > vp.h && aRect.top - pH - 6 >= 0) {
      top = aRect.top - pH - 6;
    }

    // Right-align to anchor; clamp within viewport
    let left = aRect.right - pW;
    if (left < 8) left = 8;
    if (left + pW > vp.w - 8) left = vp.w - pW - 8;

    popover.style.top  = top  + 'px';
    popover.style.left = left + 'px';
  }

  // ── Open / close ─────────────────────────────────────────────────────────────

  let closeTimer = null;

  function open() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    popover.style.display = '';
    reposition();
    redrawAll();
    requestAnimationFrame(() => popover.classList.add('open'));
    lastCommitted = hsvToHex(hsv.h, hsv.s, hsv.v);
  }

  function close() {
    popover.classList.remove('open');
    closeTimer = setTimeout(() => {
      closeTimer = null;
      popover.style.display = 'none';
    }, 120);
    onClose?.(hsvToHex(hsv.h, hsv.s, hsv.v));
  }

  // Close on outside click or Escape
  function onDocClick(e) {
    if (!popover.classList.contains('open')) return; // not yet open — ignore (prevents race on first click)
    if (!popover.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKeyDown);

  // Start hidden
  popover.style.display = 'none';

  return {
    open,
    close,
    destroy() {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
      popover.remove();
    },
    setColor(hex) {
      applyHex(hex);
    },
  };
}
