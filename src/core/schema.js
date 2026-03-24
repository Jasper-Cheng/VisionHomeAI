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
