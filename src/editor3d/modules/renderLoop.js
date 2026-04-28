export function createRenderLoop(ctx) {
  const {
    state,
    camera,
    controls,
    dirLight,
    fitDirectionalShadowFrustum,
    floorplanDepthPrepassMat,
    floorplanRoot,
    furnitureRoot,
    getFloorsFromEntry,
    grid,
    renderer,
    scene,
    tmpVecA,
    tmpVecB,
    tmpVecC,
  } = ctx;

  /**
   * 是否存在「户型需按半透明处理」的楼层（非 1 不透明）：此时用分层渲染（深度预写入 + 颜色）稳定遮挡。
   * 注意：多遍合成会让整幅画面偏暗，易被误认为环境光变弱。以下情况不要走多遍：
   * - 仅调当前层透明度（见上条提交）；
   * - 再次点击当前楼层 Tab 取消选中（floorSelectionEnabled=false）：单层户型时全层 0.2 透明度，若再用「非楼层选中」单独触发多遍，会不必要地压暗画面；
   * 多遍仅保留：多层同时可见且其它层为半透明（与 hideOtherFloors / otherLayersOpacity 一致）等真正需要稳定排序的情形。
   */
  function floorplanNeedsTranslucentPass() {
    if (!floorplanRoot.children.length) return false;
    const floors = getFloorsFromEntry(state.currentFloorplanEntry);
    const n = floors?.length ?? 0;
    if (n > 1 && !state.hideOtherFloors && state.otherLayersOpacity < 1 - 1e-4) return true;
    return false;
  }

  /**
   * 窗玻璃、玻璃门扇等「应透视后方」的 mesh 不参与深度预写入：否则 MeshDepthMaterial 在玻璃表面写入深度，
   * 第三遍里室内墙等更远半透明片深度测试失败，透过窗洞看不见室内。
   */
  function skipFloorplanDepthPrepassMesh(obj) {
    if (obj.userData.floorplanWindowFill) return true;
    if (obj.userData.floorplanDoorFill && obj.userData.floorplanDoorStyle?.isGlass) return true;
    const m = obj.material;
    const mats = Array.isArray(m) ? m : m ? [m] : [];
    for (let i = 0; i < mats.length; i++) {
      const sub = mats[i];
      if (sub?.isMeshPhysicalMaterial && Number(sub.transmission) > 0.02) return true;
    }
    return false;
  }

  /**
   * 分层渲染：先画家具+网格（不含户型），再仅对户型做深度预写入（不写颜色），最后画户型半透明颜色。
   * 用 visible 排除户型/家具；多遍 render 时须暂时去掉 scene.background（Color）：
   * Three.js WebGLBackground 在 background 为 Color 时会 forceClear，无视 autoClear=false，会整屏清空抹掉第一遍。
   */
  function renderEditorScene() {
    const prevAutoClear = renderer.autoClear;
    const prevBackground = scene.background;
    try {
      if (!floorplanNeedsTranslucentPass()) {
        renderer.autoClear = true;
        renderer.render(scene, camera);
        return;
      }
      const saved = [];
      renderer.autoClear = true;
      floorplanRoot.visible = false;
      renderer.render(scene, camera);
      floorplanRoot.visible = true;
      furnitureRoot.visible = false;
      grid.visible = false;
      renderer.autoClear = false;
      scene.background = null;
      floorplanRoot.traverse((obj) => {
        if (!obj.isMesh || obj.isSkinnedMesh) return;
        if (skipFloorplanDepthPrepassMesh(obj)) return;
        saved.push({ obj, material: obj.material });
        obj.material = floorplanDepthPrepassMat;
      });
      renderer.render(scene, camera);
      for (let i = 0; i < saved.length; i++) {
        saved[i].obj.material = saved[i].material;
      }
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      scene.background = prevBackground;
      furnitureRoot.visible = true;
      grid.visible = state.gridVisible;
      floorplanRoot.visible = true;
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    dirLight.updateMatrixWorld(true);
    fitDirectionalShadowFrustum();
    renderEditorScene();
  }

  return {
    animate,
    floorplanNeedsTranslucentPass,
    renderEditorScene,
    skipFloorplanDepthPrepassMesh,
  };
}
