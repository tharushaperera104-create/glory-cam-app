import React, { useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import { StyleSheet, View } from "react-native";
import WebView from "react-native-webview";

export type ProcessStep =
  | "noise"
  | "sharpen"
  | "enhance"
  | "face"
  | "hdr"
  | "filter"
  | "done"
  | "error";

export type CamMode = "PHOTO" | "PORTRAIT" | "NIGHT" | "VIDEO" | "PRO";
export type FilterType = "Natural" | "Vivid" | "Matte" | "B&W" | "Warm" | "Cool";
export type QualityType = "Fast" | "Max";

export interface ProcessOptions {
  mode: CamMode;
  filter: FilterType;
  quality: QualityType;
  exposure: number;
}

export interface ProcessResult {
  processed: string;
  original: string;
}

export interface ProcessorHandle {
  process(
    frames: string[],
    onStep: (step: ProcessStep) => void,
    options: ProcessOptions
  ): Promise<ProcessResult>;
}

const PROCESSOR_HTML = `<!DOCTYPE html>
<html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;background:#000;overflow:hidden">
<canvas id="c" style="display:none"></canvas>
<canvas id="orig" style="display:none"></canvas>
<script>
function notify(step) {
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'step', step: step }));
}

function initProcessor(payloadJson) {
  try {
    var p = JSON.parse(payloadJson);
    processFrames(p.frames, p.mode, p.filter, p.quality, p.exposure);
  } catch(e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', msg: e.message }));
  }
}

// ─── RGB ↔ HSL helpers ──────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  var r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ─── Separable box blur (3 passes ≈ Gaussian) ───────────────────────────────
function boxBlurH(d, w, h, r) {
  var len = w * h * 4;
  var tmp = new Uint8ClampedArray(len);
  var inv = 1 / (2 * r + 1);
  for (var y = 0; y < h; y++) {
    var rs = 0, gs = 0, bs = 0;
    for (var x = -r; x <= r; x++) {
      var xi = Math.max(0, Math.min(w - 1, x));
      var i = (y * w + xi) * 4;
      rs += d[i]; gs += d[i+1]; bs += d[i+2];
    }
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      tmp[i]   = rs * inv;
      tmp[i+1] = gs * inv;
      tmp[i+2] = bs * inv;
      tmp[i+3] = 255;
      var xn = Math.min(w - 1, x + r + 1);
      var xp = Math.max(0, x - r);
      rs += d[(y * w + xn) * 4]     - d[(y * w + xp) * 4];
      gs += d[(y * w + xn) * 4 + 1] - d[(y * w + xp) * 4 + 1];
      bs += d[(y * w + xn) * 4 + 2] - d[(y * w + xp) * 4 + 2];
    }
  }
  for (var i = 0; i < len; i++) d[i] = tmp[i];
}

function boxBlurV(d, w, h, r) {
  var len = w * h * 4;
  var tmp = new Uint8ClampedArray(len);
  var inv = 1 / (2 * r + 1);
  for (var x = 0; x < w; x++) {
    var rs = 0, gs = 0, bs = 0;
    for (var y = -r; y <= r; y++) {
      var yi = Math.max(0, Math.min(h - 1, y));
      var i = (yi * w + x) * 4;
      rs += d[i]; gs += d[i+1]; bs += d[i+2];
    }
    for (var y = 0; y < h; y++) {
      var i = (y * w + x) * 4;
      tmp[i]   = rs * inv;
      tmp[i+1] = gs * inv;
      tmp[i+2] = bs * inv;
      tmp[i+3] = 255;
      var yn = Math.min(h - 1, y + r + 1);
      var yp = Math.max(0, y - r);
      rs += d[(yn * w + x) * 4]     - d[(yp * w + x) * 4];
      gs += d[(yn * w + x) * 4 + 1] - d[(yp * w + x) * 4 + 1];
      bs += d[(yn * w + x) * 4 + 2] - d[(yp * w + x) * 4 + 2];
    }
  }
  for (var i = 0; i < len; i++) d[i] = tmp[i];
}

// 3-pass box blur approximates a Gaussian
function gaussianBlur(d, w, h, r) {
  boxBlurH(d, w, h, r); boxBlurV(d, w, h, r);
  boxBlurH(d, w, h, r); boxBlurV(d, w, h, r);
  boxBlurH(d, w, h, r); boxBlurV(d, w, h, r);
}

// ─── Main pipeline ───────────────────────────────────────────────────────────
function processFrames(frames, mode, filter, quality, exposure) {
  var canvas = document.getElementById('c');
  var origCanvas = document.getElementById('orig');
  var ctx = canvas.getContext('2d');
  var origCtx = origCanvas.getContext('2d');
  var images = [];
  var loaded = 0;
  var SCALE = (quality === 'Max') ? 0.45 : 0.32;

  for (var i = 0; i < frames.length; i++) {
    (function(idx) {
      var img = new Image();
      img.onload = function() {
        images[idx] = img;
        loaded++;
        if (loaded === frames.length) startProcess();
      };
      img.onerror = function() { loaded++; if (loaded === frames.length) startProcess(); };
      img.src = 'data:image/jpeg;base64,' + frames[idx];
    })(i);
  }

  function startProcess() {
    var valid = images.filter(Boolean);
    if (!valid.length) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', msg: 'No images' }));
      return;
    }
    var w = Math.floor(valid[0].naturalWidth * SCALE);
    var h = Math.floor(valid[0].naturalHeight * SCALE);
    canvas.width = w; canvas.height = h;
    origCanvas.width = w; origCanvas.height = h;

    // Save original (first frame)
    origCtx.drawImage(valid[0], 0, 0, w, h);
    var origB64 = origCanvas.toDataURL('image/jpeg', 0.88).replace('data:image/jpeg;base64,', '');

    // ── STEP 1: Noise reduction ──────────────────────────────────────────────
    notify('noise');
    setTimeout(function() {

      // Frame stack averaging (if multiple frames)
      var acc = new Float32Array(w * h * 4);
      for (var f = 0; f < valid.length; f++) {
        var tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        var t = tmp.getContext('2d');
        t.drawImage(valid[f], 0, 0, w, h);
        var d = t.getImageData(0, 0, w, h).data;
        for (var j = 0; j < d.length; j++) acc[j] += d[j];
      }
      var averaged = ctx.createImageData(w, h);
      for (var j = 0; j < averaged.data.length; j++) averaged.data[j] = acc[j] / valid.length;
      ctx.putImageData(averaged, 0, 0);

      // Gaussian denoise — strong for NIGHT, gentle for others
      var id = ctx.getImageData(0, 0, w, h);
      var noiseRadius = (mode === 'NIGHT') ? 2 : 1;
      gaussianBlur(id.data, w, h, noiseRadius);
      ctx.putImageData(id, 0, 0);

      // Night mode: additional shadow lift via gamma
      if (mode === 'NIGHT') {
        applyNightGamma(ctx, w, h);
      }

      // ── STEP 2: HDR tone mapping ───────────────────────────────────────────
      notify('hdr');
      setTimeout(function() {
        applyHDR(ctx, w, h, mode);

        // ── STEP 3: Edge-preserving sharpen (unsharp mask) ────────────────
        notify('sharpen');
        setTimeout(function() {
          var sharpRadius = 1;
          var sharpAmount = (mode === 'NIGHT') ? 0.65 : (mode === 'PORTRAIT') ? 0.45 : 0.75;
          unsharpMask(ctx, w, h, sharpRadius, sharpAmount);

          if (mode === 'PORTRAIT') {
            applyPortraitBlur(ctx, w, h);
          }

          // ── STEP 4: Natural color & exposure correction ────────────────
          notify('enhance');
          setTimeout(function() {
            applyNaturalEnhance(ctx, w, h, mode, exposure);

            // ── STEP 5: Filter + watermark ────────────────────────────────
            notify('filter');
            setTimeout(function() {
              applyFilter(ctx, w, h, filter);
              if (mode !== 'PRO') {
                applyWatermark(ctx, w, h);
              }

              var b64 = canvas.toDataURL('image/jpeg', 0.93).replace('data:image/jpeg;base64,', '');
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'result',
                base64: b64,
                original: origB64
              }));
            }, 20);
          }, 30);
        }, 30);
      }, 20);
    }, 20);
  }
}

// ─── Night gamma (lifts shadows while protecting highlights) ─────────────────
function applyNightGamma(ctx, w, h) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var lut = new Uint8Array(256);
  for (var i = 0; i < 256; i++) {
    // Gamma 0.55 in shadows, transition to linear in highlights
    var t = i / 255;
    var gamma = 0.55 + t * 0.45; // gradually approaches 1.0 in highlights
    lut[i] = Math.min(255, Math.round(255 * Math.pow(t, gamma)));
  }
  for (var j = 0; j < d.length; j += 4) {
    d[j]   = lut[d[j]];
    d[j+1] = lut[d[j+1]];
    d[j+2] = lut[d[j+2]];
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Unsharp mask (sharp original − blurred = edges; add back) ───────────────
function unsharpMask(ctx, w, h, radius, amount) {
  var id = ctx.getImageData(0, 0, w, h);
  var original = new Uint8ClampedArray(id.data);

  // Blur a copy for edge detection
  var blurred = new Uint8ClampedArray(id.data);
  gaussianBlur(blurred, w, h, radius);

  // Unsharp mask: out = orig + amount * (orig - blurred), only on luminance
  for (var i = 0; i < id.data.length; i += 4) {
    var origLum = original[i] * 0.299 + original[i+1] * 0.587 + original[i+2] * 0.114;
    var blurLum = blurred[i] * 0.299 + blurred[i+1] * 0.587 + blurred[i+2] * 0.114;
    var edge = origLum - blurLum;
    // Only sharpen if edge is significant (suppress noise amplification)
    if (Math.abs(edge) < 4) { continue; }
    var boost = amount * edge;
    id.data[i]   = Math.max(0, Math.min(255, original[i]   + boost));
    id.data[i+1] = Math.max(0, Math.min(255, original[i+1] + boost));
    id.data[i+2] = Math.max(0, Math.min(255, original[i+2] + boost));
  }
  ctx.putImageData(id, 0, 0);
}

// ─── HDR tone mapping — adaptive shadow/highlight recovery ───────────────────
function applyHDR(ctx, w, h, mode) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var shadowLift  = (mode === 'NIGHT') ? 28 : 10;
  var hlRecovery  = (mode === 'NIGHT') ? 0.86 : 0.92;
  for (var i = 0; i < d.length; i += 4) {
    var lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    for (var c = 0; c < 3; c++) {
      var v = d[i + c];
      if (lum < 72) {
        // Shadow lift — proportional, preserves hue ratios
        var lift = shadowLift * (1 - lum / 72);
        d[i + c] = Math.min(255, Math.round(v + lift));
      } else if (lum > 210) {
        // Highlight compression — gentle roll-off
        var excess = lum - 210;
        var compress = 1 - (excess / 45) * (1 - hlRecovery);
        d[i + c] = Math.min(255, Math.round(210 * (v / lum) + excess * compress * (v / lum)));
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Portrait background blur ────────────────────────────────────────────────
function applyPortraitBlur(ctx, w, h) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var copy = new Uint8ClampedArray(d);

  // Blur the background
  var blurred = new Uint8ClampedArray(d);
  gaussianBlur(blurred, w, h, 3);

  var cx = w / 2, cy = h * 0.42;
  var rx = w * 0.32, ry = h * 0.42;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var dx = (x - cx) / rx, dy = (y - cy) / ry;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.72) {
        var blurAmt = Math.min(1, (dist - 0.72) / 0.55);
        // Smooth transition
        blurAmt = blurAmt * blurAmt * (3 - 2 * blurAmt);
        var idx = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          d[idx + c] = Math.round(copy[idx + c] * (1 - blurAmt) + blurred[idx + c] * blurAmt);
        }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Natural enhance — HSL-based, preserves hue ──────────────────────────────
function applyNaturalEnhance(ctx, w, h, mode, exposure) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;

  // Exposure compensation (subtle)
  var expComp = Math.round(exposure * 20);

  // Mode-specific parameters
  var satBoost, contrastStrength, brightTweak;
  if (mode === 'NIGHT') {
    satBoost = 1.08; contrastStrength = 1.04; brightTweak = 3 + expComp;
  } else if (mode === 'PORTRAIT') {
    satBoost = 1.06; contrastStrength = 1.05; brightTweak = 5 + expComp;
  } else {
    satBoost = 1.10; contrastStrength = 1.07; brightTweak = 4 + expComp;
  }

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i+1], b = d[i+2];

    // Apply gentle contrast around midpoint
    r = Math.max(0, Math.min(255, (r - 128) * contrastStrength + 128 + brightTweak));
    g = Math.max(0, Math.min(255, (g - 128) * contrastStrength + 128 + brightTweak));
    b = Math.max(0, Math.min(255, (b - 128) * contrastStrength + 128 + brightTweak));

    // HSL saturation boost — preserves hue perfectly
    var hsl = rgbToHsl(r, g, b);
    var h = hsl[0], s = hsl[1], l = hsl[2];

    // Only boost midtone saturation, leave shadows/highlights alone
    if (l > 0.1 && l < 0.92 && s > 0.02) {
      // Stronger boost in midtones, tapering at extremes
      var mid = 1 - Math.abs(l - 0.5) * 2;
      var boost = 1 + (satBoost - 1) * mid;
      s = Math.min(1, s * boost);
    }

    var rgb = hslToRgb(h, s, l);
    d[i]   = rgb[0];
    d[i+1] = rgb[1];
    d[i+2] = rgb[2];
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Color filters ───────────────────────────────────────────────────────────
function applyFilter(ctx, w, h, filter) {
  if (filter === 'Natural') return;
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i+1], b = d[i+2];
    var hsl = rgbToHsl(r, g, b);
    var hh = hsl[0], s = hsl[1], l = hsl[2];

    if (filter === 'Vivid') {
      // Boost saturation via HSL — no hue shift
      s = Math.min(1, s * 1.35);
      var rgb = hslToRgb(hh, s, l);
      d[i] = rgb[0]; d[i+1] = rgb[1]; d[i+2] = rgb[2];

    } else if (filter === 'Matte') {
      // Reduce contrast, lift blacks
      l = 0.07 + l * 0.86;
      s = s * 0.72;
      var rgb = hslToRgb(hh, s, l);
      d[i] = rgb[0]; d[i+1] = rgb[1]; d[i+2] = rgb[2];

    } else if (filter === 'B&W') {
      var gray = Math.min(255, Math.round(r * 0.299 + g * 0.587 + b * 0.114));
      // Slight S-curve for cinematic B&W
      gray = Math.round(128 + (gray - 128) * 1.08);
      d[i] = d[i+1] = d[i+2] = Math.max(0, Math.min(255, gray));

    } else if (filter === 'Warm') {
      // Warm: shift hue slightly orange, boost warm tones
      d[i]   = Math.min(255, r + 14);
      d[i+1] = Math.min(255, g + 5);
      d[i+2] = Math.max(0,   b - 12);

    } else if (filter === 'Cool') {
      // Cool: shift slightly blue/teal
      d[i]   = Math.max(0,   r - 10);
      d[i+1] = Math.min(255, g + 3);
      d[i+2] = Math.min(255, b + 16);
    }
    d[i+3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Subtle watermark ────────────────────────────────────────────────────────
function applyWatermark(ctx, w, h) {
  ctx.save();
  ctx.font = 'bold ' + Math.round(w * 0.025) + 'px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('glory cam', w - 12, h - 10);
  ctx.restore();
}
</script>
</body>
</html>`;

const ImageProcessorView = forwardRef<ProcessorHandle>((_, ref) => {
  const webViewRef = useRef<WebView>(null);
  const pendingRef = useRef<{
    resolve: (r: ProcessResult) => void;
    reject: (e: Error) => void;
    onStep: (s: ProcessStep) => void;
  } | null>(null);

  const process = useCallback(
    (
      frames: string[],
      onStep: (step: ProcessStep) => void,
      options: ProcessOptions
    ): Promise<ProcessResult> => {
      return new Promise((resolve, reject) => {
        pendingRef.current = { resolve, reject, onStep };
        const payload = JSON.stringify({
          frames,
          mode: options.mode,
          filter: options.filter,
          quality: options.quality,
          exposure: options.exposure,
        });
        const escaped = payload.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
        setTimeout(() => {
          webViewRef.current?.injectJavaScript(
            `initProcessor(\`${escaped}\`); true;`
          );
        }, 250);
      });
    },
    []
  );

  useImperativeHandle(ref, () => ({ process }), [process]);

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        if (!pendingRef.current) return;
        if (msg.type === "step") {
          pendingRef.current.onStep(msg.step as ProcessStep);
        } else if (msg.type === "result") {
          const cb = pendingRef.current;
          pendingRef.current = null;
          cb.resolve({ processed: msg.base64, original: msg.original });
        } else if (msg.type === "error") {
          const cb = pendingRef.current;
          pendingRef.current = null;
          cb.reject(new Error(msg.msg));
        }
      } catch {
        // ignore
      }
    },
    []
  );

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ html: PROCESSOR_HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={onMessage}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        domStorageEnabled
      />
    </View>
  );
});

ImageProcessorView.displayName = "ImageProcessorView";
export default ImageProcessorView;

const styles = StyleSheet.create({
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
  webview: {
    width: 1,
    height: 1,
    backgroundColor: "transparent",
  },
});
