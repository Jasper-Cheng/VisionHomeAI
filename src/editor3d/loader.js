/**
 * GLB / glTF 加载（用于家具目录 `model` 字段）
 */
import { GLTFLoader } from "../../assets/vendor/GLTFLoader.js";

/**
 * @param {string} url 相对站点根的路径，如 ./assets/models/foo.glb
 */
export function loadGlbModel(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      (err) => reject(err),
    );
  });
}
