/**
 * 风格包未配置 sceneLighting 时的默认曝光与灯光（偏中性）。
 * 户型风格包 `assets/floorplans/style/<floorplanId>.json` 中 `styles.<key>.sceneLighting` 可覆盖全局光照。
 */
export const DEFAULT_SCENE_LIGHTING = {
  toneMappingExposure: 1.0,
  ambient: { color: "#ffffff", intensity: 0.26 },
  hemisphere: { sky: "#dbeafe", ground: "#0b1220", intensity: 0.36 },
  directional: { color: "#ffffff", intensity: 1.0 },
  envMapIntensity: 0.35,
};

/**
 * @param {object | null | undefined} over 风格 JSON 中的 sceneLighting
 */
export function mergeSceneLighting(over) {
  const base = DEFAULT_SCENE_LIGHTING;
  if (!over || typeof over !== "object") {
    return {
      toneMappingExposure: base.toneMappingExposure,
      ambient: { ...base.ambient },
      hemisphere: { ...base.hemisphere },
      directional: { ...base.directional },
      envMapIntensity: base.envMapIntensity,
    };
  }
  return {
    toneMappingExposure: Number.isFinite(Number(over.toneMappingExposure))
      ? Number(over.toneMappingExposure)
      : base.toneMappingExposure,
    ambient: { ...base.ambient, ...(typeof over.ambient === "object" && over.ambient ? over.ambient : {}) },
    hemisphere: {
      ...base.hemisphere,
      ...(typeof over.hemisphere === "object" && over.hemisphere ? over.hemisphere : {}),
    },
    directional: {
      ...base.directional,
      ...(typeof over.directional === "object" && over.directional ? over.directional : {}),
    },
    envMapIntensity: Number.isFinite(Number(over.envMapIntensity))
      ? Number(over.envMapIntensity)
      : base.envMapIntensity,
  };
}

function applyHexToThreeColor(threeColor, hex, fallbackHexNum) {
  const s = String(hex ?? "").trim();
  try {
    threeColor.setStyle(s.startsWith("#") ? s : `#${s}`);
  } catch {
    threeColor.setHex(fallbackHexNum);
  }
}

/**
 * @param {import("three").WebGLRenderer} renderer
 * @param {import("three").AmbientLight} ambientLight
 * @param {import("three").HemisphereLight} hemiLight
 * @param {import("three").DirectionalLight} dirLight
 * @param {ReturnType<typeof mergeSceneLighting>} cfg
 */
export function applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, cfg) {
  if (!cfg) return;
  const exp = cfg.toneMappingExposure;
  if (Number.isFinite(exp)) renderer.toneMappingExposure = exp;

  const amb = cfg.ambient;
  if (amb) {
    applyHexToThreeColor(ambientLight.color, amb.color, 0xffffff);
    const ai = Number(amb.intensity);
    if (Number.isFinite(ai)) ambientLight.intensity = ai;
  }

  const hemi = cfg.hemisphere;
  if (hemi) {
    const sky = hemi.sky ?? hemi.skyColor;
    const ground = hemi.ground ?? hemi.groundColor;
    applyHexToThreeColor(hemiLight.color, sky, 0xffffff);
    applyHexToThreeColor(hemiLight.groundColor, ground, 0x0b1220);
    const hi = Number(hemi.intensity);
    if (Number.isFinite(hi)) hemiLight.intensity = hi;
  }

  const dir = cfg.directional;
  if (dir) {
    applyHexToThreeColor(dirLight.color, dir.color, 0xffffff);
    const di = Number(dir.intensity);
    if (Number.isFinite(di)) dirLight.intensity = di;
  }
}
