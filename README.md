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
│   └── design/           # 方案 / 工程 JSON + manifest.json（侧栏「设计文件」列表）
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
- **设计文件**侧栏：读取 **`data/design/manifest.json`** 的 **`files`**，再 `fetch data/design/<文件名>`。
- 示例方案：`data/design/project_001.json`（侧栏标题为**文件名**；字段 **`templateId`** 对应户型条目的 **`id`**）。
