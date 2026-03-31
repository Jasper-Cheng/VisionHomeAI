# VisionHomeAI

## 目录结构

```
├── assets/
│   ├── data/
│   │   ├── floorplans/   # 户型库 manifest.json + 同目录各 <id>.json
│   │   ├── furniture/    # 家具库 manifest.json + 同目录各 <id>.json
│   │   └── design/       # 用户方案 JSON（户型模板 + 家具编辑）+ manifest.json
│   ├── models/           # GLB 家具模型
│   ├── thumbnails/       # 家具库卡片预览图（与 furniture id 同名；路径见 assets/data/furniture 内 JSON 的 thumbnail）
│   ├── textures/         # 贴图（可选）
│   └── vendor/           # three.js、OrbitControls 等
├── src/
│   ├── core/             # schema、catalogLoader（manifest + 多文件加载）
│   ├── editor3d/         # 3D 编辑（editEditor.js + viewer.js）
│   ├── floorplan/        # 户型库加载与侧栏挂载
│   ├── furniture/        # 家具库、SVG 样式
│   ├── files/            # 设计文件清单加载与侧栏挂载
│   └── utils/
├── index.html
├── user.html
└── styles.css
```

## 本地运行

**必须在项目根目录（含 `index.html` 的 `VisionHomeAI` 文件夹）启动**，并用 **http://** 访问；**不要**用资源管理器双击 HTML（`file://` 下 ES Module 不会运行，页面会无交互、控制台常无脚本日志）。

```bash
cd /path/to/VisionHomeAI
python3 -m http.server 8080
```

**保存方案到仓库内 `assets/data/design/`**（写入 JSON 并更新 `manifest.json`）请使用开发服务：

```bash
python3 dev_server.py
```

默认端口与上面相同为 **8080**（可用环境变量 `PORT` 修改）。浏览器打开：**http://localhost:8080/index.html**（或根路径 `/`）。若用 `file://` 打开或主脚本 404，页面顶部会出现提示条。

## 数据说明

- **户型库**：`assets/data/floorplans/manifest.json` 的 **`files`**（如 `apartment_2b1l.json`）→ 与同目录下的 **`assets/data/floorplans/<文件>`** 一一对应。新增户型：在该目录增加 `<id>.json`，并把文件名写入 manifest。工程里 **`templateId`** 对应条目的 **`id`**。
- **家具库**：`assets/data/furniture/manifest.json` + 同目录 **`assets/data/furniture/<id>.json`**；侧栏预览仅当该条配置了 **`thumbnail`** 时加载图片，否则为骨架占位；平面图中 `data-model` 为 **`id`**。
- **设计文件（方案）**：`assets/data/design/*.json` 表示在**户型库某一模板**上的**家具编辑会话**，不重复存整套户型几何。
  - **`schemaVersion`**：`"1.1"` 起包含 **`svgEditor`**，用于点击侧栏方案时还原户型与家具布局。旧版 `"1.0"` 无 `svgEditor` 时，仍用 **`templateId` + `furnitureInstances`** 还原。
  - **`templateId`**：对应 `assets/data/floorplans/<id>.json` 中条目的 **`id`**；保存时若画布上有户型，会与当前 **`svgEditor.floorPlanId`** 对齐。
  - **`svgEditor`**（`version: 1`）：**`floorPlanId`**、**`floorLevelIndex`**、**`furniture`**（`model` / `x` / `y` / `rotation`）；视图平移/缩放与网格不写入方案文件，打开时使用当前编辑器默认视图（网格状态与打开前一致）。
  - **`floorplanSnapshot`**：可选；若用户对墙线等做了覆盖，可存于此（当前可为 `null`）。
  - **`furnitureInstances`**：与 3D / 会话字段对齐的家具列表；保存时与 `svgEditor.furniture` 同源生成，便于旧逻辑与导出。
  - 未选户型时 **`templateId`** / **`svgEditor.floorPlanId`** 可为 `null`（空方案）。
  - 侧栏列表：读 **`assets/data/design/manifest.json`** 的 **`files`**，再 `fetch assets/data/design/<文件名>`。
  - **`id`** 与 **`name`**：每条方案须有唯一 **`id`**；**文件名必须为 `<id>.json`**（与 manifest 中 `files` 一致）。**`name`** 为侧栏展示标题。
  - 兼容旧数据：若仅有 **`projectId`** 而无 **`id`**，加载逻辑会回退使用 `projectId`。
- 示例：`assets/data/design/project_001.json`（`id`: `project_001`，绑定 `apartment_2b1l` + 示例沙发实例）。
