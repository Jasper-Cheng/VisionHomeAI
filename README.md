# VisionHomeAI

## 目录结构

```
├── assets/
│   ├── models/           # GLB 家具模型
│   ├── thumbnails/       # 家具库卡片预览图（与 furniture id 同名；路径见 data/furniture 内 JSON 的 thumbnail）
│   ├── textures/         # 贴图（可选）
│   └── vendor/           # three.js、OrbitControls 等
├── data/
│   ├── floorplans/       # 户型库 manifest.json + 同目录各 <id>.json
│   ├── furniture/        # 家具库 manifest.json + 同目录各 <id>.json
│   └── design/           # 用户方案 JSON（户型模板 + 家具编辑）+ manifest.json
├── src/
│   ├── core/             # schema、catalogLoader（manifest + 多文件加载）
│   ├── editor2d/         # 2D / SVG（svgEditor.js + renderer 占位）
│   ├── editor3d/         # 3D（viewer.js + loader 占位）
│   ├── floorplan/        # 户型库加载与侧栏挂载
│   ├── furniture/        # 家具库、SVG 样式
│   ├── files/            # 设计文件清单加载与侧栏挂载
│   └── utils/
├── index.html
├── user.html
└── styles.css
```

## 本地运行

```bash
python3 -m http.server 8080
```

打开 http://localhost:8080

## 数据说明

- **户型库**：`data/floorplans/manifest.json` 的 **`files`**（如 `apartment_2b1l.json`）→ 与同目录下的 **`data/floorplans/<文件>`** 一一对应。新增户型：在该目录增加 `<id>.json`，并把文件名写入 manifest。工程里 **`templateId`** 对应条目的 **`id`**。
- **家具库**：`data/furniture/manifest.json` + 同目录 **`data/furniture/<id>.json`**；侧栏预览仅当该条配置了 **`thumbnail`** 时加载图片，否则为骨架占位；平面图中 `data-model` 为 **`id`**。
- **设计文件（方案）**：`data/design/*.json` 表示在**户型库某一模板**上的**家具编辑会话**，不重复存整套户型几何。
  - **`templateId`**：对应 `data/floorplans/<id>.json` 中条目的 **`id`**（与文件名一致，如 `apartment_2b1l`）。加载方案时先取该户型，再叠本文件中的编辑层。
  - **`floorplanSnapshot`**：可选；若用户对墙线等做了覆盖，可存于此（当前可为 `null`）。
  - **`furnitureInstances`**：家具实例（`furnitureId` 对应 `data/furniture/` 条目 **`id`**、`floorId` 与户型楼层对应等）。
  - 未选户型时 **`templateId`** 可为 `null`（空方案）。
  - 侧栏列表：读 **`data/design/manifest.json`** 的 **`files`**，再 `fetch data/design/<文件名>`。
  - **`id`** 与 **`name`**：每条方案须有唯一 **`id`**；**文件名必须为 `<id>.json`**（与 manifest 中 `files` 一致）。**`name`** 为侧栏展示标题。
  - 兼容旧数据：若仅有 **`projectId`** 而无 **`id`**，加载逻辑会回退使用 `projectId`。
- 示例：`data/design/project_001.json`（`id`: `project_001`，绑定 `apartment_2b1l` + 示例沙发实例）。
