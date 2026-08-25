'use client';

import type { ChangeEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | 'email' | 'number';
  mono?: boolean;
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  testId?: string;
}

/** Same props as before; shadcn Input and Label underneath. */
export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  mono = false,
  hint,
  error,
  required,
  placeholder,
  testId,
}: TextFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-secondary-foreground">
        {label}
        {required ? ' *' : ''}
      </Label>
      <Input
        className={cn(mono && 'font-mono text-[length:var(--text-mono)]', error && 'border-destructive')}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        data-testid={testId}
      />
      {hint ? <p className="text-[length:var(--text-small)] text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-[length:var(--text-small)] text-destructive">{error}</p> : null}
    </div>
  );
}
