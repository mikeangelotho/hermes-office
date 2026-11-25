import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets} from '../src/scene/room.ts';
import {PALETTE as P} from '../src/scene/palette.ts';
import {createMemoryField,scanMaterial} from '../src/scene/memory-field.ts';
import {createCourtyard} from '../src/scene/courtyard.ts';
import {reconstructionDensity} from '../src/scene/reconstruction-density.ts';

function pointPositions(group:THREE.Group) {
  const points=group.children.find(node=>node instanceof THREE.Points) as THREE.Points;
  assert.ok(points,'reconstruction must contain actual point geometry');
  return points.geometry.getAttribute('position');
}

function floorFixture(width=36,depth=32,segments=1) {
  const assets=new Assets(),root=new THREE.Group(),geometry=new THREE.PlaneGeometry(width,depth,segments,segments);
  const floor=new THREE.Mesh(geometry,assets.material(P.floor));
  floor.rotation.x=-Math.PI/2;floor.position.y=.2;root.add(floor);
  return {root,assets,geometry,dispose(){geometry.dispose();assets.dispose();}};
}

test('surface reconstruction leaves coherent multi-meter voids and concentrated islands',()=>{
  const fixture=floorFixture(),field=createMemoryField([fixture.root],12000);
  try {
    const positions=pointPositions(field.group),columns=18,rows=16,bins=new Array<number>(columns*rows).fill(0);
    assert.ok(field.pointCount>=5000&&field.pointCount<=12000);
    for(let i=0;i<positions.count;i++) {
      const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
      assert.ok(Math.abs(y-.203)<.000001,'density must not move points off the sampled surface');
      const col=Math.min(columns-1,Math.floor((x+18)/2)),row=Math.min(rows-1,Math.floor((z+16)/2));
      bins[row*columns+col]++;
    }
    const mean=positions.count/bins.length,voids=bins.filter(count=>count<mean*.08).length;
    assert.ok(voids>=bins.length*.2,`expected broad missing patches, found ${voids}/${bins.length} nearly empty cells`);
    const concentrated=[...bins].sort((a,b)=>b-a).slice(0,Math.floor(bins.length*.2)).reduce((sum,n)=>sum+n,0)/positions.count;
    assert.ok(concentrated>.55,`densest fifth must hold islands, not an even scatter (${concentrated})`);
    let adjacentVoids=0;
    for(let row=0;row<rows-1;row++)for(let col=0;col<columns-1;col++) {
      const at=row*columns+col;
      if(bins[at]<mean*.08&&bins[at+1]<mean*.08&&bins[at+columns]<mean*.08)adjacentVoids++;
    }
    assert.ok(adjacentVoids>=12,`missing patches must join across neighboring cells (${adjacentVoids})`);
  } finally {field.dispose();fixture.dispose();}
});

test('courtyard residuals occupy asymmetric islands with substantial negative space',()=>{
  const assets=new Assets(),world=createCourtyard(assets);
  try {
    const positions=pointPositions(world.group),columns=22,rows=20,bins=new Array<number>(columns*rows).fill(0),quadrants=[0,0,0,0];
    let ground=0;
    for(let i=0;i<positions.count;i++) {
      const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
      if(y>.15)continue;
      ground++;quadrants[(x>0?1:0)+(z>0?2:0)]++;
      const col=Math.floor((x+22)/2),row=Math.floor((z+20)/2);
      if(col>=0&&col<columns&&row>=0&&row<rows)bins[row*columns+col]++;
    }
    assert.ok(ground>world.pointCount*.5,'most residuals must remain attached to the ground, not become a starfield');
    let exterior=0,empty=0;
    for(let row=0;row<rows;row++)for(let col=0;col<columns;col++) {
      const x=-21+col*2,z=-19+row*2;
      if(Math.abs(x)<8&&Math.abs(z)<7)continue;
      exterior++;if(bins[row*columns+col]<3)empty++;
    }
    assert.ok(empty/exterior>.5,`surrounding void must not be a uniform rectangular carpet (${empty}/${exterior} empty cells)`);
    assert.ok(Math.max(...quadrants)/Math.max(1,Math.min(...quadrants))>2,`residual islands must be asymmetric (${quadrants})`);
  } finally {world.dispose();assets.dispose();}
});

