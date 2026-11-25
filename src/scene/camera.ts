export function framingFor(width: number, height: number): { width: number; height: number } {
  const aspect = Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : 16 / 9;
  // Portrait intentionally frames the middle of the office; it does not shrink
  // the entire diorama to a tiny strip. Wider embeds reveal the courtyard.
  const worldHeight = aspect < .85 ? 18.5 : Math.max(10.8, 19.8 / aspect);
  return { width: worldHeight * aspect, height: worldHeight };
}
export function pixelRatioFor(width: number, height: number, deviceRatio: number): number {
  const pixels = Math.max(1, Number.isFinite(width) ? width : 1) * Math.max(1, Number.isFinite(height) ? height : 1);
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.min(ratio, width < 600 ? 1.25 : 1.65, Math.sqrt(3_000_000 / pixels));
}
/** Perspective, but with the same deliberate visible-height contract as the original framing. */
export function memoryLens(width:number,height:number,distance:number):{aspect:number;fov:number}{
  const aspect=Number.isFinite(width/height)&&width>0&&height>0?width/height:16/9;
  const d=Number.isFinite(distance)&&distance>0?distance:25;
  const fov=2*Math.atan(framingFor(width,height).height/(2*d))*180/Math.PI;
  return {aspect,fov:Math.max(20,Math.min(55,fov))};
}

