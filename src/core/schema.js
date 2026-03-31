/**
 * 数据路径与版本约定（JSON 位于 assets/data/，与 models/thumbnails 等同属 assets）
 */
export const DATA_PATHS = {
  /** 户型库：manifest.json 与同目录下各 <id>.json */
  floorplansManifest: "assets/data/floorplans/manifest.json",
  floorplansDir: "assets/data/floorplans",
  /** 家具库：manifest.json 与同目录下各 <id>.json（可选 tags: string[] 供属性面板展示） */
  furnitureManifest: "assets/data/furniture/manifest.json",
  furnitureDir: "assets/data/furniture",
  /**
   * 用户方案目录：每条 JSON = 选定户型模板（templateId → floorplans）+ 家具编辑层（furnitureInstances 等）
   */
  design: "assets/data/design",
  /** 方案清单（静态站无法枚举目录；新方案请把文件名写入 files） */
  designManifest: "assets/data/design/manifest.json",
  /** 本地开发服务器 scripts/dev_server.py 提供的保存接口（同源 POST） */
  designSaveApi: "/api/design/save",
  assetsModels: "assets/models",
  assetsTextures: "assets/textures",
  /** 家具库卡片预览：`assets/thumbnails/{id}.webp|png|jpg` */
  assetsThumbnails: "assets/thumbnails",
};

export const SCHEMA_VERSION = "1.0";
