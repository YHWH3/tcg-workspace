import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Check, ChevronDown, KanbanSquare, Users } from 'lucide-react';
import { LAST_APP_STORAGE_KEY, useCrmStatus } from './crmStatus';
import { placePopover } from './popoverPosition';
import { cn } from './utils';

interface AppSwitcherProps {
  current: 'workspace' | 'crm';
  fallback?: ReactNode;
  compact?: boolean;
  onSelect?: () => void;
  className?: string;
}

const APPS = [
  {
    id: 'workspace' as const,
    label: 'Workspace',
    description: 'Pages, boards, tasks and team files',
    path: '/',
    icon: KanbanSquare,
  },
  {
    id: 'crm' as const,
    label: 'CRM',
    description: 'Contacts, access controls and operations',
    path: '/crm',
    icon: Users,
  },
];

export function AppSwitcher({ current, fallback, compact = false, onSelect, className }: AppSwitcherProps) {
  const crm = useCrmStatus();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number>(current === 'crm' ? 1 : 0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const available = Boolean(crm.data?.enabled && crm.data?.access);
  const showSwitcher = current === 'crm' || available;

  useEffect(() => {
    if (!showSwitcher && open) {
      setOpen(false);
    }
  }, [showSwitcher, open]);

  useEffect(() => {
    if (!open) return;

    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = placePopover(
        rect,
        { width: menuRef.current?.offsetWidth ?? 272, height: menuRef.current?.offsetHeight ?? 144 },
        { width: window.innerWidth, height: window.innerHeight },
        'left',
      );
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width ? prev : next));
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pos) return;
    const raf = requestAnimationFrame(() => {
      itemRefs.current[focusIndex]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, pos, focusIndex]);

  if (!showSwitcher) {
    return <>{fallback ?? null}</>;
  }

  const openWithFocus = (index: number) => {
    setFocusIndex(index);
    setOpen(true);
  };

  const selectApp = (app: (typeof APPS)[number]) => {
    setOpen(false);
    try {
      localStorage.setItem(LAST_APP_STORAGE_KEY, app.id);
    } catch {
      /* preference only */
    }
    onSelect?.();
    navigate(app.path);
  };

  const currentLabel = current === 'crm' ? 'CRM' : 'Workspace';
  const currentMonogram = current === 'crm' ? 'C' : 'W';

  return (
    <div className={cn('relative inline-flex max-w-full', className)}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="app-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openWithFocus(current === 'crm' ? 1 : 0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openWithFocus(0);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openWithFocus(APPS.length - 1);
          }
        }}
        className={cn(
          'inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-semibold tracking-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
          current === 'crm'
            ? 'text-[var(--crm-text)] hover:bg-[var(--crm-surface-2)] focus-visible:outline-[var(--crm-primary)]'
            : 'text-neutral-900 hover:bg-neutral-100 focus-visible:outline-neutral-500 dark:text-neutral-100 dark:hover:bg-neutral-800',
          compact && 'w-[44px] justify-center px-0',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md text-[11px] font-bold',
            current === 'crm'
              ? 'bg-[var(--crm-primary)] text-white dark:text-[#14161A]'
              : 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900',
          )}
        >
          {currentMonogram}
        </span>
        {compact ? (
          <span className="sr-only">{currentLabel} — switch application</span>
        ) : (
          <>
            <span className="truncate">
              {currentLabel}
              <span className="sr-only"> — switch application</span>
            </span>
            <ChevronDown size={14} aria-hidden="true" className="shrink-0 opacity-70" />
          </>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div data-app={current === 'crm' ? 'crm' : undefined}>
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label="Switch application"
              data-testid="app-switcher-menu"
              style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: Math.max(pos.width, 264) }}
              className={cn(
                'z-50 max-w-[calc(100vw-16px)] rounded-xl border p-1.5 shadow-lg',
                current === 'crm'
                  ? 'border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text)]'
                  : 'border-neutral-200 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100',
              )}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const next = (focusIndex + 1) % APPS.length;
                  setFocusIndex(next);
                  itemRefs.current[next]?.focus();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  const next = (focusIndex - 1 + APPS.length) % APPS.length;
                  setFocusIndex(next);
                  itemRefs.current[next]?.focus();
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setFocusIndex(0);
                  itemRefs.current[0]?.focus();
                } else if (e.key === 'End') {
                  e.preventDefault();
                  const last = APPS.length - 1;
                  setFocusIndex(last);
                  itemRefs.current[last]?.focus();
                }
              }}
            >
              {APPS.map((app, idx) => {
                const active = app.id === current;
                const Icon = app.icon;
                return (
                  <button
                    key={app.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => selectApp(app)}
                    className={cn(
                      'flex min-h-11 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
                      current === 'crm'
                        ? active
                          ? 'bg-[var(--crm-surface-2)] focus-visible:outline-[var(--crm-primary)]'
                          : 'hover:bg-[var(--crm-surface-2)] focus-visible:outline-[var(--crm-primary)]'
                        : active
                          ? 'bg-neutral-100 focus-visible:outline-neutral-500 dark:bg-neutral-800'
                          : 'hover:bg-neutral-100 focus-visible:outline-neutral-500 dark:hover:bg-neutral-800',
                    )}
                  >
                    <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 opacity-80" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span>{app.label}</span>
                        {active && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                              current === 'crm'
                                ? 'bg-[var(--crm-primary)] text-white dark:text-[#14161A]'
                                : 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900',
                            )}
                          >
                            <Check size={11} aria-hidden="true" />
                            <span>Current</span>
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 block text-xs',
                          current === 'crm'
                            ? 'text-[var(--crm-text-muted)]'
                            : 'text-neutral-600 dark:text-neutral-400',
                        )}
                      >
                        {app.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
