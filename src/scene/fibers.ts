import * as THREE from 'three';
import { PALETTE as P } from './palette.ts';

/** Edgar-inspired connected contours, slow travelling highlights and corner nodes.
 * Three draws, fixed buffers, no noise textures, postprocessing or per-frame allocation.
 */
export function createFiberField(): { group: THREE.Group; tick(time: number, reduced: boolean): void; dispose(): void } {
  const group = new THREE.Group(); group.name = 'memory-scan-traces';
  const time = { value: 0 };
  const positions: number[] = [], along: number[] = [], phases: number[] = [], lifts: number[] = [];
  function vertex(p: THREE.Vector3, u: number, phase: number, lift: number) {
    positions.push(p.x, p.y, p.z); along.push(u); phases.push(phase); lifts.push(lift);
  }
  // Interrupted vertical scan traces replace decorative orbital rings and the tiled grid.
  for (let line=0;line<32;line++) {
    const phase=(line*.61803398875%1)*Math.PI*2;
    const x=-18+line*1.15,z=-10.2-Math.sin(line*1.7)*1.3;
    for(let i=0;i<24;i++){
      if((i*7+line*11)%9<4)continue;
      const y=.1+i*.29;
      vertex(new THREE.Vector3(x,y,z),i/24,phase,.25);
      vertex(new THREE.Vector3(x,y+.08+(line%3)*.035,z),(i+.4)/24,phase,.25);
    }
  }
  for(let i=0;i<96;i++){
    const x=Math.sin(i*17.31)*17,z=Math.cos(i*4.13)*13;
    vertex(new THREE.Vector3(x,.062,z),0,-1,0);
    vertex(new THREE.Vector3(x+.10+(i%4)*.06,.062,z),1,-1,0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geometry.setAttribute('aLift', new THREE.Float32BufferAttribute(lifts, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: time, uColor: { value: new THREE.Color(P.azure) } },
    vertexShader: `uniform float uTime; attribute float aAlong; attribute float aPhase; attribute float aLift;
      varying float vAlong; varying float vPhase;
      void main() { vAlong = aAlong; vPhase = aPhase; vec3 p = position;
        p.y += aLift * sin(aAlong * 12.56637 + uTime * .22 + aPhase) * .14;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; varying float vAlong; varying float vPhase;
      void main() { float distance = abs(fract(vAlong - uTime * .019 + vPhase) - .5);
        float pulse = exp(-distance * distance * 1900.0);
        float alpha = vPhase < 0.0 ? .115 : .075 + pulse * .42;
        gl_FragColor = vec4(mix(uColor, vec3(.72, .83, 1.0), pulse * .65), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  group.add(new THREE.LineSegments(geometry, material));
  const nodes: number[] = [], links: number[] = [];
  let seed = 7341;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 96; i++) {
    const side = i % 2 ? 1 : -1;
    const p = new THREE.Vector3(side * (12 + random() * 16), .2 + random() * 8, -17 + random() * 34);
    nodes.push(p.x, p.y, p.z);
    if (i % 3 === 0) links.push(p.x, p.y, p.z, p.x + side * (1 + random() * 2), p.y + .8, p.z + 1.5);
  }
  const pointsGeometry = new THREE.BufferGeometry(); pointsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(nodes, 3));
  const pointsMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: time, uColor: { value: new THREE.Color(P.ice) } },
    vertexShader: `varying float vPhase; void main() { vPhase = position.x + position.y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 3.0; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; varying float vPhase;
      void main() { float r = length(gl_PointCoord - .5); if (r > .5) discard;
        gl_FragColor = vec4(uColor, (.3 + .05 * sin(uTime * .3 + vPhase)) * (1.0 - smoothstep(.08, .5, r)));
        #include <colorspace_fragment>
      }`,
  });
  group.add(new THREE.Points(pointsGeometry, pointsMaterial));
  const linksGeometry = new THREE.BufferGeometry(); linksGeometry.setAttribute('position', new THREE.Float32BufferAttribute(links, 3));
  const linksMaterial = new THREE.LineBasicMaterial({ color: P.muted, transparent: true, opacity: .2, depthWrite: false });
  group.add(new THREE.LineSegments(linksGeometry, linksMaterial));
  let disposed = false;
  return { group, tick(value, reduced) { if (!disposed && !reduced) time.value = value; }, dispose() {
    if (disposed) return; disposed = true;
    geometry.dispose(); material.dispose(); pointsGeometry.dispose(); pointsMaterial.dispose(); linksGeometry.dispose(); linksMaterial.dispose();
  } };
}
