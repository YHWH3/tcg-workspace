import { cloneElement, isValidElement, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { placePopover } from './popoverPosition';
import { X, type LucideIcon } from 'lucide-react';
import { cn, initials } from './utils';
import { useIsMobile, useVisualViewport } from './mobile';
import { avatarTextColor } from './avatarColor';

/* ---------- Overlay layer stack (platform spec §8) ----------
 * Every dismissible layer (dialog/sheet/adaptive surface, open popover)
 * registers here so Escape closes ONLY the topmost one, and the topmost
 * portal makes the rest of the app inert. */
interface OverlayLayer {
  id: symbol;
  /** Portal root when the layer is a modal surface — used for inerting. */
  portal?: HTMLElement;
}
const layerStack: OverlayLayer[] = [];
let inerted: Element[] = [];

function isTopLayer(id: symbol): boolean {
  return layerStack[layerStack.length - 1]?.id === id;
}
function pushLayer(l: OverlayLayer): void {
  layerStack.push(l);
}
function removeLayer(id: symbol): void {
  const i = layerStack.findIndex((l) => l.id === id);
  if (i >= 0) layerStack.splice(i, 1);
}
function applyInert(): void {
  for (const el of inerted) el.removeAttribute('inert');
  inerted = [];
  const top = [...layerStack].reverse().find((l) => l.portal)?.portal;
  if (!top) return;
  for (const child of Array.from(document.body.children)) {
    if (child !== top && !child.hasAttribute('inert')) {
      child.setAttribute('inert', '');
      inerted.push(child);
    }
  }
}

/* ---------- Button ---------- */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'icon' }) {
  const styles: Record<BtnVariant, string> = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 shadow-sm',
    secondary: 'bg-neutral-100 text-neutral-800 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700',
    ghost: 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
    danger: 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40',
    outline: 'border border-neutral-200 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
  };
  const sizes = { sm: 'h-7 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', icon: 'h-8 w-8' };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors select-none',
        'disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400',
        styles[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button variant="ghost" size="icon" className={cn('h-7 w-7 text-neutral-400', className)} {...props} />;
}

/* ---------- Inputs ---------- */
// Defaults live in the components layer so caller utilities override them.
// Compact density grows with its text instead of imposing a clipping height.
const inputCls = 'ws-input';
type ControlDensity = { density?: 'normal' | 'compact' };

export function Input({ className, density = 'normal', ...props }: InputHTMLAttributes<HTMLInputElement> & ControlDensity) {
  return <input className={cn(inputCls, density === 'compact' && 'ws-input-compact', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputCls, 'min-h-16 resize-none', className)} {...props} />;
}

export function Select({ className, children, density = 'normal', style, ...props }: SelectHTMLAttributes<HTMLSelectElement> & ControlDensity) {
  return (
    <select className={cn(inputCls, density === 'compact' && 'ws-input-compact', 'appearance-none pr-8 bg-no-repeat cursor-pointer', className)} style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundPosition: 'right 0.6rem center', ...style }} {...props}>
      {children}
    </select>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-600 dark:text-neutral-400">{hint}</span>}
    </label>
  );
}

