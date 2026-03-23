# 家具预览图（家具库缩略图）

与 `data/furniture/furnitureLibrary.json` 中每条家具的 **`id`** 对应，放入同名的图片文件即可在侧栏家具库中显示。

## 命名约定（默认）

将文件放在本目录下，文件名 = 家具 `id` + 扩展名（按顺序尝试加载）：

| 优先级 | 示例（id 为 `sofa_001`） |
|--------|---------------------------|
| 1 | `sofa_001.svg`（默认示例为矢量图，优先请求以减少 404） |
| 2 | `sofa_001.webp` |
| 3 | `sofa_001.png` |
| 4 | `sofa_001.jpg` |
| 5 | `sofa_001.jpeg` |

**说明**：若同一 `id` 同时放了 `svg` 和 `webp`，会优先显示 **svg**。若要以 **WebP/PNG** 为准，请删除同名 `svg`，或在 `furnitureLibrary.json` 里为该条填写 **`thumbnail`** 指向你的位图路径。

推荐实拍用 **WebP**（体积小、清晰）。**SVG** 适合简单示意或占位；若某 `id` 没有任何匹配文件，界面会保留原来的彩色占位块。

## JSON 自定义路径（可选）

在单条家具数据里增加 **`thumbnail`** 字段，可指向任意相对站点根目录的路径，例如：

```json
"thumbnail": "assets/thumbnails/custom/sofa_hero.webp"
```

## 建议尺寸

约 **512×512** 或 **4:3** 裁切；侧栏格子内会以 `object-fit: cover` 显示。
