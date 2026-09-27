import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import { cn, initials } from './utils';

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
const inputCls =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 transition-shadow focus:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-600 dark:focus:ring-white/10';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputCls, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputCls, 'min-h-16 resize-none', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputCls, 'appearance-none pr-8 bg-no-repeat cursor-pointer', className)} style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundPosition: 'right 0.6rem center' }} {...props}>
      {children}
    </select>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}

/* ---------- Avatar ---------- */
export function Avatar({ name, color, size = 24, className }: { name: string; color?: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ backgroundColor: color ?? '#666', width: size, height: size, fontSize: size * 0.42 }}
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
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(false);
  const isOpen = open ?? internal;
  const setOpen = (v: boolean) => {
    setInternal(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);
  return (
    <div ref={ref} className="relative inline-block">
      <span onClick={(e) => { e.stopPropagation(); setOpen(!isOpen); }} className="inline-flex">
        {trigger}
      </span>
      {isOpen && (
        <div
          className={cn(
            'anim-slide-up absolute z-50 mt-1 min-w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900',
            align === 'right' ? 'right-0' : align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
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

/* ---------- Overlay shells ---------- */
function Overlay({ children, onClose, className }: { children: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return createPortal(
    <div className="anim-fade fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={className}>{children}</div>
    </div>,
    document.body,
  );
}

export function Dialog({ children, onClose, title }: { children: ReactNode; onClose: () => void; title?: string }) {
  return (
    <Overlay onClose={onClose} className="flex h-full items-center justify-center p-4">
      <div className="anim-slide-up w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        {title && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{title}</h2>
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

export function Sheet({ children, onClose, side = 'right' }: { children: ReactNode; onClose: () => void; side?: 'right' | 'left' | 'bottom' }) {
  const anim = side === 'right' ? 'anim-slide-right' : side === 'left' ? 'anim-slide-left' : 'anim-slide-bottom';
  const pos =
    side === 'right'
      ? 'ml-auto h-full w-full sm:w-[420px] sm:max-w-[92vw] border-l'
      : side === 'left'
        ? 'mr-auto h-full w-[280px] max-w-[85vw] border-r'
        : 'mt-auto h-[92%] w-full rounded-t-2xl border-t';
  return (
    <Overlay onClose={onClose} className="flex h-full flex-col">
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
      {body && <p className="max-w-xs text-xs text-neutral-400">{body}</p>}
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
