import type * as Cesium from 'cesium';

export const clampOrbitPitch = (pitch: number) =>
  Math.max((-Math.PI * 89.5) / 180, Math.min((-Math.PI * 5) / 180, pitch));
export function installOrbitControls(C: typeof Cesium, v: Cesium.Viewer) {
  const canvas = v.canvas,
    controller = v.scene.screenSpaceCameraController;
  controller.minimumZoomDistance = 10;
  controller.enableCollisionDetection = true;
  controller.maximumTiltAngle = C.Math.toRadians(85);
  controller.inertiaZoom = 0.55;
  controller.tiltEventTypes = [
    C.CameraEventType.PINCH,
    {
      eventType: C.CameraEventType.LEFT_DRAG,
      modifier: C.KeyboardEventModifier.CTRL,
    },
    {
      eventType: C.CameraEventType.RIGHT_DRAG,
      modifier: C.KeyboardEventModifier.CTRL,
    },
  ];
  let drag: {
    id: number;
    x: number;
    y: number;
    pivot: Cesium.Cartesian3;
    heading: number;
    pitch: number;
    range: number;
    inputs: boolean;
  } | null = null;
  const pick = (p: Cesium.Cartesian2) => {
    const ray = v.camera.getPickRay(p);
    return ray
      ? (v.scene.globe.pick(ray, v.scene) ?? v.camera.pickEllipsoid(p))
      : undefined;
  };
  function pose(pivot: Cesium.Cartesian3) {
    const matrix = C.Transforms.eastNorthUpToFixedFrame(pivot),
      inverse = C.Matrix4.inverseTransformation(matrix, new C.Matrix4()),
      local = C.Matrix4.multiplyByPoint(
        inverse,
        v.camera.positionWC,
        new C.Cartesian3(),
      );
    const horizontal = Math.hypot(local.x, local.y);
    return {
      heading:
        horizontal < 0.01 ? v.camera.heading : Math.atan2(-local.x, -local.y),
      pitch: clampOrbitPitch(-Math.atan2(local.z, horizontal)),
      range: Math.max(15, C.Cartesian3.magnitude(local)),
    };
  }
  function finish() {
    if (!drag) return;
    controller.enableInputs = drag.inputs;
    const id = drag.id;
    drag = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function down(e: PointerEvent) {
    if (e.button !== 1 || drag) return;
    const rect = canvas.getBoundingClientRect();
    const pivot =
      pick(new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)) ??
      pick(new C.Cartesian2(e.clientX - rect.left, e.clientY - rect.top));
    if (!pivot) return;
    e.preventDefault();
    e.stopPropagation();
    v.camera.cancelFlight();
    v.trackedEntity = undefined;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      pivot,
      ...pose(pivot),
      inputs: controller.enableInputs,
    };
    controller.enableInputs = false;
    canvas.setPointerCapture(e.pointerId);
  }
  function keepAboveGround() {
    if (v.isDestroyed()) return;
    const cart = v.camera.positionCartographic;
    if (cart.height > 20000) return;
    const ground = v.scene.globe.getHeight(cart);
    if (ground !== undefined && cart.height < ground + 10) {
      const direction = C.Cartesian3.clone(v.camera.directionWC),
        up = C.Cartesian3.clone(v.camera.upWC);
      v.camera.setView({
        destination: C.Cartesian3.fromRadians(
          cart.longitude,
          cart.latitude,
          ground + 10,
        ),
        orientation: { direction, up },
      });
      if (drag) {
        v.camera.lookAtWorldPosition(drag.pivot);
        Object.assign(drag, pose(drag.pivot));
      }
    }
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.heading -= (dx * 2 * Math.PI) / Math.max(300, canvas.clientWidth);
    drag.pitch = clampOrbitPitch(
      drag.pitch + (dy * Math.PI) / Math.max(300, canvas.clientHeight),
    );
    v.camera.lookAt(
      drag.pivot,
      new C.HeadingPitchRange(drag.heading, drag.pitch, drag.range),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    keepAboveGround();
    v.scene.requestRender();
  }
  function preventMiddle(e: MouseEvent) {
    if (e.button === 1) e.preventDefault();
  }
  canvas.addEventListener('pointerdown', down, { capture: true });
  canvas.addEventListener('pointermove', move, { capture: true });
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', finish);
  canvas.addEventListener('mousedown', preventMiddle);
  canvas.addEventListener('auxclick', preventMiddle);
  window.addEventListener('blur', finish);
  const remove = v.scene.preRender.addEventListener(keepAboveGround);
  return () => {
    finish();
    remove();
    canvas.removeEventListener('pointerdown', down, true);
    canvas.removeEventListener('pointermove', move, true);
    canvas.removeEventListener('pointerup', finish);
    canvas.removeEventListener('pointercancel', finish);
    canvas.removeEventListener('lostpointercapture', finish);
    canvas.removeEventListener('mousedown', preventMiddle);
    canvas.removeEventListener('auxclick', preventMiddle);
    window.removeEventListener('blur', finish);
  };
}