/* ---------- Avatar ---------- */
export function Avatar({ name, color, size = 24, className }: { name: string; color?: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className)}
      style={{ backgroundColor: color ?? '#666', color: avatarTextColor(color ?? '#666'), width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

/* ---------- Popover ---------- */
export function Popover({
  trigger,
  children,
  align = 'left',
  className,
  open,
  onOpenChange,
  adaptive,
  label = 'Menu',
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Present as a bottom sheet on compact layouts (platform §4/§8). */
  adaptive?: boolean;
  label?: string;
}) {
  const nativeTrigger = isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(trigger) &&
    (trigger.type === 'button' || trigger.type === Button || trigger.type === IconButton);
  const [internal, setInternal] = useState(false);
  const isOpen = open ?? internal;
  const setOpen = (v: boolean) => {
    setInternal(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layerId = useRef(Symbol('popover'));
  const compact = useIsMobile();
  const sheetMode = adaptive === true && compact;
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useEffect(() => {
    // In sheet mode the Overlay below owns dismissal/stacking.
    if (!isOpen || sheetMode) return;
    pushLayer({ id: layerId.current });
    const prevFocus = document.activeElement as HTMLElement | null;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const next = placePopover(r, {width: panelRef.current?.offsetWidth ?? 0, height: panelRef.current?.offsetHeight ?? 0}, {width: window.innerWidth, height: window.innerHeight}, align);
      setPos(p => p && p.left === next.left && p.top === next.top && p.width === next.width ? p : next);
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopLayer(layerId.current)) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      removeLayer(layerId.current);
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      // Return focus to the trigger (or whatever had focus).
      (triggerRef.current?.isConnected ? triggerRef.current.querySelector<HTMLElement>('button') ?? triggerRef.current : prevFocus?.isConnected ? prevFocus : null)?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sheetMode]);
  // Measure before paint and again when menu content changes. Footer triggers
  // need the same viewport collision handling as toolbar triggers.
  const positioned = pos !== null;
  useLayoutEffect(() => {
    if (!isOpen || sheetMode || !positioned || !panelRef.current) return;
    const update = () => {
      const trigger = triggerRef.current?.getBoundingClientRect(), panel = panelRef.current;
      if (!trigger || !panel) return;
      const next = placePopover(trigger, {width: panel.offsetWidth, height: panel.offsetHeight}, {width: innerWidth, height: innerHeight}, align);
      setPos(p => p && p.left === next.left && p.top === next.top && p.width === next.width ? p : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [isOpen, sheetMode, positioned, align]);
  return (
    <div ref={ref} className="relative inline-block">
      <span
        ref={triggerRef}
        role={nativeTrigger ? undefined : "button"}
        tabIndex={nativeTrigger ? undefined : 0}
        aria-haspopup={nativeTrigger ? undefined : true}
        aria-expanded={nativeTrigger ? undefined : isOpen}
        onClick={(e) => { e.stopPropagation(); setOpen(!isOpen); }}
        onKeyDown={(e) => {
          if (!nativeTrigger && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); setOpen(!isOpen); }
        }}
        className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
      >
        {nativeTrigger ? cloneElement(trigger, { 'aria-haspopup': true, 'aria-expanded': isOpen }) : trigger}
      </span>
      {isOpen && sheetMode ? (
        <Overlay onClose={() => setOpen(false)} label={label} className="flex flex-col justify-end">
          <div className="anim-slide-bottom mt-auto max-h-[85%] w-full overflow-y-auto rounded-t-2xl border-t border-neutral-200 bg-white pb-safe shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
            {children(() => setOpen(false))}
          </div>
        </Overlay>
      ) : isOpen && pos ? (
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: pos.width }}
            className={cn(
              'anim-slide-up z-50 max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900',
              className,
            )}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}

/* ---------- Menu ---------- */
export interface MenuItem {
  label?: string;
  icon?: LucideIcon;
  danger?: boolean;
  onClick?: () => void;
  node?: ReactNode;
}

export function Menu({ items, close }: { items: (MenuItem | 'divider')[]; close: () => void }) {
  return (
    <div className="p-1 text-sm">
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={i} className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
        ) : item.node ? (
          <div key={i}>{item.node}</div>
        ) : (
          <button
            key={i}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
              item.danger
                ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
                : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
            )}
            onClick={() => {
              close();
              item.onClick?.();
            }}
          >
            {item.icon && <item.icon size={15} strokeWidth={1.8} />}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

/* ---------- Overlay shells ----------
 * Shared layer behavior: registers on the overlay stack (Escape reaches
 * only the topmost layer), traps Tab focus, returns focus to whatever was
 * focused before, inerts background content, locks body scroll while any
 * overlay is open, and fits inside the visual viewport (--vvh/--vvo, so the
 * software keyboard never covers fields). `guard` vets Escape/outside
 * dismiss — return false to keep unsaved work mounted (platform §7/§8).
 * Presentation changes (e.g. adaptive breakpoints) never remount children:
 * only the wrapper layout shifts, so in-progress input stays alive. */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

let overlayDepth = 0;

function Overlay({
  children,
  onClose,
  className,
  label,
  labelledBy,
  guard,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  label?: string;
  labelledBy?: string;
  /** Return false to refuse Escape / outside dismiss (unsaved content). */
  guard?: () => boolean;
}) {
  const portalRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const guardRef = useRef(guard);
  guardRef.current = guard;

  useEffect(() => {
    const layer: OverlayLayer = { id: Symbol('overlay'), portal: portalRef.current ?? undefined };
    pushLayer(layer);
    applyInert();
    overlayDepth++;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement as HTMLElement | null;
    const surface = surfaceRef.current;
    const focusables = () =>
      Array.from(surface?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => !el.closest('[inert]') && el.offsetParent !== null,
      );
    const requestClose = () => {
      if (guardRef.current && guardRef.current() === false) return;
      onCloseRef.current();
    };
    (surface?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? surface)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isTopLayer(layer.id)) {
          e.preventDefault();
          requestClose();
        }
        return;
      }
      if (e.key === 'Tab' && surface && isTopLayer(layer.id)) {
        const f = focusables();
        e.preventDefault();
        if (!f.length) {
          surface.focus();
          return;
        }
        const active = document.activeElement as HTMLElement | null;
        const index = active ? f.indexOf(active) : -1;
        const next = f[(index + (e.shiftKey ? -1 : 1) + f.length) % f.length];
        next.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      removeLayer(layer.id);
      document.removeEventListener('keydown', onKey, true);
      overlayDepth--;
      if (!overlayDepth) document.body.style.overflow = '';
      applyInert();
      if (prevFocus?.isConnected) prevFocus.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the focused field above a freshly opened software keyboard.
  const vv = useVisualViewport();
  useEffect(() => {
    if (vv.keyboardOpen) (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [vv.keyboardOpen]);

  const close = () => {
    if (guardRef.current && guardRef.current() === false) return;
    onCloseRef.current();
  };

  return createPortal(
    <div
      ref={portalRef}
      className="anim-fade fixed inset-x-0 top-0 z-50 bg-black/40 backdrop-blur-[2px]"
      style={{ top: 'var(--vvo, 0px)', height: 'var(--vvh, 100dvh)' }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn('outline-none', className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface OverlayProps {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  /** Return false to refuse Escape/outside dismiss — protects unsaved content. */
  guard?: () => boolean;
}

export function Dialog({ children, onClose, title, guard }: OverlayProps) {
  const titleId = useId();
  return (
    <Overlay onClose={onClose} guard={guard} labelledBy={title ? titleId : undefined} label={title ? undefined : 'Dialog'} className="flex h-full items-center justify-center p-4">
      <div className="anim-slide-up w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        {title && (
          <div className="mb-3 flex items-center justify-between">
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
            <IconButton onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </Overlay>
  );
}

/** Dialog on medium/expanded, bottom sheet on compact — same mounted children. */
export function AdaptiveDialog({ children, onClose, title, guard }: OverlayProps) {
  const compact = useIsMobile();
  const titleId = useId();
  return (
    <Overlay
      onClose={onClose}
      guard={guard}
      labelledBy={title ? titleId : undefined}
      label={title ? undefined : 'Dialog'}
      className={cn('flex h-full min-h-0', compact ? 'flex-col justify-end' : 'items-center justify-center p-4')}
    >
      <div
        className={cn(
          'flex min-h-0 flex-col border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900',
          compact ? 'anim-slide-bottom max-h-[92%] w-full rounded-t-2xl border-t pb-safe' : 'anim-slide-up max-h-full w-full max-w-md rounded-2xl border p-5',
        )}
      >
        {title && (
          <div className={cn('flex shrink-0 items-center justify-between', compact ? 'px-4 pb-2 pt-4' : 'mb-3')}>
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
            <IconButton onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className={cn('min-h-0 overflow-y-auto', compact && 'px-4 pb-4')}>{children}</div>
      </div>
    </Overlay>
  );
}

export function Sheet({ children, onClose, side = 'right', label, guard }: { children: ReactNode; onClose: () => void; side?: 'right' | 'left' | 'bottom' | 'full'; label?: string; guard?: () => boolean }) {
  const anim = side === 'right' ? 'anim-slide-right' : side === 'left' ? 'anim-slide-left' : 'anim-slide-bottom';
  const pos =
    side === 'right'
      ? 'ml-auto h-full w-full sm:w-[420px] sm:max-w-[92vw] border-l pr-safe'
      : side === 'left'
        ? 'mr-auto h-full w-[280px] max-w-[85vw] border-r pl-safe'
        : side === 'full'
          ? 'h-full w-full p-safe'
          : 'mt-auto h-[92%] w-full rounded-t-2xl border-t pb-safe';
  return (
    <Overlay onClose={onClose} guard={guard} label={label ?? 'Panel'} className="flex h-full flex-col">
      <div className={cn(anim, 'flex flex-col overflow-hidden border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950', pos)}>
        {children}
      </div>
    </Overlay>
  );
}

/* ---------- Misc ---------- */
export function EmptyState({ icon: Icon, title, body, action }: { icon?: LucideIcon | ComponentType<{ size?: number | string; className?: string }>; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {Icon && <Icon size={28} className="text-neutral-300 dark:text-neutral-600" />}
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{title}</p>
      {body && <p className="max-w-xs text-xs text-neutral-500 dark:text-neutral-400">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={cn('animate-spin text-neutral-400', className)} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full bg-blue-500', className)} />;
}
