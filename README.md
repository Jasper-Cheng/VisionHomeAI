# VisionHomeAI

## 目录结构

```
├── assets/
│   ├── models/           # GLB 家具模型
│   ├── thumbnails/       # 家具库卡片预览图（与 furniture id 同名；路径见 furnitureLibrary.thumbnail）
│   ├── textures/         # 贴图（可选）
│   └── vendor/           # three.js、OrbitControls 等
├── data/
│   ├── floorPlanLibrary.json   # 户型库（floorPlanLibrary）
│   ├── furnitureLibrary.json   # 家具库
│   └── design/           # 方案 / 工程 JSON + manifest.json（侧栏「设计文件」列表）
├── src/
│   ├── core/             # schema 等
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

- 户型库：`data/floorPlanLibrary.json`（`floorPlanLibrary` 数组；工程里 **`templateId`** 对应条目的 **`id`**）
- 家具库：`data/furnitureLibrary.json`（启动时 `fetch` 解析；侧栏预览仅当该条配置了 **`thumbnail`** 时加载图片，否则为骨架占位；平面图中 `data-model` 为 **`id`**）
- 设计文件侧栏：读取 **`data/design/manifest.json`** 中的 **`files`** 数组（如 `project_001.json`），再逐个 `fetch data/design/<文件名>`；新增方案时请把 JSON 文件名加入 manifest。
- 示例方案：`data/design/project_001.json`（侧栏标题为**文件名**；字段 **`templateId`** 对应 `floorPlanLibrary` 中条目的 **`id`**）
