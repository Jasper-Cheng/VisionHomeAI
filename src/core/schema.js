/**
 * 数据路径与版本约定（与 data/ 下 JSON 对齐）
 */
export const DATA_PATHS = {
  /** 户型库（单文件，内含 floorPlanLibrary 数组） */
  floorPlanLibrary: "data/floorPlanLibrary.json",
  furnitureLibrary: "data/furnitureLibrary.json",
  /** 方案 / 工程 JSON 目录 */
  design: "data/design",
  /** 目录内设计文件清单（静态站无法枚举文件夹，新增方案时请把文件名加入此列表） */
  designManifest: "data/design/manifest.json",
  assetsModels: "assets/models",
  assetsTextures: "assets/textures",
  /** 家具库卡片预览：`assets/thumbnails/{id}.webp|png|jpg` */
  assetsThumbnails: "assets/thumbnails",
};

export const SCHEMA_VERSION = "1.0";
