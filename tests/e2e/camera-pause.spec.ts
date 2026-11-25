import {test,expect} from '@playwright/test';

for(const trigger of ['pause','reduced motion'] as const){
  test(`${trigger} settles a camera flight already in progress`,async({page})=>{
    await page.goto('/?source=demo&team=all');
    await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
    await expect.poll(async()=>Number(await page.getByTestId('scene-canvas').getAttribute('data-memory-time'))).toBeGreaterThan(.5);
    if(trigger==='pause'){
      await page.getByRole('button',{name:'Open team',exact:true}).click();
      await page.getByRole('navigation',{name:'Teams'}).getByRole('button',{name:/^Development,/}).click();
      await page.getByRole('dialog').getByRole('button',{name:'Open view controls',exact:true}).click();
      await page.getByRole('button',{name:'Pause animation',exact:true}).click();
    }else{
      await page.getByTitle('Focus Development',{exact:true}).click();
      await page.emulateMedia({reducedMotion:'reduce'});
    }
    const marker=page.getByTitle('Focus Development',{exact:true});
    const projectedPosition=()=>marker.evaluate(el=>({x:parseFloat((el as HTMLElement).style.left),y:parseFloat((el as HTMLElement).style.top)}));
    // The marker is projected from a fixed point in the room by the real camera.
    // Its motion therefore catches camera interpolation, not just a flag change.
    await page.waitForTimeout(200);
    const first=await projectedPosition();
    await page.waitForTimeout(400);
    const second=await projectedPosition();
    expect(Math.hypot(second.x-first.x,second.y-first.y)).toBeLessThan(.1);
    await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-focus','development');
    await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-agents','33');
  });
}
