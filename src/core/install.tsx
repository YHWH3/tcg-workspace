import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import { Button, Popover } from './ui';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallButton({ className }: { className?: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const mq = matchMedia('(display-mode: standalone)');
    const onChange = () => setStandalone(mq.matches);
    window.addEventListener('beforeinstallprompt', onPrompt);
    mq.addEventListener('change', onChange);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      mq.removeEventListener('change', onChange);
    };
  }, []);

  if (standalone) return null;

  if (deferred) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={className ?? 'w-full justify-start'}
        onClick={() => {
          void deferred.prompt();
          deferred.userChoice.then(() => setDeferred(null));
        }}
      >
        <Download size={15} />
        Install app
      </Button>
    );
  }

  if (isIOS()) {
    return (
      <Popover
        trigger={
          <Button variant="ghost" size="sm" className={className ?? 'w-full justify-start'}>
            <Download size={15} />
            Install app
          </Button>
        }
      >
        {() => (
          <div className="flex max-w-56 items-start gap-2 p-3 text-xs text-neutral-600 dark:text-neutral-300">
            <Share size={14} className="mt-0.5 shrink-0" />
            <span>
              Tap <b>Share</b> in Safari, then <b>Add to Home Screen</b> to install this app.
            </span>
          </div>
        )}
      </Popover>
    );
  }

  return null;
}
