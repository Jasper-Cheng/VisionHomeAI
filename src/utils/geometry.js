/** 多边形面积（鞋带公式），顶点 [x,y][] */
export function polygonAreaMm2(polygon) {
  if (!polygon || polygon.length < 3) return 0;
  let s = 0;
  for (let i = 0, n = polygon.length; i < n; i++) {
    const j = (i + 1) % n;
    s += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
  }
  return Math.abs(s / 2);
}
