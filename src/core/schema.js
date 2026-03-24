/**
 * 数据路径与版本约定（与 data/ 下 JSON 对齐）
 */
export const DATA_PATHS = {
  /** 户型模板合集（单文件，内含 floorPlanLibrary 数组） */
  floorPlanLibrary: "data/templates/floorPlanLibrary.json",
  furnitureLibrary: "data/furniture/furnitureLibrary.json",
  projects: "data/projects",
  assetsModels: "assets/models",
  assetsTextures: "assets/textures",
  /** 家具库卡片预览：`assets/thumbnails/{id}.webp|png|jpg` */
  assetsThumbnails: "assets/thumbnails",
};

export const SCHEMA_VERSION = "1.0";
