import * as THREE from 'three';
import type { WorldBounds } from './campus.ts';

/** Fit real room extents in camera space, including portrait and short embeddings. */
export function campusCamera(bounds: WorldBounds, width: number, height: number) {
  const aspect=width>0&&height>0&&Number.isFinite(width/height)?width/height:16/9;
  const fov=34,tan=Math.tan(THREE.MathUtils.degToRad(fov/2));
  const target=new THREE.Vector3((bounds.minX+bounds.maxX)/2,1.2,(bounds.minZ+bounds.maxZ)/2);
  const direction=new THREE.Vector3(.33,.76,.7).normalize();
  const right=new THREE.Vector3(direction.z,0,-direction.x).normalize(),up=new THREE.Vector3().crossVectors(direction,right);
  let distance=12;
  for(const x of [bounds.minX,bounds.maxX])for(const z of [bounds.minZ,bounds.maxZ])for(const y of [0,4]){
    const corner=new THREE.Vector3(x,y,z).sub(target);
    distance=Math.max(distance,corner.dot(direction)+Math.max(Math.abs(corner.dot(right))/(tan*aspect*.86),Math.abs(corner.dot(up))/(tan*.82)));
  }
  const position=target.clone().addScaledVector(direction,distance);
  return {fov,aspect,target:target.toArray(),position:position.toArray(),distance};
}
