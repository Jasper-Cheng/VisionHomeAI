export const DOOR_TYPES = {
  hinged: {
    id: "hinged",
    name: "平开门",
    panelMode: "swing",
  },
  sliding: {
    id: "sliding",
    name: "推拉门",
    panelMode: "sliding",
  },
  barn: {
    id: "barn",
    name: "谷仓门",
    panelMode: "barn",
  },
  pocket: {
    id: "pocket",
    name: "口袋门",
    panelMode: "sliding",
  },
  folding: {
    id: "folding",
    name: "折叠门",
    panelMode: "folding",
  },
  double_hinged: {
    id: "double_hinged",
    name: "双开门",
    panelMode: "double_swing",
  },
};

const LEGACY_DOOR_TYPE_MAP = {
  entrance: "hinged",
  interior: "hinged",
  balcony: "sliding",
  sliding: "sliding",
  barn: "barn",
  pocket: "pocket",
  folding: "folding",
  double: "double_hinged",
  double_hinged: "double_hinged",
};

export function normalizeDoorTypeId(raw, fallbackRaw) {
  const direct = String(raw ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DOOR_TYPES, direct)) return direct;
  if (Object.prototype.hasOwnProperty.call(LEGACY_DOOR_TYPE_MAP, direct)) return LEGACY_DOOR_TYPE_MAP[direct];

  const fallback = String(fallbackRaw ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DOOR_TYPES, fallback)) return fallback;
  if (Object.prototype.hasOwnProperty.call(LEGACY_DOOR_TYPE_MAP, fallback)) return LEGACY_DOOR_TYPE_MAP[fallback];
  return "hinged";
}

export function getDoorTypeDef(door) {
  const id = normalizeDoorTypeId(door?.doorType ?? door?.doorTypeId ?? door?.panelType, door?.type);
  return DOOR_TYPES[id] || DOOR_TYPES.hinged;
}
