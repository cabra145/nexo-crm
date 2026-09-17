import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  info: { icon: Info, box: 'border-info/30 bg-info-subtle', text: 'text-info' },
  positive: {
    icon: CheckCircle2,
    box: 'border-positive/30 bg-positive-subtle',
    text: 'text-positive',
  },
  warning: {
    icon: AlertTriangle,
    box: 'border-warning/40 bg-warning-subtle',
    text: 'text-warning',
  },
  critical: { icon: XCircle, box: 'border-critical/30 bg-critical-subtle', text: 'text-critical' },
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, box, text } = TONES[tone];
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border px-3.5 py-3 text-sm', box, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', text)} aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-fg">{title}</p>
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
    </div>
  );
}
