import { createContext, createSignal, createUniqueId, onCleanup, onMount, Show, useContext, type Accessor, type JSX, type ParentProps } from 'solid-js';
import { Icon, type IconName } from './Icon.tsx';

type TooltipState = { open: Accessor<string | null>; show(id: string): void; hide(id?: string): void };
const Tooltips = createContext<TooltipState>();
/** One tooltip owner/listener for the standalone controls; never mounted in embeds. */
export function IconControls(props: ParentProps) {
  const [open, setOpen] = createSignal<string | null>(null);
  const hide = (id?: string) => { if (!id || open() === id) setOpen(null); };
  onMount(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('keydown', dismiss);
    onCleanup(() => document.removeEventListener('keydown', dismiss));
  });
  return <Tooltips.Provider value={{ open, show: setOpen, hide }}>{props.children}</Tooltips.Provider>;
}
export function IconControl(props: {
  icon: IconName; label: string; onClick?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  active?: boolean; pressed?: boolean; expanded?: boolean; popup?: boolean; disabled?: boolean;
  badge?: string | number; class?: string; autoFocus?: boolean;
  tipSide?: 'top' | 'bottom'; tipAlign?: 'start' | 'center' | 'end';
}) {
  const tips = useContext(Tooltips), id = `control-${createUniqueId()}`;
  let button!: HTMLButtonElement;
  const shown = () => tips?.open() === id;
  return <span class="control-wrap" data-tip-side={props.tipSide ?? 'top'} data-tip-align={props.tipAlign ?? 'center'}
    onMouseEnter={() => tips?.show(id)} onMouseLeave={() => { if (document.activeElement !== button) tips?.hide(id); }}>
    <button ref={button} type="button" class={`icon-control ${props.class ?? ''}`} classList={{ active: Boolean(props.active || props.pressed) }}
      aria-label={props.label} aria-describedby={shown() ? id : undefined}
      aria-pressed={props.pressed} aria-expanded={props.expanded}
      aria-haspopup={props.popup ? 'dialog' : undefined} aria-controls={props.popup ? 'office-panel' : undefined}
      disabled={props.disabled} data-panel-focus={props.autoFocus ? '' : undefined}
      title={tips ? undefined : props.label}
      onFocus={() => { if (button.matches(':focus-visible')) tips?.show(id); }} onBlur={() => tips?.hide(id)}
      onClick={event => { tips?.hide(); props.onClick?.(event); }}>
      <Icon name={props.icon} size={21}/>
      <Show when={props.badge !== undefined}><span class="control-badge" aria-hidden="true">{props.badge}</span></Show>
    </button>
    <Show when={shown()}><span id={id} role="tooltip" class="control-tip">{props.label}</span></Show>
  </span>;
}
/** Native Tab behavior plus fast horizontal movement in icon toolbars. */
export const moveToolbarFocus: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (Math.max(0, current) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); buttons[next].focus();
};
