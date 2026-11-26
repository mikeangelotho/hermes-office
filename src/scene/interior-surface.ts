import * as THREE from 'three';

export interface InteriorLighting {
  hatch: THREE.Vector3;
  relay: THREE.Vector3;
  depth: THREE.Vector2;
  // The maintenance trench ends before it reaches the front room.
  trench: THREE.Vector2;
}

/** Dry steel and sealed concrete. All survey marks and practicals live in metres on
 * the geometry: no framebuffer overlay, textures, clock, shadow pass or light loop. */
export function interiorSurface(lights: InteriorLighting, deck: boolean) {
  const material=new THREE.ShaderMaterial({
    name:deck?'scanned-contact-floor':'scanned-service-metal',vertexColors:true,fog:true,
    defines:deck?{CONTACT_DECK:1}:{},
    uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{
      uHatch:{value:lights.hatch},uRelay:{value:lights.relay},uDepth:{value:lights.depth},uTrench:{value:lights.trench},
    }]),
    vertexShader:`
      varying vec3 vPoint; varying vec3 vInk; varying vec3 vFace;
      #ifdef CONTACT_DECK
        attribute vec2 aSideDistance; varying vec2 vSides;
      #endif
      #include <fog_pars_vertex>
      void main(){
        vPoint=position; vInk=color; vFace=normal;
        #ifdef CONTACT_DECK
          vSides=aSideDistance;
        #endif
        vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader:`
      varying vec3 vPoint; varying vec3 vInk; varying vec3 vFace;
      uniform vec3 uHatch; uniform vec3 uRelay;
      #ifdef CONTACT_DECK
        uniform vec2 uDepth; uniform vec2 uTrench; varying vec2 vSides;
      #endif
      #include <fog_pars_fragment>
      float hash(vec2 p){
        vec3 q=fract(vec3(p.xyx)*.1031); q+=dot(q,q.yzx+33.33);
        return fract((q.x+q.y)*q.z);
      }
      float noiseField(vec2 p){
        vec2 i=floor(p),t=fract(p);t=t*t*(3.0-2.0*t);
        return mix(mix(hash(i),hash(i+vec2(1,0)),t.x),mix(hash(i+vec2(0,1)),hash(i+1.0),t.x),t.y);
      }
      float lineAt(float distance,float width,float pixel){return 1.0-smoothstep(width-pixel*.45,width+pixel*.55,distance);}
      float lamp(vec3 delta,vec3 falloff){vec3 q=delta*falloff;return exp2(-dot(q,q));}
      void main(){
        vec3 p=vPoint; vec2 uv=abs(vFace.y)>.5?p.xz:(abs(vFace.x)>.5?p.zy:p.xy);
        float pixel=max(.001,max(fwidth(uv.x),fwidth(uv.y)));
        float broad=noiseField(uv*vec2(.25,.31)+vec2(17.6,9.5));
        float mottle=noiseField(uv*vec2(.78,1.27)+broad*.60);
        vec3 ink=vInk*(.47+.54*broad+.19*mottle);
        #ifdef CONTACT_DECK
          // Running bond, not a glowing orthogonal grid. Hairlines soften under minification.
          vec2 tile=uv/vec2(3.1,2.35);
          tile.x+=mod(floor(tile.y),2.0)*.5;
          vec2 joint=(.5-abs(fract(tile)-.5))*vec2(3.1,2.35);
          float seam=lineAt(min(joint.x,joint.y),.022,pixel);
          ink*= (.87+.16*hash(floor(tile)+3.7))*(1.0-.43*seam);
          // A dark slotted inspection channel splices the rows together.
          float side=abs(p.x-uTrench.x);
          float inRun=smoothstep(uDepth.x+1.0,uDepth.x+1.5,p.z)*(1.0-smoothstep(uTrench.y-.18,uTrench.y+.18,p.z));
          float gutter=lineAt(side,.17,pixel)*inRun;
          float slot=.5+.5*cos(p.z*20.5);
          ink*=1.0-gutter*(.38+.42*slot*(1.0-smoothstep(.08,.22,pixel)));
          ink+=vec3(.010,.014,.015)*lineAt(abs(side-.19),.023,pixel)*inRun;
          // Beyond the serviced footprint, the same surface loses coherence in broken strips.
          float edge=min(min(vSides.x,vSides.y),min(p.z-uDepth.x,uDepth.y-p.z));
          float confidence=smoothstep(-1.0,1.35,edge+(mottle-.52)*1.65);
          if(edge<-.045 && edge*.32+mottle*.75+broad*.25<.21)discard;
          ink*=.10+.90*confidence;
          float lip=(1.0-smoothstep(.05,1.25,abs(edge)))*smoothstep(.40,.80,mottle);
          ink+=vec3(.009,.025,.030)*lip*smoothstep(.61,.94,hash(floor(uv*vec2(3.5,10.0))));
        #else
          // Dirt collects at the foot of the wall, leaving the lit high edges clearer.
          ink*=.72+.28*smoothstep(.1,1.35,p.y);
        #endif
        // Intermittent resolved striations follow the material plane. Fine marks average
        // away in a distant view instead of changing phase as the camera moves.
        float fine=1.0-smoothstep(.045,.18,pixel);
        float fleck=hash(floor(uv*vec2(9.0,18.0)));
        float trace=smoothstep(.53,.83,broad*.68+mottle*.32)*smoothstep(.63,.96,fleck)*fine;
        ink+=vec3(.008,.023,.028)*trace;
        // Each lens and its reflected pool share one position; no campus-wide orange tint.
        float service=lamp(p-uHatch,vec3(.40,.45,.55));
        float task=lamp(p-uRelay,vec3(.68,.62,.69));
        ink+=vec3(.094,.039,.009)*(service+.61*task)*(.75+.25*mottle);
        gl_FragColor=vec4(ink,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  material.userData.captureStatic=true;
  return material;
}
