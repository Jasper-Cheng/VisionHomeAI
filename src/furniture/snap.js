/** 贴墙 / 网格吸附（占位） */
export function snapToGrid(value, gridSize) {
  return Math.round(value / gridSize) * gridSize;
}
