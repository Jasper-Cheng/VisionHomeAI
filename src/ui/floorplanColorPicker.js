/**
 * 户型墙/地属性：饱和度×明度 + 色相条 + RGB + HEX + 吸管（支持时）
 * @param {HTMLElement} mountEl
 * @param {HTMLInputElement} hiddenInput
 * @returns {{ setHex: (hex: string, silent?: boolean) => void, destroy: () => void }}
 */
export function mountFloorplanColorPicker(mountEl, hiddenInput) {
  if (!mountEl || !hiddenInput) {
    return {
      setHex() {},
      destroy() {},
    };
  }

  const wrap = document.createElement("div");
  wrap.className = "prop-color-picker";
  wrap.innerHTML = `
    <div class="prop-color-picker__sb-wrap">
      <canvas class="prop-color-picker__sb" width="220" height="160" aria-label="饱和度与明度"></canvas>
      <div class="prop-color-picker__sb-cursor"></div>
    </div>
    <div class="prop-color-picker__tools-row">
      <button type="button" class="prop-color-picker__eyedrop" title="吸取屏幕颜色" aria-label="吸管">⌖</button>
      <span class="prop-color-picker__preview" aria-hidden="true"></span>
      <div class="prop-color-picker__hue-wrap">
        <canvas class="prop-color-picker__hue" width="220" height="14" aria-label="色相"></canvas>
        <div class="prop-color-picker__hue-cursor"></div>
      </div>
    </div>
    <div class="prop-color-picker__rgb">
      <label class="prop-color-picker__num"><span>R</span><input type="number" min="0" max="255" data-rgb="r" /></label>
      <label class="prop-color-picker__num"><span>G</span><input type="number" min="0" max="255" data-rgb="g" /></label>
      <label class="prop-color-picker__num"><span>B</span><input type="number" min="0" max="255" data-rgb="b" /></label>
    </div>
    <div class="prop-color-picker__hex-row">
      <label class="prop-color-picker__hex-label"><span>HEX</span><input type="text" class="prop-color-picker__hex" spellcheck="false" maxlength="7" placeholder="#FFFFFF" /></label>
    </div>
  `;

  mountEl.replaceChildren(wrap);

  const canvasSb = wrap.querySelector(".prop-color-picker__sb");
  const canvasHue = wrap.querySelector(".prop-color-picker__hue");
  const ctxSb = canvasSb.getContext("2d", { willReadFrequently: true });
  const ctxHue = canvasHue.getContext("2d");
  const cursorSb = wrap.querySelector(".prop-color-picker__sb-cursor");
  const cursorHue = wrap.querySelector(".prop-color-picker__hue-cursor");
  const preview = wrap.querySelector(".prop-color-picker__preview");
  const inputsRgb = wrap.querySelectorAll('input[data-rgb]');
  const inputHex = wrap.querySelector(".prop-color-picker__hex");
  const btnEyedrop = wrap.querySelector(".prop-color-picker__eyedrop");

  /** @type {{ h: number, s: number, v: number }} */
  let hsv = { h: 30, s: 0.15, v: 0.95 };

  function clamp255(x) {
    return Math.max(0, Math.min(255, Math.round(x)));
  }

  function parseHex(hex) {
    let h = String(hex ?? "")
      .trim()
      .replace(/^#/, "");
    if (h.length === 3) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((x) => clamp255(x).toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s, v };
  }

  function hsvToRgb(h, s, v) {
    h = ((((h / 360) % 1) + 1) % 1) * 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let rp = 0;
    let gp = 0;
    let bp = 0;
    if (h < 60) [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else [rp, gp, bp] = [c, 0, x];
    return {
      r: clamp255((rp + m) * 255),
      g: clamp255((gp + m) * 255),
      b: clamp255((bp + m) * 255),
    };
  }

  function getCurrentRgb() {
    return hsvToRgb(hsv.h, hsv.s, hsv.v);
  }

  function drawSb() {
    const w = canvasSb.width;
    const h = canvasSb.height;
    const img = ctxSb.createImageData(w, h);
    const hh = hsv.h;
    for (let y = 0; y < h; y++) {
      const vv = 1 - y / (h - 1 || 1);
      for (let x = 0; x < w; x++) {
        const ss = x / (w - 1 || 1);
        const { r, g, b } = hsvToRgb(hh, ss, vv);
        const i = (y * w + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctxSb.putImageData(img, 0, 0);
  }

  function drawHue() {
    const w = canvasHue.width;
    const h = canvasHue.height;
    const img = ctxHue.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const hue = (x / (w - 1 || 1)) * 360;
      const { r, g, b } = hsvToRgb(hue, 1, 1);
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctxHue.putImageData(img, 0, 0);
  }

  function positionSbCursor() {
    const w = canvasSb.width;
    const h = canvasSb.height;
    const x = hsv.s * (w - 1);
    const y = (1 - hsv.v) * (h - 1);
    cursorSb.style.left = `${(x / w) * 100}%`;
    cursorSb.style.top = `${(y / h) * 100}%`;
  }

  function positionHueCursor() {
    const w = canvasHue.width;
    const x = (hsv.h / 360) * (w - 1);
    cursorHue.style.left = `${(x / w) * 100}%`;
  }

  function updatePreview() {
    const { r, g, b } = getCurrentRgb();
    const hex = rgbToHex(r, g, b);
    preview.style.backgroundColor = hex;
    inputsRgb.forEach((inp) => {
      const k = inp.dataset.rgb;
      inp.value = String({ r, g, b }[k]);
    });
    inputHex.value = hex.toUpperCase();
  }

  function redrawAll() {
    drawHue();
    drawSb();
    positionSbCursor();
    positionHueCursor();
    updatePreview();
  }

  function sbFromEvent(ev) {
    const rect = canvasSb.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvasSb.width - 1, ((ev.clientX - rect.left) / rect.width) * canvasSb.width));
    const y = Math.max(0, Math.min(canvasSb.height - 1, ((ev.clientY - rect.top) / rect.height) * canvasSb.height));
    hsv.s = x / (canvasSb.width - 1 || 1);
    hsv.v = 1 - y / (canvasSb.height - 1 || 1);
  }

  function hueFromEvent(ev) {
    const rect = canvasHue.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvasHue.width - 1, ((ev.clientX - rect.left) / rect.width) * canvasHue.width));
    hsv.h = (x / (canvasHue.width - 1 || 1)) * 360;
  }

  function commitValue() {
    const { r, g, b } = getCurrentRgb();
    hiddenInput.value = rgbToHex(r, g, b);
    hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setHex(hex, silent = false) {
    const rgb = parseHex(hex);
    if (!rgb) return;
    hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    redrawAll();
    hiddenInput.value = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (!silent) {
      hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  let dragSb = false;
  let dragHue = false;

  function onSbMove(ev) {
    if (!dragSb) return;
    sbFromEvent(ev);
    drawSb();
    positionSbCursor();
    updatePreview();
  }
  function onSbUp(ev) {
    if (!dragSb) return;
    dragSb = false;
    try {
      canvasSb.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    commitValue();
  }

  function onHueMove(ev) {
    if (!dragHue) return;
    hueFromEvent(ev);
    drawSb();
    positionHueCursor();
    positionSbCursor();
    updatePreview();
  }
  function onHueUp(ev) {
    if (!dragHue) return;
    dragHue = false;
    try {
      canvasHue.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    commitValue();
  }

  canvasSb.addEventListener("pointerdown", (e) => {
    dragSb = true;
    canvasSb.setPointerCapture(e.pointerId);
    sbFromEvent(e);
    drawSb();
    positionSbCursor();
    updatePreview();
  });
  canvasSb.addEventListener("pointermove", onSbMove);
  canvasSb.addEventListener("pointerup", onSbUp);
  canvasSb.addEventListener("pointercancel", onSbUp);

  canvasHue.addEventListener("pointerdown", (e) => {
    dragHue = true;
    canvasHue.setPointerCapture(e.pointerId);
    hueFromEvent(e);
    drawSb();
    positionHueCursor();
    positionSbCursor();
    updatePreview();
  });
  canvasHue.addEventListener("pointermove", onHueMove);
  canvasHue.addEventListener("pointerup", onHueUp);
  canvasHue.addEventListener("pointercancel", onHueUp);

  inputsRgb.forEach((inp) => {
    inp.addEventListener("change", () => {
      const r = clamp255(Number(wrap.querySelector('[data-rgb="r"]').value));
      const g = clamp255(Number(wrap.querySelector('[data-rgb="g"]').value));
      const b = clamp255(Number(wrap.querySelector('[data-rgb="b"]').value));
      hsv = rgbToHsv(r, g, b);
      redrawAll();
      commitValue();
    });
  });

  inputHex.addEventListener("change", () => {
    const rgb = parseHex(inputHex.value);
    if (!rgb) return;
    hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    redrawAll();
    commitValue();
  });

  if (!window.EyeDropper) {
    btnEyedrop.disabled = true;
    btnEyedrop.title = "当前浏览器不支持吸管";
  } else {
    btnEyedrop.addEventListener("click", async () => {
      try {
        const ed = new window.EyeDropper();
        const { sRGBHex } = await ed.open();
        if (sRGBHex) setHex(sRGBHex, false);
      } catch {
        /* cancel */
      }
    });
  }

  const initial = parseHex(hiddenInput.value) || { r: 232, g: 220, b: 200 };
  hsv = rgbToHsv(initial.r, initial.g, initial.b);
  redrawAll();
  {
    const { r, g, b } = getCurrentRgb();
    hiddenInput.value = rgbToHex(r, g, b);
  }

  function destroy() {
    mountEl.replaceChildren();
  }

  return { setHex, destroy };
}