test('residual architecture has only a few broken members, without a plinth or picket row',()=>{
  const assets=new Assets(),world=createCourtyard(assets);
  try {
    const meshes:THREE.Mesh[]=[];world.group.traverse(node=>{if(node instanceof THREE.Mesh)meshes.push(node);});
    assert.ok(meshes.every(mesh=>mesh instanceof THREE.InstancedMesh),'a surrounding solid floor/plinth must not replace the void');
    const matrix=new THREE.Matrix4(),position=new THREE.Vector3(),scale=new THREE.Vector3(),rotation=new THREE.Quaternion();
    let members=0,tilted=0;
    for(const mesh of meshes as THREE.InstancedMesh[])for(let i=0;i<mesh.count;i++) {
      mesh.getMatrixAt(i,matrix);matrix.decompose(position,rotation,scale);members++;
      if(Math.abs(rotation.z)>.04)tilted++;
    }
    assert.ok(members>0&&members<=6,`only isolated architectural fragments should survive (${members})`);
    assert.ok(tilted>=2,'a regular row of identical upright posts is not a reconstruction');
  } finally {world.dispose();assets.dispose();}
});

test('courtyard bounds keep residual geometry outside a multiroom campus footprint',()=>{
  const assets=new Assets(),bounds={width:38,depth:36},world=createCourtyard(assets,bounds);
  try {
    const positions=pointPositions(world.group);let reachX=0,reachZ=0;
    assert.ok(world.pointCount>=10000&&world.pointCount<=12000);
    for(let i=0;i<positions.count;i++) {
      const x=Math.abs(positions.getX(i)),z=Math.abs(positions.getZ(i));
      assert.ok(x>=bounds.width/2+.39||z>=bounds.depth/2+.39,`residual point intrudes into the campus (${x}, ${z})`);
      assert.ok(x<bounds.width/2+11&&z<bounds.depth/2+11,'outer remnants must remain bounded');
      reachX=Math.max(reachX,x);reachZ=Math.max(reachZ,z);
    }
    assert.ok(reachX>bounds.width/2+2&&reachZ>bounds.depth/2+2);
    const matrix=new THREE.Matrix4(),position=new THREE.Vector3();
    world.group.traverse(node=>{
      if(!(node instanceof THREE.InstancedMesh))return;
      for(let i=0;i<node.count;i++) {
        node.getMatrixAt(i,matrix);position.setFromMatrixPosition(matrix);
        assert.ok(Math.abs(position.x)>bounds.width/2||Math.abs(position.z)>bounds.depth/2,'architectural remnants must also respect campus bounds');
      }
    });
  } finally {world.dispose();assets.dispose();}
});

test('scan animation modulates spatially related returns rather than random point twinkles',()=>{
  const material=scanMaterial({value:0});
  try {
    assert.doesNotMatch(material.vertexShader+material.fragmentShader,/sin\([^)]*\b(?:aSeed|vSeed)\b/,'random point IDs must not drive animated phase');
    assert.match(material.vertexShader,/sin\([^)]*world\./,'animated signal must be correlated with reconstruction coordinates');
    assert.match(material.fragmentShader,/vSignal/,'the fragment receives the shared spatial signal');
  } finally {material.dispose();}
});

