# 户型模板

- **`floorPlanLibrary.json`**：所有户型模板的合集，根字段为 **`floorPlanLibrary`**（数组）。
- 每条模板包含：
  - **`id`**：稳定标识，工程文件里用 **`templateId`** 引用（如 `apartment_2b1l`）。
  - **`project`**：名称、分类、面积等元数据。
  - **`floors`**、**`connections`**：几何与楼层关系（与原单文件结构相同）。

侧栏「户型库」列表由前端 `fetch` 该文件后动态生成。
