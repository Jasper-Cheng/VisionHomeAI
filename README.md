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
│   └── design/           # 方案 / 工程 JSON
├── src/
│   ├── core/             # projectManager、schema
│   ├── editor2d/         # 2D / SVG（svgEditor.js + renderer 占位）
│   ├── editor3d/         # 3D（viewer.js + loader 占位）
│   ├── floorplan/        # 户型库加载与侧栏挂载
│   ├── furniture/        # 家具库、SVG 样式
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
- 示例方案：`data/design/project_001.json`（字段 **`templateId`** 对应 `floorPlanLibrary` 中条目的 **`id`**）
