/** Static, world-space confidence: nearby returns belong to the same lost patch. */
function ease(value:number) {return value*value*(3-2*value);}
function ramp(low:number,high:number,value:number) {return ease(Math.max(0,Math.min(1,(value-low)/(high-low))));}
function lattice(x:number,y:number,z:number,salt:number) {
  let hash=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647)^salt;
  hash=Math.imul(hash^(hash>>>13),1274126177);
  return ((hash^(hash>>>16))>>>0)/4294967295;
}
function noise(x:number,y:number,z:number,salt:number) {
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),u=ease(x-ix),v=ease(y-iy),w=ease(z-iz);
  const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
  return mix(
    mix(mix(lattice(ix,iy,iz,salt),lattice(ix+1,iy,iz,salt),u),mix(lattice(ix,iy+1,iz,salt),lattice(ix+1,iy+1,iz,salt),u),v),
    mix(mix(lattice(ix,iy,iz+1,salt),lattice(ix+1,iy,iz+1,salt),u),mix(lattice(ix,iy+1,iz+1,salt),lattice(ix+1,iy+1,iz+1,salt),u),v),w);
}

/** Multi-meter missing regions, warped islands, then thin directional scan tears. */
export function reconstructionDensity(x:number,y:number,z:number) {
  const broad=noise(x*.11+8.3,y*.16+2.1,z*.11-1.7,113);
  const warp=(noise(x*.23+14,y*.18,z*.23-7,29)-.5)*1.9;
  const island=noise(x*.38+warp,y*.32+3.4,z*.38-warp,613);
  const coverage=ramp(.5,.74,broad*.78+island*.22);
  if(coverage===0)return 0;
  const fragment=noise(x*.9+warp,y*.65,z*.9,347);
  // The long axis follows x, unlike isotropic white-noise thinning.
  const tear=noise(x*.14+warp*.1,y*2.8+z*.14,z*1.7,911);
  return coverage*ramp(.25,.56,fragment)*ramp(.29,.47,tear);
}