test('scan fading uses camera-relative depth without a hard world-origin cutoff',()=>{
  const material=scanMaterial({value:0});
  try {
    assert.doesNotMatch(material.vertexShader,/length\s*\(\s*world\.(?:xz|xyz)\s*\)/,'outer campus rooms must not disappear solely because they are far from the origin');
    assert.match(material.vertexShader,/viewMatrix\s*\*\s*world/);
    assert.match(material.vertexShader,/vFade\s*=\s*1\.0\s*\/\s*\(/,'distance attenuation must remain nonzero at every finite distance');
  } finally {material.dispose();}
});

test('invalid courtyard bounds are rejected before allocating residual geometry',()=>{
  const assets=new Assets();
  try {
    for(const bounds of [{width:-38,depth:36},{width:38,depth:0},{width:NaN,depth:36},{width:38,depth:Infinity}]) {
      assert.throws(()=>createCourtyard(assets,bounds),RangeError);
      assert.equal(assets.geometries.size,0,'invalid bounds must not allocate borrowed geometry');
    }
  } finally {assets.dispose();}
});

test('density is deterministic with spatial continuity and directional tearing at finer scales',()=>{
  let samples=0,empty=0,bright=0,dx=0,dy=0,dz=0,distant=0;
  for(let x=-18;x<18;x+=.8)for(let z=-16;z<16;z+=.8) {
    const value=reconstructionDensity(x,.2,z);samples++;
    assert.ok(Number.isFinite(value)&&value>=0&&value<=1);
    assert.equal(value,reconstructionDensity(x,.2,z));
    if(value===0)empty++;if(value>.5)bright++;
    dx+=Math.abs(value-reconstructionDensity(x+.08,.2,z));
    dy+=Math.abs(value-reconstructionDensity(x,.28,z));
    dz+=Math.abs(value-reconstructionDensity(x,.2,z+.08));
    distant+=Math.abs(value-reconstructionDensity(x+3.2,.2,z));
  }
  assert.ok(empty/samples>.25&&bright/samples>.04,'both genuine voids and surviving patches must exist');
  assert.ok(dx<distant*.25,'neighbors must share density rather than use white noise');
  assert.ok(dx<dy*.7&&dx<dz*.7,'scan tears must have a long axis instead of isotropic grain');
});

test('area-weighted surface reconstruction is independent of triangle subdivision',()=>{
  const coarse=floorFixture(),fine=floorFixture(36,32,30),fields=[createMemoryField([coarse.root],12000),createMemoryField([fine.root],12000)];
  try {
    const distributions=fields.map(field=>{
      const positions=pointPositions(field.group),bins=new Array<number>(24).fill(0);
      for(let i=0;i<positions.count;i++) {
        const col=Math.min(5,Math.floor((positions.getX(i)+18)/6)),row=Math.min(3,Math.floor((positions.getZ(i)+16)/8));
        bins[row*6+col]++;
      }
      return bins.map(count=>count/positions.count);
    });
    const difference=distributions[0].reduce((sum,value,i)=>sum+Math.abs(value-distributions[1][i]),0);
    assert.ok(difference<.08,`retessellation must not change density weighting (${difference})`);
  } finally {fields.forEach(field=>field.dispose());coarse.dispose();fine.dispose();}
});

test('translated instanced surfaces keep their real shape in world-space reconstruction',()=>{
  const assets=new Assets(),root=new THREE.Group(),mesh=new THREE.InstancedMesh(assets.geometry(),assets.material(P.frame),2);
  root.position.set(12,0,11);root.rotation.y=.36;root.add(mesh);
  const transform=new THREE.Object3D();
  transform.position.set(0,1,0);transform.scale.set(4,2,3);transform.updateMatrix();mesh.setMatrixAt(0,transform.matrix);
  transform.position.set(7,1.5,-5);transform.scale.set(3,3,2);transform.updateMatrix();mesh.setMatrixAt(1,transform.matrix);
  root.updateWorldMatrix(true,true);
  const inverse=[0,1].map(i=>{const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);return matrix.premultiply(mesh.matrixWorld).invert();});
  const field=createMemoryField([root],2048),point=new THREE.Vector3();
  try {
    const positions=pointPositions(field.group);assert.ok(field.pointCount>500);
    for(let i=0;i<positions.count;i++) {
      assert.ok(inverse.some(matrix=>{
        point.fromBufferAttribute(positions,i).applyMatrix4(matrix);
        const components=[Math.abs(point.x),Math.abs(point.y),Math.abs(point.z)];
        return components.every(n=>n<.506)&&components.some(n=>Math.abs(n-.5)<.006);
      }),'accepted point must remain on a transformed instance surface');
    }
  } finally {field.dispose();mesh.dispose();assets.dispose();}
});

