'use client';

import type { ChangeEvent } from 'react';

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
    <label className="q-field">
      <span className="q-field__label">
        {label}
        {required ? ' *' : ''}
      </span>
      <input
        className={mono ? 'q-input q-input--mono' : 'q-input'}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        data-testid={testId}
      />
      {hint ? <span className="q-field__hint">{hint}</span> : null}
      {error ? <span className="q-field__error">{error}</span> : null}
    </label>
  );
}
