'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getBrowserClient } from '../../lib/api';
import { buildPayload, CONNECTION_FIELDS, CONNECTOR_KEYS } from '../../lib/connectionFields';
import { Dialog } from '../ui/Dialog';
import { TextField } from '../ui/TextField';

export function ConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [connectorKey, setConnectorKey] = useState('telegram');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => getBrowserClient().createConnection(connectorKey, name.trim(), buildPayload(connectorKey, values)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      setName('');
      setValues({});
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to create connection'),
  });

  const fields = CONNECTION_FIELDS[connectorKey] ?? [];

  const submit = () => {
    try {
      buildPayload(connectorKey, values); // local validation before the mutation fires
      setError(null);
      create.mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid payload');
    }
  };

  return (
    <Dialog
      title="New connection"
      open={open}
      onClose={onClose}
      actions={
        <>
          <button className="q-btn q-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="q-btn"
            disabled={!name.trim() || create.isPending}
            onClick={submit}
            data-testid="conn-submit"
          >
            Create
          </button>
        </>
      }
    >
      <label className="q-field">
        <span className="q-field__label">Connector *</span>
        <select
          className="q-select"
          value={connectorKey}
          onChange={(e) => {
            setConnectorKey(e.target.value);
            setValues({});
          }}
          data-testid="conn-connector-select"
        >
          {CONNECTOR_KEYS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Name" value={name} onChange={setName} required placeholder="Tim bot" testId="conn-name" />
      {fields.map((field) => (
        <TextField
          key={field.name}
          label={field.label}
          type={field.secret ? 'password' : 'text'}
          required={field.required}
          placeholder={field.placeholder}
          value={values[field.name] ?? ''}
          onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
          hint={field.secret ? 'Stored encrypted — never shown again after saving.' : undefined}
          testId={`conn-field-${field.name}`}
        />
      ))}
      {error ? <div className="q-banner">{error}</div> : null}
    </Dialog>
  );
}
