'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getBrowserClient } from '../../lib/api';
import { buildPayload, deriveFields, type JsonSchemaLike } from '../../lib/connectionFields';
import { Dialog } from '../ui/Dialog';
import { TextField } from '../ui/TextField';

/** Set when rotating an existing connection rather than creating one. */
export interface RotateTarget {
  id: string;
  name: string;
  connectorKey: string;
}

export function ConnectionDialog({
  open,
  onClose,
  rotate,
}: {
  open: boolean;
  onClose: () => void;
  rotate?: RotateTarget | undefined;
}) {
  const queryClient = useQueryClient();
  const [connectorKey, setConnectorKey] = useState('telegram');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Rotation pins the connector: changing it would leave published nodes calling a
  // connector whose payload no longer matches, so the server refuses it too.
  useEffect(() => {
    if (!open) return;
    setValues({});
    setError(null);
    setConnectorKey(rotate?.connectorKey ?? 'telegram');
    setName(rotate?.name ?? '');
  }, [open, rotate?.id, rotate?.connectorKey, rotate?.name]);

  // The catalog is fixed for the server's lifetime, so it is fetched once and kept.
  // `enabled` on `open` keeps a closed dialog from costing a request on every page load.
  const catalog = useQuery({
    queryKey: ['connectors'],
    queryFn: () => getBrowserClient().listConnectors(),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });

  const schemas = catalog.data?.connections ?? [];
  const schema = schemas.find((s) => s.connectorKey === connectorKey)?.payloadJsonSchema as
    | JsonSchemaLike
    | undefined;
  const fields = schema ? deriveFields(connectorKey, schema) : [];

  const save = useMutation({
    mutationFn: () => {
      const payload = buildPayload(fields, values);
      const client = getBrowserClient();
      return rotate
        ? client.rotateConnection(rotate.id, payload, name.trim())
        : client.createConnection(connectorKey, name.trim(), payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      setName('');
      setValues({});
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to save connection'),
  });

  const submit = () => {
    try {
      buildPayload(fields, values); // local validation before the mutation fires
      setError(null);
      save.mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid payload');
    }
  };

  return (
    <Dialog
      title={rotate ? `Rotate credential — ${rotate.name}` : 'New connection'}
      open={open}
      onClose={onClose}
      actions={
        <>
          <button className="q-btn q-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="q-btn"
            disabled={!name.trim() || fields.length === 0 || save.isPending}
            onClick={submit}
            data-testid="conn-submit"
          >
            {rotate ? 'Rotate' : 'Create'}
          </button>
        </>
      }
    >
      {rotate ? (
        <div className="q-banner" data-testid="conn-rotate-notice">
          The connection keeps its id, so every published workflow that uses it keeps working. Enter every field
          again — the stored payload is write-only, so this form cannot show you what is there now.
        </div>
      ) : null}

      <label className="q-field">
        <span className="q-field__label">Connector *</span>
        <select
          className="q-select"
          value={connectorKey}
          disabled={rotate !== undefined}
          onChange={(e) => {
            setConnectorKey(e.target.value);
            setValues({});
          }}
          data-testid="conn-connector-select"
        >
          {schemas.map((s) => (
            <option key={s.connectorKey} value={s.connectorKey}>
              {s.connectorKey}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Name" value={name} onChange={setName} required placeholder="Tim bot" testId="conn-name" />

      {catalog.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading connector fields…</p> : null}
      {/* An older API that does not send connection schemas leaves the form with nothing
          to draw. Saying so beats a Create button that fails with a validation error. */}
      {!catalog.isLoading && schemas.length === 0 ? (
        <div className="q-banner">This API build does not publish connection field definitions.</div>
      ) : null}

      {fields.map((field) =>
        field.kind === 'checkbox' ? (
          <label className="q-field q-field--inline" key={field.name}>
            <input
              type="checkbox"
              checked={values[field.name] === 'true'}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: String(e.target.checked) }))}
              data-testid={`conn-field-${field.name}`}
            />
            <span className="q-field__label">{field.label}</span>
          </label>
        ) : (
          <TextField
            key={field.name}
            label={field.label}
            type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
            required={field.required}
            placeholder={field.placeholder}
            value={values[field.name] ?? ''}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
            hint={field.kind === 'password' ? 'Stored encrypted — never shown again after saving.' : undefined}
            testId={`conn-field-${field.name}`}
          />
        ),
      )}
      {error ? <div className="q-banner">{error}</div> : null}
    </Dialog>
  );
}
