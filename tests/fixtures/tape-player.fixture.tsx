import {render} from 'solid-js/web';
import {createSignal} from 'solid-js';
// A plain fixture and positive control work before the optional player exists.
const modules=import.meta.glob('../../src/lib/trace-player.ts');
const load=modules['../../src/lib/trace-player.ts'];
type Mod=typeof import('../../src/lib/trace-player.ts');
function Fixture(props:{factory:Mod['createTracePlayer']}){
  const [allowed,setAllowed]=createSignal(false),[open,setOpen]=createSignal(false),[target,setTarget]=createSignal(0);
  const p=props.factory(allowed,open);
  return <><button onClick={()=>setAllowed(!allowed())}>Toggle eligible</button><button onClick={()=>setOpen(!open())}>Toggle editor</button><button onClick={()=>p.pause()}>Hold</button><button onClick={()=>p.play(-4)}>Reverse</button><button onClick={()=>p.goLive()}>Live head</button><button onClick={()=>p.refresh()}>Refresh head</button><button onClick={()=>p.seek(target())}>Seek</button><button onClick={()=>p.openArchive(target())}>Old hour</button><input aria-label="Target time" type="number" onInput={e=>setTarget(e.currentTarget.valueAsNumber)}/><output id="state" data-mode={p.live()?'live':p.archived()?'archive':'replay'} data-cursor={p.cursorMs()} data-rate={p.rate()} data-coverage={p.frame()?.coverage??'gap'} data-count={p.frame()?.actors.length??-1} data-export={p.completeHour()?'yes':'no'} data-sample={p.frame()?.atMs??0} data-tape-state={p.tape()?(p.tape()!.actors.length?'actors':'empty'):'absent'} data-speed={p.tape()?.rate??0} data-frames={p.window()?.frames.length??0} data-error={p.error()??''} data-loading={p.loading()?'yes':'no'}>ready</output></>;
}
const root=document.getElementById('root')!;root.textContent='Fixture loaded';if(load){load().then(m=>{root.replaceChildren();render(()=><Fixture factory={(m as Mod).createTracePlayer}/>,root);});}
