import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as MediaLibrary from "expo-media-library";
import { router } from "expo-router";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Animated, Dimensions, FlatList, Image, Modal, PanResponder,
  Platform, Pressable, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getPhotos, deletePhoto, PhotoRecord } from "@/hooks/usePhotoStore";

const { width: W, height: H } = Dimensions.get("window");
const THUMB = (W - 3) / 3;

type ViewMode = "grid" | "compare";

export default function GalleryScreen() {
  const insets = useSafeAreaInsets();
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PhotoRecord | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [compareIdx, setCompareIdx] = useState(0);
  const [sliderX, setSliderX] = useState(W / 2);
  const [permission, requestPermission] = MediaLibrary.usePermissions();

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? insets.bottom + 34 : insets.bottom;

  // Before/After slider panResponder
  const sliderPR = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        setSliderX(Math.max(30, Math.min(W - 30, gs.moveX)));
      },
    })
  ).current;

  const loadPhotos = useCallback(async () => {
    setLoading(true);
    try {
      const records = await getPhotos();
      setPhotos(records);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  const handleDelete = useCallback(async (photo: PhotoRecord) => {
    await deletePhoto(photo.id);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    if (selected?.id === photo.id) setSelected(null);
  }, [selected]);

  const handleShare = useCallback(async (photo: PhotoRecord) => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (available) await Sharing.shareAsync(photo.processedUri);
    } catch { /* ignore */ }
  }, []);

  const openCompare = useCallback((photo: PhotoRecord) => {
    const idx = photos.findIndex((p) => p.id === photo.id);
    setCompareIdx(idx >= 0 ? idx : 0);
    setSliderX(W / 2);
    setViewMode("compare");
    setSelected(null);
  }, [photos]);

  const currentComparePhoto = photos[compareIdx] ?? null;

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={[styles.permContainer, { paddingTop: topPad + 16 }]}>
        <StatusBar style="light" />
        <Ionicons name="images-outline" size={56} color="#00BFFF" />
        <Text style={styles.permTitle}>Gallery Access</Text>
        <Text style={styles.permSub}>Allow access to view your Glory Cam photos</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Before/After Compare View ──
  if (viewMode === "compare" && currentComparePhoto) {
    const prev = compareIdx > 0 ? photos[compareIdx - 1] : null;
    const next = compareIdx < photos.length - 1 ? photos[compareIdx + 1] : null;
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <View style={[styles.compareContainer]}>
          {/* Processed (right side = base) */}
          <Image
            source={{ uri: currentComparePhoto.processedUri }}
            style={styles.compareImg}
            resizeMode="contain"
          />
          {/* Original clipped to left of slider */}
          <View style={{ position: "absolute", left: 0, top: 0, width: sliderX, height: H, overflow: "hidden" }}>
            <Image
              source={{ uri: currentComparePhoto.originalUri }}
              style={[styles.compareImg, { width: W }]}
              resizeMode="contain"
            />
          </View>
          {/* Divider */}
          <View style={[styles.divider, { left: sliderX - 1 }]} />
          <View style={[styles.dividerHandle, { left: sliderX - 18 }]} {...sliderPR.panHandlers}>
            <Ionicons name="swap-horizontal" size={18} color="#000" />
          </View>
          {/* Labels */}
          <View style={[styles.compareLabel, { left: 12 }]}>
            <Text style={styles.compareLabelText}>ORIGINAL</Text>
          </View>
          <View style={[styles.compareLabel, { right: 12 }]}>
            <Text style={styles.compareLabelText}>ENHANCED</Text>
          </View>
        </View>
        {/* Controls */}
        <View style={[styles.compareControls, { paddingTop: topPad + 8 }]}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setViewMode("grid")}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.compareTitle}>Before / After</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {prev && (
              <TouchableOpacity style={styles.iconBtn} onPress={() => { setCompareIdx(compareIdx - 1); setSliderX(W / 2); }}>
                <Ionicons name="chevron-back-circle-outline" size={24} color="#fff" />
              </TouchableOpacity>
            )}
            {next && (
              <TouchableOpacity style={styles.iconBtn} onPress={() => { setCompareIdx(compareIdx + 1); setSliderX(W / 2); }}>
                <Ionicons name="chevron-forward-circle-outline" size={24} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        </View>
        <View style={[styles.compareBottom, { paddingBottom: bottomPad + 16 }]}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleShare(currentComparePhoto)}>
            <Ionicons name="share-outline" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.modeTagRow}>
            <View style={styles.modeTag}>
              <Text style={styles.modeTagText}>{currentComparePhoto.mode}</Text>
            </View>
            {currentComparePhoto.filter !== "Natural" && (
              <View style={[styles.modeTag, { backgroundColor: "rgba(0,191,255,0.18)" }]}>
                <Text style={[styles.modeTagText, { color: "#00BFFF" }]}>{currentComparePhoto.filter}</Text>
              </View>
            )}
          </View>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "rgba(239,68,68,0.2)" }]} onPress={() => handleDelete(currentComparePhoto)}>
            <Ionicons name="trash-outline" size={22} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Grid View ──
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>glory cam</Text>
        <View style={styles.headerRight}>
          <Text style={styles.photoCount}>{photos.length} photos</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <MaterialCommunityIcons name="camera-iris" size={40} color="#00BFFF" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      ) : photos.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="camera-outline" size={56} color="#333" />
          <Text style={styles.emptyTitle}>No photos yet</Text>
          <Text style={styles.emptySub}>Take your first photo with Glory Cam</Text>
          <TouchableOpacity style={styles.shootBtn} onPress={() => router.back()}>
            <Ionicons name="camera" size={18} color="#000" />
            <Text style={styles.shootBtnText}>Open Camera</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={photos}
          keyExtractor={(item) => item.id}
          numColumns={3}
          contentContainerStyle={{ paddingBottom: bottomPad + 16 }}
          columnWrapperStyle={{ gap: 1.5 }}
          ItemSeparatorComponent={() => <View style={{ height: 1.5 }} />}
          scrollEnabled={!!photos.length}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => setSelected(item)} activeOpacity={0.88} style={{ width: THUMB, height: THUMB }}>
              <Image source={{ uri: item.processedUri }} style={{ width: "100%", height: "100%" }} />
              {item.mode === "NIGHT" && (
                <View style={styles.nightTag}>
                  <Ionicons name="moon" size={10} color="#FFD700" />
                </View>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      {/* Full-screen Photo Modal */}
      <Modal visible={!!selected} transparent animationType="fade">
        {selected && (
          <View style={styles.modalBg}>
            {/* Swipe to close */}
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelected(null)} />
            <Image source={{ uri: selected.processedUri }} style={styles.fullImg} resizeMode="contain" />
            {/* Top controls */}
            <View style={[styles.modalTop, { paddingTop: topPad + 8 }]}>
              <TouchableOpacity style={styles.iconBtn} onPress={() => setSelected(null)}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
              <View style={styles.modalTags}>
                <View style={styles.modeTag}>
                  <Text style={styles.modeTagText}>{selected.mode}</Text>
                </View>
                {selected.filter !== "Natural" && (
                  <View style={[styles.modeTag, { backgroundColor: "rgba(0,191,255,0.2)" }]}>
                    <Text style={[styles.modeTagText, { color: "#00BFFF" }]}>{selected.filter}</Text>
                  </View>
                )}
              </View>
            </View>
            {/* Bottom controls */}
            <View style={[styles.modalBottom, { paddingBottom: bottomPad + 16 }]}>
              <TouchableOpacity style={styles.actionBtn} onPress={() => handleShare(selected)}>
                <Ionicons name="share-outline" size={22} color="#fff" />
                <Text style={styles.actionLabel}>Share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: "rgba(0,191,255,0.15)", borderColor: "rgba(0,191,255,0.3)" }]}
                onPress={() => openCompare(selected)}
              >
                <MaterialCommunityIcons name="compare" size={22} color="#00BFFF" />
                <Text style={[styles.actionLabel, { color: "#00BFFF" }]}>Compare</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "rgba(239,68,68,0.15)", borderColor: "rgba(239,68,68,0.3)" }]} onPress={() => handleDelete(selected)}>
                <Ionicons name="trash-outline" size={22} color="#ef4444" />
                <Text style={[styles.actionLabel, { color: "#ef4444" }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  headerTitle: { color: "#fff", fontSize: 15, fontWeight: "600", letterSpacing: 1.5, fontFamily: "Inter_600SemiBold" },
  headerRight: { minWidth: 60, alignItems: "flex-end" },
  photoCount: { color: "rgba(255,255,255,0.4)", fontSize: 12, fontFamily: "Inter_400Regular" },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center" },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "rgba(255,255,255,0.4)", fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 },
  emptyTitle: { color: "#fff", fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold" },
  emptySub: { color: "rgba(255,255,255,0.45)", fontSize: 14, textAlign: "center", fontFamily: "Inter_400Regular" },
  shootBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#00BFFF", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 28 },
  shootBtnText: { color: "#000", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
  nightTag: { position: "absolute", top: 4, right: 4, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 6, padding: 3 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.97)", justifyContent: "center" },
  fullImg: { width: W, height: H },
  modalTop: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, zIndex: 10 },
  modalTags: { flexDirection: "row", gap: 6 },
  modeTag: { backgroundColor: "rgba(255,255,255,0.12)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  modeTagText: { color: "#fff", fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold", letterSpacing: 0.8 },
  modalBottom: { position: "absolute", bottom: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-evenly", paddingHorizontal: 24, paddingTop: 12, zIndex: 10 },
  actionBtn: { alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.1)", paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  actionLabel: { color: "#fff", fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  compareContainer: { flex: 1 },
  compareImg: { width: W, height: H, position: "absolute" },
  divider: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: "#fff" },
  dividerHandle: { position: "absolute", top: "45%", width: 36, height: 36, borderRadius: 18, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 8, elevation: 8 },
  compareLabel: { position: "absolute", top: "8%", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  compareLabelText: { color: "#fff", fontSize: 11, fontWeight: "700", fontFamily: "Inter_700Bold", letterSpacing: 1 },
  compareControls: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, zIndex: 20 },
  compareTitle: { color: "#fff", fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold", letterSpacing: 1 },
  compareBottom: { position: "absolute", bottom: 0, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 24, paddingTop: 12, zIndex: 20 },
  modeTagRow: { flexDirection: "row", gap: 6 },
  permContainer: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32 },
  permTitle: { color: "#fff", fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold" },
  permSub: { color: "rgba(255,255,255,0.5)", fontSize: 14, textAlign: "center", fontFamily: "Inter_400Regular" },
  permBtn: { marginTop: 8, backgroundColor: "#00BFFF", paddingHorizontal: 32, paddingVertical: 13, borderRadius: 28 },
  permBtnText: { color: "#000", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
});
