/**
 * 图片选择封装（expo-image-picker）：相册/相机 → base64
 *
 * 返回 { data: base64, mime }，供 ChatComposer 附加后随 prompt 发送。
 */
import * as ImagePicker from "expo-image-picker";

export interface PickResult {
  data: string;
  mime: string;
}

/** 请求权限 + 打开相册选图（可多选），返回 base64 列表 */
export async function pickImagesFromLibrary(maxCount = 3): Promise<PickResult[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: maxCount > 1,
    selectionLimit: maxCount,
    base64: true,
    quality: 0.8,
  });
  if (result.canceled) return [];

  return result.assets
    .filter((a) => a.base64)
    .map((a) => ({
      data: a.base64!,
      mime: a.mimeType ?? "image/jpeg",
    }));
}

/** 拍一张照片 */
export async function takePhoto(): Promise<PickResult | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;

  const result = await ImagePicker.launchCameraAsync({
    base64: true,
    quality: 0.8,
  });
  if (result.canceled || !result.assets[0]?.base64) return null;
  const a = result.assets[0];
  return { data: a.base64!, mime: a.mimeType ?? "image/jpeg" };
}

/** 询问用户选择方式：相册 / 相机（App 层用 Alert 实现） */
export function resolvePickAction(useCamera: boolean): Promise<PickResult | null> {
  return useCamera ? takePhoto() : Promise.resolve(null);
}