test('missing surfaces stay missing while empty inputs and point budgets remain bounded',()=>{
  const fixture=floorFixture(),full=createMemoryField([fixture.root],1e9),empty=createMemoryField([],1000),zero=createMemoryField([fixture.root],-1);
  const lost=floorFixture(.01,.01);let location:[number,number]|undefined;
  for(let x=-18;x<18&&!location;x++)for(let z=-16;z<16&&!location;z++) {
    if([[-.01,-.01],[.01,-.01],[-.01,.01],[.01,.01],[0,0]].every(([dx,dz])=>reconstructionDensity(x+dx,.2,z+dz)===0))location=[x,z];
  }
  assert.ok(location,'fixture must include a wholly missing region');lost.root.position.set(location[0],0,location[1]);
  const missing=createMemoryField([lost.root],10000);
  try {
    assert.equal(full.pointCount,30000);assert.equal(pointPositions(full.group).count,30000);
    assert.equal(empty.pointCount,0);assert.equal(zero.pointCount,0);
    assert.equal(missing.pointCount,0,'attempt exhaustion must not refill an eroded region with uniform points');
    assert.equal(pointPositions(missing.group).count,0);
  } finally {full.dispose();empty.dispose();zero.dispose();missing.dispose();fixture.dispose();lost.dispose();}
});

test('reconstruction lifecycle preserves fixed buffers and shared Assets ownership',()=>{
  const fixture=floorFixture(),assets=new Assets();
  try {
    for(const create of [()=>createMemoryField([fixture.root],1024),()=>createCourtyard(assets,{width:38,depth:36})]) {
      const first=create(),second=create(),points=first.group.children.find(node=>node instanceof THREE.Points) as THREE.Points;
      const material=points.material as THREE.ShaderMaterial,positions=points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array=positions.array,version=positions.version,before=Array.from(array);
      assert.deepEqual(before,Array.from(pointPositions(second.group).array));
      first.tick(5,false);first.tick(99,true);first.setPixelRatio(4);
      assert.equal(material.uniforms.uTime.value,5);assert.equal(material.uniforms.uPixelRatio.value,1.65);
      first.setPixelRatio(.1);assert.equal(material.uniforms.uPixelRatio.value,1);
      assert.equal(points.geometry.getAttribute('position'),positions);assert.equal(positions.array,array);assert.equal(positions.version,version);
      assert.deepEqual(Array.from(array),before);
      let owned=0,borrowed=0;
      const borrowedResources=[fixture.geometry,...fixture.assets.materials.values(),...assets.geometries.values(),...assets.materials.values()];
      borrowedResources.forEach(resource=>resource.addEventListener('dispose',()=>borrowed++));
      first.group.children.forEach(node=>{
        if(node instanceof THREE.Points||node instanceof THREE.LineSegments) {
          node.geometry.addEventListener('dispose',()=>owned++);
          (node.material as THREE.Material).addEventListener('dispose',()=>owned++);
        }
      });
      first.dispose();first.dispose();first.tick(120,false);second.dispose();
      assert.equal(owned,4,'each owned points/lines buffer and material is disposed exactly once');
      assert.equal(borrowed,0,'shared geometry and materials remain owned by Assets');
      assert.equal(material.uniforms.uTime.value,5,'disposed fields ignore ticks');
    }
  } finally {fixture.dispose();assets.dispose();}
});

test('dense returns stay fine and subdued rather than hiding room silhouettes',()=>{
  const fixture=floorFixture(),assets=new Assets(),surface=createMemoryField([fixture.root],1024),surround=createCourtyard(assets,{width:32,depth:40});
  try {
    assert.equal(surround.pointCount,10000,'courtyard returns must use the lower residual budget');
    for(const [field,maxStrength,maxLineOpacity] of [[surface,.4,.065],[surround,.18,.04]] as const) {
      const points=field.group.children.find(node=>node instanceof THREE.Points) as THREE.Points;
      const material=points.material as THREE.ShaderMaterial;
      assert.ok(material.uniforms.uStrength.value<=maxStrength,'particles must not outshine agent silhouettes');
      assert.ok(material.uniforms.uPointSize?.value>0&&material.uniforms.uPointSize.value<=1.15,'largest point must remain a fine CSS-pixel return');
      assert.match(material.vertexShader,/uPointSize\s*\*\s*uPixelRatio/);
      assert.match(material.fragmentShader,/vec3 color=uColor\s*\*/,'density must not add a bright cyan/white palette');
      const lines=field.group.children.find(node=>node instanceof THREE.LineSegments) as THREE.LineSegments;
      assert.ok((lines.material as THREE.LineBasicMaterial).opacity<=maxLineOpacity,'scan streaks must also stay subordinate');
    }
  } finally {surface.dispose();surround.dispose();fixture.dispose();assets.dispose();}
});
