import * as THREE from 'three';
import { PALETTE as P } from './palette.ts';

export interface GlassUniforms {
  texture: { value: THREE.Texture | null };
  viewport: { value: THREE.Vector2 };
  ready: { value: number };
}
export function glassCaptureSize(width: number, height: number) {
  const w = Number.isFinite(width) && width > 0 ? width : 1280;
  const h = Number.isFinite(height) && height > 0 ? height : 720;
  const scale = Math.min(.32, 640 / Math.max(w,h), Math.sqrt(160000 / (w*h)));
  return { width: Math.max(1,Math.floor(w*scale)), height: Math.max(1,Math.floor(h*scale)) };
}
type LitMaterial = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number };
type Entry = { source: THREE.Mesh; index: number; count: number };

/** Simplified lighting, actual geometry/poses. Batch by shared primitive, not by color.
 * Glass is omitted so it cannot capture/obscure itself; no render-texture feedback.
 */
export function createGlassProxy(roots: THREE.Object3D[]) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(P.void);
  // instanceColor is enabled by InstancedMesh; vertexColors would require a separate geometry color attribute.
  const material = new THREE.MeshBasicMaterial({ toneMapped: false });
  type SharedDraw = THREE.Points | THREE.LineSegments | THREE.Mesh;
  const copies: {source: SharedDraw; clone: SharedDraw}[] = [];
  const batches: { mesh: THREE.InstancedMesh; entries: Entry[] }[] = [];
  const matrix = new THREE.Matrix4(), local = new THREE.Matrix4(), color = new THREE.Color(), emission = new THREE.Color();
  let sources = roots, disposed = false;
  function setSources(next: THREE.Object3D[]) {
    if (disposed) return;
    sources = next;
    batches.forEach(b => { scene.remove(b.mesh); b.mesh.dispose(); }); batches.length = 0;
    copies.forEach(s => scene.remove(s.clone)); copies.length = 0;
    const groups = new Map<string,{ geometry: THREE.BufferGeometry; entries: Entry[]; count: number }>();
    for (const root of sources) root.traverse(object => {
      if (!object.visible) return;
      if (!(object instanceof THREE.Points || object instanceof THREE.LineSegments || object instanceof THREE.Mesh)) return;
      const m = (Array.isArray(object.material) ? object.material[0] : object.material) as LitMaterial;
      if (!m.visible || m.userData.captureBackdrop === false) return;
      if (object instanceof THREE.Points || object instanceof THREE.LineSegments || m.userData.captureStatic) {
        if (m.userData.captureMemory || m.userData.captureStatic) {
          const clone = object.clone(false); clone.matrixAutoUpdate = false;
          clone.frustumCulled = m.userData.captureStatic ? object.frustumCulled : false;
          scene.add(clone); copies.push({source:object,clone});
        }
        return;
      }
      if (!['environment','agent','screen'].includes(m.userData.hologramRole)) return;
      const params = (object.geometry as THREE.BufferGeometry & { parameters?: unknown }).parameters;
      const key = `${object.geometry.type}:${params ? JSON.stringify(params) : object.geometry.uuid}`;
      const g = groups.get(key) ?? { geometry: object.geometry, entries: [] as Entry[], count: 0 };
      const count = object instanceof THREE.InstancedMesh ? object.count : 1;
      g.entries.push({ source: object, index: g.count, count }); g.count += count; groups.set(key,g);
    });
    for (const g of groups.values()) {
      const mesh = new THREE.InstancedMesh(g.geometry,material,g.count);
      mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh); batches.push({ mesh, entries:g.entries });
    }
    sync();
  }
  function sync() {
    if (disposed) return;
    for (const root of sources) root.updateWorldMatrix(true,true);
    for (const s of copies) { s.clone.matrix.copy(s.source.matrixWorld); s.clone.visible = s.source.visible; }
    for (const b of batches) {
      for (const entry of b.entries) {
        const source = entry.source;
        const m = (Array.isArray(source.material) ? source.material[0] : source.material) as LitMaterial;
        color.copy(m.color ?? new THREE.Color(P.metal));
        if (m.emissive) color.add(emission.copy(m.emissive).multiplyScalar(m.emissiveIntensity ?? 0));
        for (let i = 0; i < entry.count; i++) {
          if (source instanceof THREE.InstancedMesh) { source.getMatrixAt(i,local);matrix.multiplyMatrices(source.matrixWorld,local); }
          else matrix.copy(source.matrixWorld);
          b.mesh.setMatrixAt(entry.index+i,matrix); b.mesh.setColorAt(entry.index+i,color);
        }
      }
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    }
  }
  setSources(roots);
  return { scene, sync, setSources, dispose() {
    if (disposed) return; disposed = true;
    batches.forEach(b => b.mesh.dispose()); batches.length = 0; copies.length = 0; scene.clear(); material.dispose(); sources = [];
  } };
}

/** One <=160K-pixel mipmapped capture at 12 Hz (each camera change refreshes).
 * Screen-space refraction, not ray-traced transmission; one shared target.
 */
export function createSpatialGlass(renderer: THREE.WebGLRenderer, camera: THREE.Camera, roots: THREE.Object3D[], uniforms: GlassUniforms) {
  const proxy = createGlassProxy(roots);
  const target = new THREE.WebGLRenderTarget(1,1,{ generateMipmaps:true, minFilter:THREE.LinearMipmapLinearFilter, magFilter:THREE.LinearFilter, depthBuffer:true, stencilBuffer:false, colorSpace:THREE.LinearSRGBColorSpace });
  uniforms.texture.value = target.texture;
  let disposed = false, stale = true, last = -Infinity;
  return {
    resize(width: number,height: number) {
      if (disposed) return;
      const size = glassCaptureSize(width,height);target.setSize(size.width,size.height);
      renderer.getDrawingBufferSize(uniforms.viewport.value); stale = true;
    },
    setSources(sources: THREE.Object3D[]) { if (!disposed) { proxy.setSources(sources); stale = true; } },
    render(time: number,force = false) {
      if (disposed || (!stale && !force && time-last < 1/12)) return { calls:0,triangles:0,pixels:target.width*target.height };
      proxy.sync(); const previous = renderer.getRenderTarget();
      const beforeCalls = renderer.info.render.calls, beforeTriangles = renderer.info.render.triangles;
      try { renderer.setRenderTarget(target);renderer.render(proxy.scene,camera);uniforms.ready.value = 1; }
      finally { renderer.setRenderTarget(previous); }
      stale = false;last = time;
      return { calls:renderer.info.render.calls-beforeCalls,triangles:renderer.info.render.triangles-beforeTriangles,pixels:target.width*target.height };
    },
    dispose() { if (disposed) return;disposed = true;uniforms.ready.value = 0;uniforms.texture.value = null;proxy.dispose();target.dispose(); },
  };
}
