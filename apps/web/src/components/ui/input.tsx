import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-base text-fg',
        'transition-[border-color,box-shadow] duration-150 ease-smooth',
        'placeholder:text-fg-faint',
        'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'aria-invalid:border-critical aria-invalid:focus-visible:ring-critical/20',
        className,
      )}
      {...props}
    />
  );
}
