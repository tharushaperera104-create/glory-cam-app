import AsyncStorage from "@react-native-async-storage/async-storage";

export type PhotoRecord = {
  id: string;
  processedUri: string;
  originalUri: string;
  timestamp: number;
  mode: string;
  filter: string;
};

const KEY = "@glorycam_photos_v2";

export async function getPhotos(): Promise<PhotoRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PhotoRecord[]) : [];
  } catch {
    return [];
  }
}

export async function addPhoto(record: PhotoRecord): Promise<void> {
  const photos = await getPhotos();
  photos.unshift(record);
  await AsyncStorage.setItem(KEY, JSON.stringify(photos.slice(0, 500)));
}

export async function deletePhoto(id: string): Promise<void> {
  const photos = await getPhotos();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(photos.filter((p) => p.id !== id))
  );
}
