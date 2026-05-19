import { Ionicons, MaterialIcons, MaterialCommunityIcons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions, CameraType, FlashMode } from "expo-camera";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as MediaLibrary from "expo-media-library";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, {
  useRef, useState, useCallback, useEffect, useMemo,
} from "react";
import {
  Animated, Dimensions, Image, PanResponder, Platform,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import ImageProcessorView, {
  CamMode, FilterType, ProcessStep, ProcessorHandle, QualityType,
} from "@/components/ImageProcessorView";
import { addPhoto } from "@/hooks/usePhotoStore";

const { width: SCREEN_W } = Dimensions.get("window");

const MODES: CamMode[] = ["PORTRAIT", "PHOTO", "NIGHT", "VIDEO", "PRO"];
const FILTERS: FilterType[] = ["Natural", "Vivid", "Matte", "B&W", "Warm", "Cool"];
const QUALITIES: QualityType[] = ["Fast", "Max"];
const TIMERS = [0, 3, 10] as const;

const STEPS: { key: ProcessStep; label: string }[] = [
  { key: "noise", label: "Frame stacking & noise reduction" },
  { key: "hdr", label: "HDR shadow/highlight recovery" },
  { key: "sharpen", label: "Sharpening & detail recovery" },
  { key: "enhance", label: "Contrast & brightness boost" },
  { key: "filter", label: "Color grading & watermark" },
  { key: "done", label: "Saved to gallery" },
];

type AppState = "idle" | "timer" | "scanning" | "burst" | "processing" | "done" | "error";

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);
  const processorRef = useRef<ProcessorHandle>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();

  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [torch, setTorch] = useState(false);
  const [mode, setMode] = useState<CamMode>("PHOTO");
  const [filter, setFilter] = useState<FilterType>("Natural");
  const [quality, setQuality] = useState<QualityType>("Max");
  const [timerIdx, setTimerIdx] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [exposure, setExposure] = useState(0);
  const [showExposure, setShowExposure] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>("idle");
  const [scanSecondsLeft, setScanSecondsLeft] = useState(0);
  const [timerSecondsLeft, setTimerSecondsLeft] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [burstCount, setBurstCount] = useState(0);
  const [currentStep, setCurrentStep] = useState<ProcessStep | null>(null);
  const [completedSteps, setCompletedSteps] = useState<ProcessStep[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  // Tap-to-focus state
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const focusAnim = useRef(new Animated.Value(0)).current;
  const focusScaleAnim = useRef(new Animated.Value(1.4)).current;
  const focusAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const baseZoom = useRef(0);
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const timerAnim = useRef(new Animated.Value(1)).current;
  const scanAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const burstHoldRef = useRef(false);

  const isNight = mode === "NIGHT";

  // Night: 2 frames / 3s — other modes: 1 frame / 1.5s
  const SCAN_DURATION = isNight ? 3000 : 1500;
  const MAX_FRAMES = isNight ? 2 : 1;
  const FRAME_INTERVAL = isNight ? 1400 : 0;

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? insets.bottom + 34 : insets.bottom;

  useEffect(() => {
    setTorch(isNight);
    if (isNight) setFlash("off");
  }, [isNight]);

  useEffect(() => {
    if (!mediaPermission?.granted) requestMediaPermission();
  }, []);

  // Pinch-to-zoom
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onBegin(() => { baseZoom.current = zoom; })
        .onUpdate((e) => {
          setZoom(Math.max(0, Math.min(0.95, baseZoom.current + (e.scale - 1) * 0.35)));
        }),
    [zoom]
  );

  const exposurePR = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        setExposure((prev) => Math.max(-1, Math.min(1, prev - gs.dy / 200)));
      },
    })
  ).current;

  // Tap-to-focus handler
  const handleCameraTap = useCallback((event: any) => {
    if (appState !== "idle") return;
    const x = event?.nativeEvent?.x ?? event?.nativeEvent?.locationX ?? 0;
    const y = event?.nativeEvent?.y ?? event?.nativeEvent?.locationY ?? 0;
    if (!x && !y) return;

    focusAnimRef.current?.stop();
    setFocusPoint({ x, y });
    focusAnim.setValue(0);
    focusScaleAnim.setValue(1.4);

    Haptics.selectionAsync();

    focusAnimRef.current = Animated.sequence([
      Animated.parallel([
        Animated.timing(focusAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(focusScaleAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]),
      Animated.delay(900),
      Animated.timing(focusAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]);
    focusAnimRef.current.start(() => setFocusPoint(null));
  }, [appState, focusAnim, focusScaleAnim]);

  const startScanAnimation = useCallback(() => {
    scanLineAnim.setValue(0);
    scanAnimRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(scanLineAnim, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    scanAnimRef.current.start();
  }, [scanLineAnim]);

  const stopScanAnimation = useCallback(() => {
    scanAnimRef.current?.stop();
    scanLineAnim.setValue(0);
  }, [scanLineAnim]);

  const saveRawPhotoFallback = useCallback(async (photoUri: string) => {
    try {
      const ts = Date.now();
      const destUri = `${FileSystem.cacheDirectory}glorycam_raw_${ts}.jpg`;
      await FileSystem.copyAsync({ from: photoUri, to: destUri });
      const asset = await MediaLibrary.createAssetAsync(destUri);
      await MediaLibrary.createAlbumAsync("Glory Cam", asset, false);
      await addPhoto({
        id: String(ts),
        processedUri: destUri,
        originalUri: destUri,
        timestamp: ts,
        mode,
        filter: "Natural",
      });
      setLastPhoto(destUri);
      return true;
    } catch {
      return false;
    }
  }, [mode]);

  const doScan = useCallback(async () => {
    if (!cameraRef.current) return;

    if (!mediaPermission?.granted) {
      const { granted } = await requestMediaPermission();
      if (!granted) {
        setErrorMsg("Gallery permission denied");
        setAppState("error");
        setTimeout(() => setAppState("idle"), 3000);
        return;
      }
    }

    setAppState("scanning");
    setFrameCount(0);
    setCompletedSteps([]);
    setCurrentStep(null);
    setErrorMsg("");

    const scanSecs = Math.round(SCAN_DURATION / 1000);
    let remaining = scanSecs;
    setScanSecondsLeft(remaining);

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    startScanAnimation();

    const capturedUris: string[] = [];
    let framesDone = 0;

    const countdownId = setInterval(() => {
      remaining -= 1;
      setScanSecondsLeft(Math.max(0, remaining));
    }, 1000);

    const captureFrame = async () => {
      if (!cameraRef.current || framesDone >= MAX_FRAMES) return;
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.4,
          exif: false,
        });
        if (photo?.uri) {
          capturedUris.push(photo.uri);
          framesDone++;
          setFrameCount(framesDone);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      } catch { /* ignore single frame failure */ }
    };

    // Capture first frame immediately
    await captureFrame();

    // Schedule additional frames for NIGHT mode
    const frameTimers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i < MAX_FRAMES; i++) {
      frameTimers.push(setTimeout(() => captureFrame(), i * FRAME_INTERVAL));
    }

    await new Promise<void>((r) => setTimeout(r, SCAN_DURATION));
    clearInterval(countdownId);
    frameTimers.forEach(clearTimeout);
    stopScanAnimation();

    if (!capturedUris.length) {
      setErrorMsg("Could not capture photo — try again");
      setAppState("error");
      setTimeout(() => setAppState("idle"), 3000);
      return;
    }

    setAppState("processing");
    setCurrentStep("noise");

    try {
      let finalUri: string;
      let originalUri: string = capturedUris[0];

      if (Platform.OS !== "web" && processorRef.current) {
        // Read captured frames as base64 for WebView processing
        // With 1-2 frames at quality 0.4 the payload stays well under limits
        const base64Frames = await Promise.all(
          capturedUris.map((uri) =>
            FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
          )
        );

        const result = await processorRef.current.process(
          base64Frames,
          (step) => {
            setCurrentStep(step);
            setCompletedSteps((prev) => prev.includes(step) ? prev : [...prev, step]);
          },
          { mode, filter, quality, exposure }
        );

        const ts = Date.now();
        const processedPath = `${FileSystem.cacheDirectory}glorycam_p_${ts}.jpg`;
        const origPath = `${FileSystem.cacheDirectory}glorycam_o_${ts}.jpg`;

        await Promise.all([
          FileSystem.writeAsStringAsync(processedPath, result.processed, {
            encoding: FileSystem.EncodingType.Base64,
          }),
          FileSystem.writeAsStringAsync(origPath, result.original, {
            encoding: FileSystem.EncodingType.Base64,
          }),
        ]);

        finalUri = processedPath;
        originalUri = origPath;

        const asset = await MediaLibrary.createAssetAsync(finalUri);
        await MediaLibrary.createAlbumAsync("Glory Cam", asset, false);

        await addPhoto({
          id: String(ts),
          processedUri: finalUri,
          originalUri,
          timestamp: ts,
          mode,
          filter,
        });

        setLastPhoto(finalUri);
      } else {
        await saveRawPhotoFallback(capturedUris[0]);
      }

      setCurrentStep("done");
      setCompletedSteps((prev) => [...prev, "done"]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await new Promise<void>((r) => setTimeout(r, 900));
      setAppState("done");
      await new Promise<void>((r) => setTimeout(r, 500));

    } catch (err) {
      const saved = await saveRawPhotoFallback(capturedUris[0]);
      if (saved) {
        setCurrentStep("done");
        setCompletedSteps((prev) => [...prev, "done"]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await new Promise<void>((r) => setTimeout(r, 900));
      } else {
        setErrorMsg("Save failed — check storage permission");
        setAppState("error");
        await new Promise<void>((r) => setTimeout(r, 2500));
      }
    } finally {
      setAppState("idle");
      setCurrentStep(null);
    }
  }, [
    mediaPermission, requestMediaPermission, startScanAnimation, stopScanAnimation,
    mode, filter, quality, exposure, SCAN_DURATION, MAX_FRAMES, FRAME_INTERVAL,
    saveRawPhotoFallback,
  ]);

  // Burst mode
  const doBurst = useCallback(async () => {
    if (!cameraRef.current || appState !== "idle") return;
    burstHoldRef.current = true;
    setAppState("burst");
    setBurstCount(0);
    let count = 0;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    while (burstHoldRef.current && count < 20) {
      try {
        const p = await cameraRef.current.takePictureAsync({ quality: 0.85, exif: false });
        if (p?.uri) {
          const asset = await MediaLibrary.createAssetAsync(p.uri);
          await MediaLibrary.createAlbumAsync("Glory Cam", asset, false);
          count++;
          setBurstCount(count);
          setLastPhoto(p.uri);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      } catch { break; }
    }
    setAppState("idle");
    setBurstCount(0);
  }, [appState]);

  const stopBurst = useCallback(() => { burstHoldRef.current = false; }, []);

  const onShutter = useCallback(() => {
    if (appState !== "idle") return;
    const timerVal = TIMERS[timerIdx];
    if (timerVal === 0) { doScan(); return; }
    setAppState("timer");
    let left = timerVal;
    setTimerSecondsLeft(left);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    const id = setInterval(() => {
      left--;
      setTimerSecondsLeft(left);
      Animated.sequence([
        Animated.timing(timerAnim, { toValue: 1.3, duration: 200, useNativeDriver: true }),
        Animated.timing(timerAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (left <= 0) {
        clearInterval(id);
        setAppState("idle");
        doScan();
      }
    }, 1000);
  }, [timerIdx, doScan, timerAnim, appState]);

  const toggleFacing = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFacing((f) => (f === "back" ? "front" : "back"));
  }, []);

  const cycleFlash = useCallback(() => {
    if (isNight) { setTorch((t) => !t); return; }
    setFlash((f) => f === "off" ? "on" : f === "on" ? "auto" : "off");
  }, [isNight]);

  const cycleTimer = useCallback(() => {
    Haptics.selectionAsync();
    setTimerIdx((i) => (i + 1) % TIMERS.length);
  }, []);

  const goToGallery = useCallback(() => {
    router.push("/gallery");
  }, []);

  const flashIcon = isNight
    ? (torch ? "flashlight" : "flashlight-off")
    : (flash === "off" ? "flash-off" : flash === "on" ? "flash" : "flash-auto");

  const timerLabel = TIMERS[timerIdx] === 0 ? "timer-off" : `timer-${TIMERS[timerIdx]}s`;

  if (!permission) return <View style={styles.loading} />;

  if (!permission.granted) {
    return (
      <View style={styles.permContainer}>
        <StatusBar style="light" />
        <View style={{ position: "absolute", top: topPad + 16, left: 16 }}>
          <Text style={styles.logoText}>glory cam</Text>
        </View>
        <Ionicons name="camera-outline" size={64} color="#00BFFF" />
        <Text style={styles.permTitle}>Camera Access</Text>
        <Text style={styles.permSub}>Glory Cam needs camera access to capture photos</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isIdle = appState === "idle";
  const isScanning = appState === "scanning";
  const isProcessing = appState === "processing" || appState === "done";
  const isBurst = appState === "burst";
  const isTimerMode = appState === "timer";
  const isError = appState === "error";

  return (
    <View style={styles.container}>
      <StatusBar style="light" hidden />
      <ImageProcessorView ref={processorRef} />

      {/* Viewfinder with pinch-to-zoom + tap-to-focus */}
      <GestureDetector gesture={pinchGesture}>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            zoom={zoom}
            enableTorch={torch}
            onTap={handleCameraTap}
          />
        </View>
      </GestureDetector>

      {/* Tap-to-focus ring */}
      {focusPoint && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.focusRing,
            {
              left: focusPoint.x - 36,
              top: focusPoint.y - 36,
              opacity: focusAnim,
              transform: [{ scale: focusScaleAnim }],
            },
          ]}
        />
      )}

      {/* Night vignette */}
      {isNight && (
        <View style={styles.nightVignette} pointerEvents="none" />
      )}

      {/* Grid Overlay */}
      {showGrid && isIdle && (
        <View style={[StyleSheet.absoluteFill, styles.gridOverlay]} pointerEvents="none">
          <View style={styles.gridRow}>
            <View style={styles.gridLine} />
            <View style={styles.gridLine} />
          </View>
          <View style={styles.gridCol}>
            <View style={styles.gridLineH} />
            <View style={styles.gridLineH} />
          </View>
        </View>
      )}

      {/* Zoom badge */}
      {zoom > 0.05 && (
        <View style={[styles.zoomBadge, { top: topPad + 64 }]} pointerEvents="none">
          <Text style={styles.zoomText}>{(1 + zoom * 9).toFixed(1)}×</Text>
        </View>
      )}

      {/* Exposure slider */}
      {showExposure && isIdle && (
        <View style={[styles.exposureSliderContainer, { top: topPad + 60 }]} {...exposurePR.panHandlers}>
          <View style={styles.exposureTrack}>
            <View style={[styles.exposureThumb, { top: `${50 - exposure * 45}%` as any }]} />
          </View>
          <Text style={styles.exposureLabel}>
            {exposure > 0 ? `+${exposure.toFixed(1)}` : exposure.toFixed(1)} EV
          </Text>
        </View>
      )}

      {/* ── TOP BAR ── */}
      {isIdle && (
        <View style={[styles.topBar, { paddingTop: topPad + 8 }]}>
          <TouchableOpacity style={styles.iconBtn} onPress={cycleFlash}>
            <Ionicons name={flashIcon as any} size={22} color={isNight && torch ? "#FFD700" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={cycleTimer}>
            <MaterialCommunityIcons
              name={timerLabel as any}
              size={22}
              color={TIMERS[timerIdx] > 0 ? "#00BFFF" : "#fff"}
            />
          </TouchableOpacity>
          <View style={styles.logoBox}>
            <Text style={styles.logoText}>glory cam</Text>
            {isNight && <Text style={styles.nightBadge}>NIGHT</Text>}
          </View>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowGrid((g) => !g)}>
            <MaterialCommunityIcons name="grid" size={22} color={showGrid ? "#00BFFF" : "#fff"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowExposure((e) => !e)}>
            <Ionicons name="sunny-outline" size={22} color={showExposure ? "#00BFFF" : "#fff"} />
          </TouchableOpacity>
        </View>
      )}

      {/* Quality badge */}
      {isIdle && (
        <TouchableOpacity
          style={[styles.qualityBadge, { top: topPad + 66 }]}
          onPress={() => setQuality((q) => q === "Fast" ? "Max" : "Fast")}
        >
          <Text style={styles.qualityText}>{quality.toUpperCase()}</Text>
        </TouchableOpacity>
      )}

      {/* Timer Countdown */}
      {isTimerMode && (
        <View style={[StyleSheet.absoluteFill, styles.timerOverlay]} pointerEvents="none">
          <Animated.Text style={[styles.timerNumber, { transform: [{ scale: timerAnim }] }]}>
            {timerSecondsLeft}
          </Animated.Text>
          <Text style={styles.timerSub}>Get ready...</Text>
        </View>
      )}

      {/* Scanning Overlay */}
      {isScanning && (
        <View style={[StyleSheet.absoluteFill, styles.scanOverlay]} pointerEvents="none">
          <Animated.View
            style={[styles.scanLine, {
              transform: [{
                translateY: scanLineAnim.interpolate({
                  inputRange: [0, 1], outputRange: [-300, 300],
                }),
              }],
            }]}
          />
          <View style={[styles.corner, styles.cTL]} />
          <View style={[styles.corner, styles.cTR]} />
          <View style={[styles.corner, styles.cBL]} />
          <View style={[styles.corner, styles.cBR]} />
          <View style={[styles.scanInfoTop, { top: topPad + 12 }]}>
            <View style={styles.scanBadge}>
              <View style={[styles.scanDot, isNight && styles.scanDotNight]} />
              <Text style={[styles.scanBadgeText, isNight && styles.scanBadgeNight]}>
                {isNight ? "NIGHT SCAN" : "SCANNING"}
              </Text>
            </View>
            {isNight && <Text style={styles.scanTimer}>{scanSecondsLeft}s</Text>}
          </View>
          <View style={[styles.scanInfoBottom, { bottom: bottomPad + 160 }]}>
            <Text style={styles.scanHint}>
              {isNight ? "Keep phone very still" : "Hold still for best quality"}
            </Text>
            <View style={styles.frameDots}>
              {Array.from({ length: MAX_FRAMES }).map((_, i) => (
                <View key={i} style={[styles.frameDot, i < frameCount && styles.frameDotFilled]} />
              ))}
            </View>
            <Text style={styles.frameLabel}>{frameCount}/{MAX_FRAMES} frames captured</Text>
          </View>
        </View>
      )}

      {/* Burst Overlay */}
      {isBurst && (
        <View style={[StyleSheet.absoluteFill, styles.burstOverlay]} pointerEvents="none">
          <View style={[styles.burstBadge, { top: topPad + 16 }]}>
            <MaterialCommunityIcons name="camera-burst" size={20} color="#fff" />
            <Text style={styles.burstText}>BURST  {burstCount}</Text>
          </View>
        </View>
      )}

      {/* Processing Overlay */}
      {isProcessing && (
        <View style={[StyleSheet.absoluteFill, styles.processingOverlay]} pointerEvents="none">
          <View style={styles.processingCard}>
            <Text style={styles.processingTitle}>
              {appState === "done" ? "✓ Saved!" : "AI Enhancing..."}
            </Text>
            <View style={styles.stepsList}>
              {STEPS.map(({ key, label }) => {
                const isDone = completedSteps.includes(key);
                const isActive = currentStep === key && !isDone;
                return (
                  <View key={key} style={styles.stepRow}>
                    <View style={[styles.stepIcon, isDone && styles.stepIconDone, isActive && styles.stepIconActive]}>
                      {isDone
                        ? <Ionicons name="checkmark" size={12} color="#000" />
                        : isActive ? <ActivityDots /> : <View style={styles.stepDotEmpty} />}
                    </View>
                    <Text style={[styles.stepLabel, isDone && styles.stepLabelDone, isActive && styles.stepLabelActive]}>
                      {label}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      )}

      {/* Error */}
      {isError && (
        <View style={[StyleSheet.absoluteFill, styles.errorOverlay]} pointerEvents="none">
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={32} color="#ef4444" />
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        </View>
      )}

      {/* Color Filter Bar */}
      {isIdle && showFilters && (
        <View style={[styles.filterBar, { bottom: bottomPad + 190 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 16 }}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f}
                onPress={() => { setFilter(f); Haptics.selectionAsync(); }}
                style={[styles.filterChip, filter === f && styles.filterChipActive]}
              >
                <Text style={[styles.filterLabel, filter === f && styles.filterLabelActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Mode Bar */}
      {isIdle && (
        <View style={[styles.modeBar, { bottom: bottomPad + 148 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeContent}>
            {MODES.map((m) => (
              <TouchableOpacity
                key={m}
                onPress={() => { setMode(m); Haptics.selectionAsync(); }}
                style={styles.modeItem}
              >
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{m}</Text>
                {mode === m && <View style={[styles.modeDot, isNight && styles.modeDotNight]} />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── BOTTOM CONTROLS ── */}
      {isIdle && (
        <View style={[styles.bottomBar, { paddingBottom: bottomPad + 16 }]}>
          <TouchableOpacity
            style={styles.thumbnailBtn}
            onPress={goToGallery}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            {lastPhoto
              ? <Image source={{ uri: lastPhoto }} style={styles.thumbnail} />
              : <View style={styles.thumbnailEmpty}>
                  <Ionicons name="images-outline" size={22} color="#fff" />
                </View>}
          </TouchableOpacity>

          {/* Shutter — long press for burst, tap for scan */}
          <TouchableOpacity
            style={[styles.shutterOuter, isNight && styles.shutterNight]}
            onPress={onShutter}
            onLongPress={doBurst}
            onPressOut={stopBurst}
            delayLongPress={500}
            activeOpacity={0.85}
          >
            <View style={styles.shutterInnerOuter}>
              <View style={[styles.shutterInner, mode === "VIDEO" && styles.shutterVideo, isNight && styles.shutterInnerNight]} />
            </View>
          </TouchableOpacity>

          {/* Filter toggle + flip */}
          <View style={{ alignItems: "center", gap: 8 }}>
            <TouchableOpacity
              style={styles.iconBtnSm}
              onPress={() => setShowFilters((f) => !f)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons name="palette-outline" size={22} color={showFilters ? "#00BFFF" : "#fff"} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconBtnSm}
              onPress={toggleFacing}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function ActivityDots() {
  const dots = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
  ];
  useEffect(() => {
    const anims = dots.map((d, i) => {
      const a = Animated.loop(Animated.sequence([
        Animated.delay(i * 200),
        Animated.timing(d, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(d, { toValue: 0.3, duration: 300, useNativeDriver: true }),
      ]));
      a.start();
      return a;
    });
    return () => anims.forEach((a) => a.stop());
  }, []);
  return (
    <View style={{ flexDirection: "row", gap: 2, alignItems: "center" }}>
      {dots.map((d, i) => (
        <Animated.View key={i} style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: "#00BFFF", opacity: d }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  loading: { flex: 1, backgroundColor: "#000" },

  permContainer: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  permTitle: { color: "#fff", fontSize: 24, fontWeight: "700" },
  permSub: { color: "rgba(255,255,255,0.5)", fontSize: 15, textAlign: "center", lineHeight: 22 },
  permBtn: { marginTop: 8, backgroundColor: "#00BFFF", paddingHorizontal: 36, paddingVertical: 14, borderRadius: 30 },
  permBtnText: { color: "#000", fontSize: 16, fontWeight: "700" },

  focusRing: {
    position: "absolute",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: "#FFD700",
    backgroundColor: "transparent",
    zIndex: 15,
  },

  nightVignette: { ...StyleSheet.absoluteFillObject, borderWidth: 40, borderColor: "rgba(0,0,50,0.18)" },

  gridOverlay: { zIndex: 5 },
  gridRow: { flex: 1, flexDirection: "row", justifyContent: "space-evenly" },
  gridLine: { width: 1, backgroundColor: "rgba(255,255,255,0.2)" },
  gridCol: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "space-evenly" },
  gridLineH: { height: 1, backgroundColor: "rgba(255,255,255,0.2)" },

  zoomBadge: { position: "absolute", alignSelf: "center", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 },
  zoomText: { color: "#fff", fontSize: 14, fontWeight: "600" },

  exposureSliderContainer: { position: "absolute", right: 16, zIndex: 30, alignItems: "center", gap: 8 },
  exposureTrack: { width: 6, height: 140, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 3 },
  exposureThumb: { position: "absolute", width: 18, height: 18, borderRadius: 9, backgroundColor: "#FFD700", left: -6 },
  exposureLabel: { color: "#FFD700", fontSize: 11, fontWeight: "600" },

  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, zIndex: 20 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center" },
  iconBtnSm: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  logoBox: { alignItems: "center" },
  logoText: { color: "#fff", fontSize: 14, fontWeight: "600", letterSpacing: 1.5 },
  nightBadge: { color: "#FFD700", fontSize: 9, letterSpacing: 2, fontWeight: "700" },

  qualityBadge: { position: "absolute", left: 16, backgroundColor: "rgba(0,191,255,0.18)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: "rgba(0,191,255,0.35)", zIndex: 20 },
  qualityText: { color: "#00BFFF", fontSize: 10, fontWeight: "700", letterSpacing: 1 },

  timerOverlay: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", zIndex: 20 },
  timerNumber: { color: "#fff", fontSize: 120, fontWeight: "700" },
  timerSub: { color: "rgba(255,255,255,0.6)", fontSize: 16 },

  scanOverlay: { alignItems: "center", justifyContent: "center", zIndex: 10 },
  scanLine: { width: "100%", height: 2, backgroundColor: "#00BFFF", shadowColor: "#00BFFF", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.9, shadowRadius: 8 },
  corner: { position: "absolute", width: 26, height: 26, borderColor: "#00BFFF" },
  cTL: { top: "20%", left: "10%", borderTopWidth: 2.5, borderLeftWidth: 2.5 },
  cTR: { top: "20%", right: "10%", borderTopWidth: 2.5, borderRightWidth: 2.5 },
  cBL: { bottom: "30%", left: "10%", borderBottomWidth: 2.5, borderLeftWidth: 2.5 },
  cBR: { bottom: "30%", right: "10%", borderBottomWidth: 2.5, borderRightWidth: 2.5 },
  scanInfoTop: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20 },
  scanBadge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,191,255,0.18)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "rgba(0,191,255,0.4)" },
  scanDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: "#00BFFF" },
  scanDotNight: { backgroundColor: "#FFD700" },
  scanBadgeText: { color: "#00BFFF", fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  scanBadgeNight: { color: "#FFD700" },
  scanTimer: { color: "#fff", fontSize: 36, fontWeight: "700" },
  scanInfoBottom: { position: "absolute", left: 0, right: 0, alignItems: "center", gap: 10 },
  scanHint: { color: "rgba(255,255,255,0.6)", fontSize: 13 },
  frameDots: { flexDirection: "row", gap: 8 },
  frameDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.4)" },
  frameDotFilled: { backgroundColor: "#00BFFF", borderColor: "#00BFFF" },
  frameLabel: { color: "rgba(255,255,255,0.5)", fontSize: 12 },

  burstOverlay: { zIndex: 10 },
  burstBadge: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  burstText: { color: "#fff", fontSize: 18, fontWeight: "700", letterSpacing: 2 },

  processingOverlay: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.9)", zIndex: 20 },
  processingCard: { width: "82%", backgroundColor: "#0e0e0e", borderRadius: 20, padding: 24, gap: 20, borderWidth: 1, borderColor: "rgba(0,191,255,0.18)" },
  processingTitle: { color: "#fff", fontSize: 18, fontWeight: "700", textAlign: "center" },
  stepsList: { gap: 14 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(255,255,255,0.06)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  stepIconDone: { backgroundColor: "#00BFFF", borderColor: "#00BFFF" },
  stepIconActive: { borderColor: "#00BFFF", backgroundColor: "rgba(0,191,255,0.1)" },
  stepDotEmpty: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.15)" },
  stepLabel: { color: "rgba(255,255,255,0.3)", fontSize: 12, flex: 1 },
  stepLabelActive: { color: "#fff" },
  stepLabelDone: { color: "rgba(255,255,255,0.55)" },

  errorOverlay: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.75)", zIndex: 20 },
  errorCard: { backgroundColor: "#1a0505", borderRadius: 16, padding: 24, alignItems: "center", gap: 12, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  errorText: { color: "#ef4444", fontSize: 14, textAlign: "center" },

  filterBar: { position: "absolute", left: 0, right: 0, zIndex: 15 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(0,0,0,0.4)" },
  filterChipActive: { backgroundColor: "rgba(0,191,255,0.22)", borderColor: "#00BFFF" },
  filterLabel: { color: "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: "600" },
  filterLabelActive: { color: "#00BFFF" },

  modeBar: { position: "absolute", left: 0, right: 0, zIndex: 15 },
  modeContent: { paddingHorizontal: 32, gap: 4 },
  modeItem: { alignItems: "center", paddingHorizontal: 14, paddingVertical: 6 },
  modeText: { color: "rgba(255,255,255,0.5)", fontSize: 12, fontWeight: "600", letterSpacing: 1.2 },
  modeTextActive: { color: "#fff", fontSize: 13 },
  modeDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#00BFFF", marginTop: 3 },
  modeDotNight: { backgroundColor: "#FFD700" },

  bottomBar: { position: "absolute", bottom: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 32, zIndex: 25 },
  thumbnailBtn: { width: 58, height: 58, borderRadius: 12, overflow: "hidden", borderWidth: 2, borderColor: "rgba(255,255,255,0.4)" },
  thumbnail: { width: "100%", height: "100%" },
  thumbnailEmpty: { flex: 1, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" },
  shutterOuter: { width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterNight: { borderColor: "#FFD700" },
  shutterInnerOuter: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.08)" },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" },
  shutterInnerNight: { backgroundColor: "#FFD700" },
  shutterVideo: { width: 28, height: 28, borderRadius: 6, backgroundColor: "#ef4444" },
});
