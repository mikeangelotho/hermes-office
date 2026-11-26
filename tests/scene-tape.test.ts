import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createDataTrails } from '../src/scene/data-trails.ts';
import { Character } from '../src/scene/character.ts';
import { Assets } from '../src/scene/room.ts';

test('rewinding a trail buffer erases future particles rather than resurrecting them when time catches up', () => {
  const effect = createDataTrails(2), head = new THREE.Group(), subjects = [{head,hands:[]}];
  try {
    effect.update(25,subjects,false); head.position.x = 2; effect.update(25.2,subjects,false);
    assert.ok(effect.active > 0, 'positive control: a moving head writes a real trail');
    effect.update(10,subjects,false);
    effect.update(25.22,subjects,false);
    assert.equal(effect.active,0,'an erased future cannot reappear');
    head.position.x = 3; effect.update(25.4,subjects,false);
    assert.ok(effect.active > 0,'real movement can emit on the new clock');
    effect.update(25.5,subjects,true);
    assert.equal(effect.points.geometry.drawRange.count,2,'a held picture submits only the head and chest halos');
  } finally { effect.dispose(); }
});

test('removing a future subject also invalidates its unconditional halo draws on return to live', () => {
  const effect = createDataTrails(2), a = new THREE.Group(), b = new THREE.Group();
  try {
    const lone = [{head:a,hands:[]}]; effect.update(10, [...lone,{head:b,hands:[]}], false);
    const kind = effect.points.geometry.attributes.aKind;
    assert.ok(kind.getX(2)>.5 && kind.getX(3)>.5,'both halo slots for the second actor were real');
    effect.update(2, lone, true); effect.update(2.1,lone,false);
    assert.ok(kind.getX(2)<.5 && kind.getX(3)<.5,'removed actors must not leave immortal additive halos');
  } finally {effect.dispose();}
});

test('the sampled working motion follows a stable participant, not its seat index', () => {
  const assets=new Assets(), tex=new THREE.Texture();
  const make = (id:string,seat:number) => new Character(assets,{id,team:'general',state:'working',name:'Fixture',role:'Fixture',activity:'',observedAt:''},seat,tex);
  const a=make('p-'+'1'.repeat(32),0), moved=make('p-'+'1'.repeat(32),3), b=make('p-'+'2'.repeat(32),0);
  const hands=(c:Character)=>c.hands.map(h=>h.position.toArray());
  try {
    for(const c of [a,moved,b]) c.poseAt(1_800_000_012_345,false);
    assert.deepEqual(hands(a),hands(moved)); assert.notDeepEqual(hands(a),hands(b));
    a.poseAt(1_800_000_012_345,true); const still=hands(a); a.poseAt(1_800_000_019_123,true); assert.deepEqual(hands(a),still);
  } finally {for(const c of [a,moved,b])c.dispose(); assets.dispose(); tex.dispose();}
});
