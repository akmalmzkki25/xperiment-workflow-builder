'use client';

import { useState } from 'react';
import { NativeSelect } from '@/components/common/NativeSelect';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { fieldValueToParam, type FormField } from '../../lib/schemaForm';

function initialText(field: FormField, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (field.kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Schema-driven parameter form. Text/number/json fields commit on blur so
 * expression typing isn't interrupted; select/boolean commit immediately.
 * Remount with key={nodeId} when the target node changes.
 */
export function SchemaForm({
  fields,
  values,
  onCommit,
}: {
  fields: FormField[];
  values: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
}) {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialText(f, values[f.name])])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const commitText = (field: FormField) => {
    const raw = texts[field.name] ?? '';
    try {
      const value = fieldValueToParam(field, raw);
      setErrors((prev) => ({ ...prev, [field.name]: '' }));
      onCommit(field.name, value);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [field.name]: e instanceof Error ? e.message : 'Invalid value' }));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {fields.map((field) => {
        const error = errors[field.name];
        if (field.kind === 'boolean') {
          return (
            <label key={field.name} className="flex flex-col gap-1.5" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={values[field.name] === true}
                onChange={(e) => onCommit(field.name, e.target.checked)}
                data-testid={`field-${field.name}`}
              />
              <span className="text-[length:var(--text-small)] font-medium text-secondary-foreground">{field.label}</span>
            </label>
          );
        }
        if (field.kind === 'select') {
          return (
            <label key={field.name} className="flex flex-col gap-1.5">
              <span className="text-[length:var(--text-small)] font-medium text-secondary-foreground">
                {field.label}
                {field.required ? ' *' : ''}
              </span>
              <NativeSelect
                value={String(values[field.name] ?? '')}
                onChange={(e) => onCommit(field.name, e.target.value)}
                data-testid={`field-${field.name}`}
              >
                {!field.required ? <option value="">—</option> : null}
                {(field.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </NativeSelect>
            </label>
          );
        }
        if (field.kind === 'json') {
          return (
            <label key={field.name} className="flex flex-col gap-1.5">
              <span className="text-[length:var(--text-small)] font-medium text-secondary-foreground">
                {field.label}
                {field.required ? ' *' : ''}
              </span>
              <Textarea
                value={texts[field.name] ?? ''}
                onChange={(e) => setTexts((prev) => ({ ...prev, [field.name]: e.target.value }))}
                onBlur={() => commitText(field)}
                spellCheck={false}
                data-testid={`field-${field.name}`}
              />
              <span className="text-[length:var(--text-small)] text-muted-foreground">JSON — expressions like {'{{ trigger.body.x }}'} allowed in strings</span>
              {error ? <span className="text-[length:var(--text-small)] text-destructive">{error}</span> : null}
            </label>
          );
        }
        return (
          <label key={field.name} className="flex flex-col gap-1.5">
            <span className="text-[length:var(--text-small)] font-medium text-secondary-foreground">
              {field.label}
              {field.required ? ' *' : ''}
            </span>
            <Input
              className={field.kind === 'number' ? undefined : 'font-mono text-[length:var(--text-mono)]'}
              type="text"
              inputMode={field.kind === 'number' ? 'numeric' : undefined}
              value={texts[field.name] ?? ''}
              onChange={(e) => setTexts((prev) => ({ ...prev, [field.name]: e.target.value }))}
              onBlur={() => commitText(field)}
              spellCheck={false}
              data-testid={`field-${field.name}`}
            />
            {field.kind === 'text' ? <span className="text-[length:var(--text-small)] text-muted-foreground">Supports {'{{ }}'} expressions</span> : null}
            {error ? <span className="text-[length:var(--text-small)] text-destructive">{error}</span> : null}
          </label>
        );
      })}
    </div>
  );
}
