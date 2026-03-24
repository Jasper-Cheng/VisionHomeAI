# 家具预览图（家具库缩略图）

与 `data/furniture/furnitureLibrary.json` 中每条家具的 **`id`** 对应，放入同名的图片文件即可在侧栏家具库中显示。

## 在 furnitureLibrary.json 中配置（必须）

侧栏**不会**再按 `id` 自动猜路径。仅在每条家具里写了 **`thumbnail`** 时才会加载预览图；未写则只显示彩色骨架占位。

将预览文件放在本目录（或站点内任意静态路径），在 JSON 中写相对站点根的路径，例如：

```json
"thumbnail": "assets/thumbnails/sofa_001.svg"
```

可使用 **SVG / WebP / PNG / JPG** 等。路径错误或文件缺失时，该卡片仍显示骨架占位。

## 建议尺寸

约 **512×512** 或 **4:3** 裁切；侧栏格子内会以 `object-fit: cover` 显示。
