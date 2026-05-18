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

function processFrames(frames, mode, filter, quality, exposure) {
  var canvas = document.getElementById('c');
  var origCanvas = document.getElementById('orig');
  var ctx = canvas.getContext('2d');
  var origCtx = origCanvas.getContext('2d');
  var images = [];
  var loaded = 0;
  var SCALE = (quality === 'Max') ? 0.7 : 0.5;

  for (var i = 0; i < frames.length; i++) {
    (function(idx) {
      var img = new Image();
      img.onload = function() {
        images[idx] = img;
        loaded++;
        if (loaded === frames.length) {
          startProcess();
        }
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

    // Save original (first frame unprocessed)
    origCtx.drawImage(valid[0], 0, 0, w, h);
    var origB64 = origCanvas.toDataURL('image/jpeg', 0.85).replace('data:image/jpeg;base64,', '');

    notify('noise');
    setTimeout(function() {
      // Frame averaging — noise reduction
      var acc = new Float32Array(w * h * 4);
      for (var f = 0; f < valid.length; f++) {
        var tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        var t = tmp.getContext('2d');
        t.drawImage(valid[f], 0, 0, w, h);
        var d = t.getImageData(0, 0, w, h).data;
        for (var j = 0; j < d.length; j++) acc[j] += d[j];
      }
      var avg = ctx.createImageData(w, h);
      for (var j = 0; j < avg.data.length; j++) avg.data[j] = acc[j] / valid.length;
      ctx.putImageData(avg, 0, 0);

      if (mode === 'NIGHT') {
        applyNightGamma(ctx, w, h);
      }

      notify('hdr');
      setTimeout(function() {
        applyHDR(ctx, w, h, mode);

        notify('sharpen');
        setTimeout(function() {
          var sharpAmt = (mode === 'NIGHT') ? 0.9 : (mode === 'PORTRAIT') ? 0.5 : 0.7;
          sharpen(ctx, w, h, sharpAmt);

          if (mode === 'PORTRAIT') {
            applyPortraitBlur(ctx, w, h);
          }

          notify('enhance');
          setTimeout(function() {
            applyEnhance(ctx, w, h, mode, exposure);

            notify('filter');
            setTimeout(function() {
              applyFilter(ctx, w, h, filter);

              if (mode !== 'PRO') {
                applyWatermark(ctx, w, h);
              }

              var result = canvas.toDataURL('image/jpeg', 0.93);
              var b64 = result.replace('data:image/jpeg;base64,', '');
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

function applyNightGamma(ctx, w, h) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  // Gamma 0.6 lifts shadows significantly (night mode brightening)
  var lut = new Uint8Array(256);
  for (var i = 0; i < 256; i++) {
    lut[i] = Math.round(255 * Math.pow(i / 255, 0.58));
  }
  for (var j = 0; j < d.length; j += 4) {
    d[j]   = lut[d[j]];
    d[j+1] = lut[d[j+1]];
    d[j+2] = lut[d[j+2]];
  }
  ctx.putImageData(id, 0, 0);
}

function applyHDR(ctx, w, h, mode) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var shadowLift = (mode === 'NIGHT') ? 30 : 12;
  var highlightRecovery = (mode === 'NIGHT') ? 0.88 : 0.94;
  for (var i = 0; i < d.length; i += 4) {
    for (var c = 0; c < 3; c++) {
      var v = d[i + c];
      if (v < 80) {
        // Lift shadows
        d[i + c] = Math.min(255, Math.round(v + shadowLift * (1 - v / 80)));
      } else if (v > 200) {
        // Recover highlights
        d[i + c] = Math.min(255, Math.round(200 + (v - 200) * highlightRecovery));
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

function sharpen(ctx, w, h, amount) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var copy = new Uint8ClampedArray(d);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      for (var c = 0; c < 3; c++) {
        var idx = (y * w + x) * 4 + c;
        var center = copy[idx];
        var neighbors = (copy[((y-1)*w+x)*4+c] + copy[((y+1)*w+x)*4+c] +
                         copy[(y*w+x-1)*4+c]   + copy[(y*w+x+1)*4+c]) / 4;
        d[idx] = Math.max(0, Math.min(255, center + amount * (center - neighbors) * 2.8));
      }
      d[(y * w + x) * 4 + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
}

function applyPortraitBlur(ctx, w, h) {
  // Blur edges, keep center sharp
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var copy = new Uint8ClampedArray(d);
  var cx = w / 2, cy = h / 2;
  var rx = w * 0.35, ry = h * 0.4;
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var dx = (x - cx) / rx, dy = (y - cy) / ry;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.75) {
        var blurAmt = Math.min(1, (dist - 0.75) / 0.5);
        var idx = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var avg = (copy[idx+c] + copy[((y-1)*w+x)*4+c] + copy[((y+1)*w+x)*4+c] +
                     copy[(y*w+x-1)*4+c] + copy[(y*w+x+1)*4+c]) / 5;
          d[idx + c] = Math.round(copy[idx + c] * (1 - blurAmt) + avg * blurAmt);
        }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

function applyEnhance(ctx, w, h, mode, exposure) {
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  var contrast = (mode === 'NIGHT') ? 1.05 : (mode === 'PORTRAIT') ? 1.06 : 1.09;
  var brightness = (mode === 'NIGHT') ? 4 : 7;
  brightness += Math.round(exposure * 25); // exposure compensation
  for (var i = 0; i < d.length; i += 4) {
    d[i]   = Math.max(0, Math.min(255, (d[i]   - 128) * contrast + 128 + brightness + 2));
    d[i+1] = Math.max(0, Math.min(255, (d[i+1] - 128) * contrast + 128 + brightness + 1));
    d[i+2] = Math.max(0, Math.min(255, (d[i+2] - 128) * contrast + 128 + brightness));
    // Subtle midtone saturation
    var lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    var lf = lum / 255;
    if (lf > 0.15 && lf < 0.88) {
      var s = 1.055;
      d[i]   = Math.max(0, Math.min(255, lum + (d[i]   - lum) * s));
      d[i+1] = Math.max(0, Math.min(255, lum + (d[i+1] - lum) * s));
      d[i+2] = Math.max(0, Math.min(255, lum + (d[i+2] - lum) * s));
    }
  }
  ctx.putImageData(id, 0, 0);
}

function applyFilter(ctx, w, h, filter) {
  if (filter === 'Natural') return;
  var id = ctx.getImageData(0, 0, w, h);
  var d = id.data;
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i+1], b = d[i+2];
    var gray = r * 0.299 + g * 0.587 + b * 0.114;
    if (filter === 'Vivid') {
      d[i]   = Math.min(255, r + (r - gray) * 0.35 + 3);
      d[i+1] = Math.min(255, g + (g - gray) * 0.35 + 3);
      d[i+2] = Math.min(255, b + (b - gray) * 0.35 + 3);
    } else if (filter === 'Matte') {
      d[i]   = Math.min(255, Math.max(0, gray + (r - gray) * 0.65 + 18));
      d[i+1] = Math.min(255, Math.max(0, gray + (g - gray) * 0.65 + 18));
      d[i+2] = Math.min(255, Math.max(0, gray + (b - gray) * 0.65 + 18));
    } else if (filter === 'B&W') {
      d[i] = d[i+1] = d[i+2] = Math.min(255, gray * 1.05);
    } else if (filter === 'Warm') {
      d[i]   = Math.min(255, r + 12);
      d[i+1] = Math.min(255, g + 4);
      d[i+2] = Math.max(0, b - 10);
    } else if (filter === 'Cool') {
      d[i]   = Math.max(0, r - 8);
      d[i+1] = Math.min(255, g + 2);
      d[i+2] = Math.min(255, b + 14);
    }
    d[i+3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

function applyWatermark(ctx, w, h) {
  ctx.save();
  ctx.font = 'bold ' + Math.round(w * 0.025) + 'px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
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
