import * as THREE from 'three';
import { PALETTE as P } from './palette.ts';
import type { GlassUniforms } from './spatial-glass.ts';

export type SurfaceRole = 'environment' | 'agent' | 'screen';

/** Single-pass translucent light, not expensive transmission or full-frame bloom.
 * A pixel-width edge accent preserves the original faceted object silhouettes.
 */
export function hologramMaterial(color: string, kind: string, time: { value: number }, role: SurfaceRole = 'environment', glass?: GlassUniforms): THREE.MeshLambertMaterial {
  const agent = role === 'agent', screen = role === 'screen';
  const wall = !agent && !screen && (color === P.wall || color === P.glass);
  const base = [P.floor, P.floorAlt, P.foundation, P.black].includes(color as never);
  const floorFinish = role === 'environment' && color === P.floor;
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color).multiplyScalar(agent ? .5 : screen ? .8 : .18), flatShading: true, transparent: true,
    opacity: agent ? .9 : wall ? .3 : floorFinish ? .24 : base ? .64 : .70,
    depthWrite: !wall, emissive: color, emissiveIntensity: agent ? 1.0 : screen ? .6 : base ? .035 : .10,
  });
  const backdrop = glass ?? { texture: { value: null }, viewport: { value: new THREE.Vector2(1,1) }, ready: { value: 0 } };
  material.userData.hologramRole = wall ? 'glass' : role;
  // The physical deck now owns the opaque contact surface, in the main and frosted views.
  if (floorFinish) material.userData.captureBackdrop = false;
  material.onBeforeCompile = shader => {
    shader.uniforms.uHoloTime = time;
    shader.uniforms.uHoloBackdrop = backdrop.texture;
    shader.uniforms.uHoloViewport = backdrop.viewport;
    shader.uniforms.uHoloGlassReady = backdrop.ready;
    // Fragmented shells already have real gaps; pixel erosion hid their silhouette at campus scale.
    shader.uniforms.uHoloReconstruction = { value: !wall && !screen && !agent && !floorFinish ? 1 : 0 };
    shader.uniforms.uHoloIsGlass = { value: wall ? 1 : 0 };
    shader.uniforms.uHoloSignal = { value: agent ? 1.0 : screen ? .6 : base ? .045 : .24 };
    shader.uniforms.uHoloBox = { value: kind === 'box' ? 1 : 0 };
    shader.vertexShader = `varying vec3 vHoloLocal; varying vec3 vHoloWorld; varying vec3 vHoloView;\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vHoloLocal = position;
      vec4 holoWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        holoWorld = instanceMatrix * holoWorld;
      #endif
      vHoloWorld = (modelMatrix * holoWorld).xyz;
      vHoloView = (viewMatrix * vec4(vHoloWorld, 1.0)).xyz;`);
    shader.fragmentShader = `uniform sampler2D uHoloBackdrop; uniform vec2 uHoloViewport; uniform float uHoloGlassReady; uniform float uHoloReconstruction; uniform float uHoloIsGlass; uniform float uHoloTime; uniform float uHoloBox; uniform float uHoloSignal; varying vec3 vHoloLocal; varying vec3 vHoloWorld; varying vec3 vHoloView;\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
      if (uHoloReconstruction > .5) {
        vec2 memoryCell = floor(vHoloWorld.xz * 37.0);
        float memoryColumn = fract(sin(dot(memoryCell, vec2(127.1,311.7))) * 43758.5453);
        float memorySlice = fract(vHoloWorld.y * 21.0 + memoryColumn * 7.0 - uHoloTime * .027);
        if (memoryColumn < .12 || memorySlice < .075) discard;
        gl_FragColor.rgb *= .34 + .58 * smoothstep(.12,.95,memoryColumn);
        gl_FragColor.a *= .7 + .3 * memoryColumn;
      }
      if (uHoloIsGlass > .5 && uHoloGlassReady > .5) {
        vec3 glassNormal = normalize(cross(dFdx(vHoloView), dFdy(vHoloView)));
        vec2 uv = gl_FragCoord.xy / uHoloViewport;
        vec2 bend = glassNormal.xy * .005 + vec2(sin(vHoloWorld.y * 1.2 + uHoloTime * .12), cos(vHoloWorld.x * .9)) * .0007;
        vec2 sampleUv = clamp(uv + bend, vec2(.002), vec2(.998));
        vec3 frost = textureLod(uHoloBackdrop, sampleUv, 1.6).rgb;
        frost.r = textureLod(uHoloBackdrop, clamp(sampleUv + bend * .09, vec2(.002), vec2(.998)), 1.6).r;
        frost.b = textureLod(uHoloBackdrop, clamp(sampleUv - bend * .09, vec2(.002), vec2(.998)), 1.6).b;
        gl_FragColor.rgb = mix(frost * .94 + vec3(.001,.003,.01), gl_FragColor.rgb, .1);
        gl_FragColor.a = .96;
      }
      #include <tonemapping_fragment>
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      vec3 faceDistance = vec3(.5) - abs(vHoloLocal);
      float edgeDistance = min(max(faceDistance.x, faceDistance.y), max(min(faceDistance.x, faceDistance.y), faceDistance.z));
      float edge = (1.0 - smoothstep(0.0, max(.001, length(fwidth(vHoloLocal)) * .72), edgeDistance)) * uHoloBox;
      vec3 faceNormal = normalize(cross(dFdx(vHoloView), dFdy(vHoloView)));
      float rim = pow(1.0 - abs(dot(faceNormal, normalize(-vHoloView))), 2.4);
      float scan = .985 + .015 * sin(vHoloWorld.y * 86.0 - uHoloTime * .55);
      vec3 cell = floor(vHoloWorld * 23.0 + vec3(0.0, -uHoloTime * .16, 0.0));
      float artifact = step(.993, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
      gl_FragColor.rgb += vec3(.23, .43, .78) * (edge * .25 + rim * .16 + artifact * .13) * uHoloSignal;
      gl_FragColor.a *= scan;`);
  };
  material.customProgramCacheKey = () => 'office-memory-reconstruction-v5';
  return material;
}
