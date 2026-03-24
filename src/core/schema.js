/**
 * 数据路径与版本约定（与 data/ 下 JSON 对齐）
 */
export const DATA_PATHS = {
  /** 户型库：manifest.json 与同目录下各 <id>.json */
  floorplansManifest: "data/floorplans/manifest.json",
  floorplansDir: "data/floorplans",
  /** 家具库：manifest.json 与同目录下各 <id>.json */
  furnitureManifest: "data/furniture/manifest.json",
  furnitureDir: "data/furniture",
  /**
   * 用户方案目录：每条 JSON = 选定户型模板（templateId → floorplans）+ 家具编辑层（furnitureInstances 等）
   */
  design: "data/design",
  /** 方案清单（静态站无法枚举目录；新方案请把文件名写入 files） */
  designManifest: "data/design/manifest.json",
  assetsModels: "assets/models",
  assetsTextures: "assets/textures",
  /** 家具库卡片预览：`assets/thumbnails/{id}.webp|png|jpg` */
  assetsThumbnails: "assets/thumbnails",
};

export const SCHEMA_VERSION = "1.0";
