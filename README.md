# VisionHomeAI

## 目录结构

```
├── assets/
│   ├── models/           # GLB 家具模型
│   ├── textures/         # 贴图（可选）
│   └── vendor/           # three.js、OrbitControls 等
├── data/
│   ├── templates/        # 户型模板（初始化）
│   ├── furniture/        # furnitureLibrary.json
│   └── projects/         # 用户保存的工程 JSON
├── src/
│   ├── core/             # projectManager、schema
│   ├── editor2d/         # 2D / SVG（svgEditor.js + renderer 占位）
│   ├── editor3d/         # 3D（viewer.js + loader 占位）
│   ├── furniture/        # 家具管理、碰撞、吸附（占位）
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

- 户型模板：`data/templates/apartment_2b1l.json`、`apartment_3b2l.json`、`villa_3floor.json`
- 家具库：`data/furniture/furnitureLibrary.json`（启动时 `fetch` 解析，动态生成侧栏分类 Tab 与家具卡片；平面图中 `data-model` 为条目的 `id`，如 `sofa_001`）
- 示例工程：`data/projects/project_001.json`
