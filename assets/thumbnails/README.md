# 家具预览图（家具库缩略图）

与 `data/furniture/furnitureLibrary.json` 中每条家具的 **`id`** 对应，放入同名的图片文件即可在侧栏家具库中显示。

## 命名约定（默认）

将文件放在本目录下，文件名 = 家具 `id` + 扩展名（按顺序尝试加载）：

| 优先级 | 示例（id 为 `sofa_001`） |
|--------|---------------------------|
| 1 | `sofa_001.webp` |
| 2 | `sofa_001.png` |
| 3 | `sofa_001.jpg` |
| 4 | `sofa_001.jpeg` |

推荐 **WebP**（体积小、清晰）。若某 `id` 没有任何匹配文件，界面会保留原来的彩色占位块。

## JSON 自定义路径（可选）

在单条家具数据里增加 **`thumbnail`** 字段，可指向任意相对站点根目录的路径，例如：

```json
"thumbnail": "assets/thumbnails/custom/sofa_hero.webp"
```

## 建议尺寸

约 **512×512** 或 **4:3** 裁切；侧栏格子内会以 `object-fit: cover` 显示。
