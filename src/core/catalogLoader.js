/**
 * 从 manifest.json + 同目录（或指定 base 目录）下的条目 JSON 加载（静态站无法列目录）
 * @param {{ manifestUrl: string, itemsBaseUrl: string }} opts
 * @returns {Promise<object[]>} 按 manifest.files 顺序排列的条目
 */
export async function loadItemsFromManifest(opts) {
  const { manifestUrl, itemsBaseUrl } = opts;
  const base = String(itemsBaseUrl || "").replace(/\/+$/, "");

  const manRes = await fetch(manifestUrl, { cache: "no-store" });
  if (!manRes.ok) throw new Error(`catalog manifest fetch failed: ${manifestUrl}`);
  const data = await manRes.json();
  const files = Array.isArray(data?.files) ? data.files.map((f) => String(f).trim()).filter(Boolean) : [];

  const results = await Promise.allSettled(
    files.map(async (fname) => {
      const clean = fname.replace(/^\/+/, "");
      const url = `${base}/${encodeURIComponent(clean)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`catalog item fetch failed: ${url}`);
      return res.json();
    }),
  );

  /** @type {object[]} */
  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(r.value);
    else console.warn("[VisionHomeAI] 目录条目跳过:", files[i], r.reason);
  });

  return items;
}
