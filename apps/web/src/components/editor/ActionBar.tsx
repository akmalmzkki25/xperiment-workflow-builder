'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getBrowserClient, type Finding, type TriggerView, type WorkflowDetail } from '../../lib/api';
import { useEditorStore } from '../../stores/editorStore';
import { LiveChip, StatusChip } from '../ui/StatusChip';
import { FindingsPanel } from './FindingsPanel';
import { TriggerPanel } from './TriggerPanel';

interface ActionBarProps {
  workflow: WorkflowDetail;
  revision: number | null;
  setRevision: (revision: number) => void;
  buildDefinition: () => Record<string, unknown>;
  onDefinitionSaved: (definition: unknown) => void;
  findings: Finding[];
  setFindings: (findings: Finding[]) => void;
  nodeCount: number;
  /** Increments when Ctrl+S is pressed; the value itself carries no meaning. */
  saveSignal: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onToggleLibrary: () => void;
  onToggleAi: () => void;
  onRunStarted: (executionId: string) => void;
}

type Notice = { kind: 'ok' | 'err'; text: string } | null;

export function ActionBar({
  workflow,
  revision,
  setRevision,
  buildDefinition,
  onDefinitionSaved,
  findings,
  setFindings,
  nodeCount,
  saveSignal,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onToggleLibrary,
  onToggleAi,
  onRunStarted,
}: ActionBarProps) {
  const queryClient = useQueryClient();
  const { dirty, clearDirtyUpTo } = useEditorStore();
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState(false);
  const [triggers, setTriggers] = useState<TriggerView[] | null>(null);
  const [secretsVisible, setSecretsVisible] = useState(false);
  const saveInFlight = useRef(false);

  const refreshWorkflow = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workflow', workflow.id] }),
      queryClient.invalidateQueries({ queryKey: ['workflows'] }),
    ]);

  const save = useMutation({
    mutationFn: async () => {
      const seqAtSave = useEditorStore.getState().editSeq;
      const definition = buildDefinition();
      const result = await getBrowserClient().putDraft(workflow.id, definition, revision ?? 1);
      return { definition, revision: result.revision, seqAtSave };
    },
    onSuccess: ({ definition, revision: nextRevision, seqAtSave }) => {
      setRevision(nextRevision);
      onDefinitionSaved(definition);
      // Keep the workflow cache truthful so a remount doesn't revert the canvas
      // to the pre-save draft and produce a spurious 412.
      queryClient.setQueryData<WorkflowDetail>(['workflow', workflow.id], (old) =>
        old ? { ...old, draftRevision: nextRevision, draft: { definition, revision: nextRevision } } : old,
      );
      // Edits made while the PUT was in flight must keep the draft dirty.
      clearDirtyUpTo(seqAtSave);
      setNotice({ kind: 'ok', text: `Draft saved (rev ${nextRevision})` });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 412) setConflict(true);
      else setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Save failed' });
    },
    onSettled: () => {
      saveInFlight.current = false;
    },
  });

  const validate = useMutation({
    mutationFn: () => getBrowserClient().validate(workflow.id),
    onSuccess: (r) => {
      setFindings(r.findings);
      setNotice(
        r.valid
          ? { kind: 'ok', text: 'Draft is valid' }
          : { kind: 'err', text: `Validation found ${r.findings.length} issue(s)` },
      );
    },
    onError: (e) => setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Validation failed' }),
  });

  const publish = useMutation({
    mutationFn: () => getBrowserClient().publish(workflow.id),
    onSuccess: async (r) => {
      setFindings([]);
      setNotice({ kind: 'ok', text: `Published v${r.versionNumber}` });
      await refreshWorkflow();
    },
    onError: async (e) => {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Publish failed' });
      // Refresh findings so the failure is actionable on the canvas.
      const r = await getBrowserClient()
        .validate(workflow.id)
        .catch(() => null);
      if (r) setFindings(r.findings);
    },
  });

  const run = useMutation({
    mutationFn: () => getBrowserClient().execute(workflow.id),
    onSuccess: (r) => {
      setNotice(null);
      onRunStarted(r.executionId);
    },
    onError: (e) => {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Could not start the run' });
    },
  });

  const activate = useMutation({
    mutationFn: () => getBrowserClient().activate(workflow.id),
    onSuccess: async (r) => {
      setTriggers(r.triggers);
      setSecretsVisible(true);
      setNotice({ kind: 'ok', text: 'Workflow activated' });
      await refreshWorkflow();
    },
    onError: (e) => setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Activation failed' }),
  });

  const deactivate = useMutation({
    mutationFn: () => getBrowserClient().deactivate(workflow.id),
    onSuccess: async () => {
      setTriggers(null);
      setSecretsVisible(false);
      setNotice({ kind: 'ok', text: 'Workflow deactivated' });
      await refreshWorkflow();
    },
    onError: (e) => setNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Deactivation failed' }),
  });

  const busy =
    save.isPending ||
    validate.isPending ||
    publish.isPending ||
    activate.isPending ||
    deactivate.isPending ||
    run.isPending;

  const triggerSave = useCallback(() => {
    if (busy || !dirty || saveInFlight.current) return;
    saveInFlight.current = true;
    save.mutate();
  }, [busy, dirty, save]);

  // The keystroke has to go through the same guards as the button, so it reads the
  // latest closure through a ref rather than sitting in the effect's dependencies —
  // listing triggerSave there would re-fire the save every time `busy` flipped.
  const triggerSaveRef = useRef(triggerSave);
  useEffect(() => {
    triggerSaveRef.current = triggerSave;
  });
  useEffect(() => {
    if (saveSignal > 0) triggerSaveRef.current();
  }, [saveSignal]);

  return (
    <>
      <div className="q-editor-head">
        <span className="q-editor-head__name">{workflow.name}</span>
        <StatusChip status={workflow.status} />
        {workflow.active ? <LiveChip label="Active" testId="wf-active-chip" /> : null}
        {revision !== null ? (
          <span className="q-field__hint mono">
            rev {revision}
            {dirty ? ' · unsaved changes' : ''}
          </span>
        ) : null}
        <span className="q-editor-head__spacer" />
        <button
          className="q-btn q-btn--ghost q-btn--sm"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          data-testid="action-undo"
        >
          ↶
        </button>
        <button
          className="q-btn q-btn--ghost q-btn--sm"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          data-testid="action-redo"
        >
          ↷
        </button>
        <button className="q-btn q-btn--live q-btn--sm" onClick={onToggleAi} data-testid="ai-open">
          ✦ AI
        </button>
        <button className="q-btn q-btn--ghost q-btn--sm" onClick={onToggleLibrary} data-testid="lib-open">
          Add node
        </button>
        <button
          className="q-btn q-btn--sm"
          disabled={busy || !dirty}
          onClick={triggerSave}
          title="Save draft (Ctrl+S)"
          data-testid="action-save"
        >
          Save draft
        </button>
        <button
          className="q-btn q-btn--ghost q-btn--sm"
          disabled={busy}
          onClick={() => validate.mutate()}
          data-testid="action-validate"
        >
          Validate
        </button>
        <button
          className="q-btn q-btn--ghost q-btn--sm"
          // Enabled while dirty on purpose: POST /execute reads activeVersionId, never
          // the draft, so refusing here would imply the two are related when they are not.
          disabled={busy || !workflow.activeVersionId}
          title={
            workflow.activeVersionId
              ? 'Runs the published version — unsaved changes are not included'
              : 'Publish a version first'
          }
          onClick={() => run.mutate()}
          data-testid="action-run"
        >
          Run
        </button>
        <button
          className="q-btn q-btn--sm"
          disabled={busy || dirty || nodeCount === 0}
          title={dirty ? 'Save the draft first' : undefined}
          onClick={() => publish.mutate()}
          data-testid="action-publish"
        >
          Publish
        </button>
        {workflow.active ? (
          <button
            className="q-btn q-btn--ghost q-btn--sm"
            disabled={busy}
            onClick={() => deactivate.mutate()}
            data-testid="action-deactivate"
          >
            Deactivate
          </button>
        ) : (
          <button
            className="q-btn q-btn--live q-btn--sm"
            disabled={busy || !workflow.activeVersionId}
            title={!workflow.activeVersionId ? 'Publish a version first' : undefined}
            onClick={() => activate.mutate()}
            data-testid="action-activate"
          >
            Activate
          </button>
        )}
      </div>

      {conflict ? (
        <div className="q-banner" data-testid="draft-conflict">
          <span>This draft changed in another session. Reload to pick up the latest revision.</span>
          <button className="q-btn q-btn--sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className={notice.kind === 'ok' ? 'q-banner q-banner--ok' : 'q-banner'} data-testid="editor-banner">
          <span>{notice.text}</span>
          <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <FindingsPanel findings={findings} />
      {triggers ? <TriggerPanel triggers={triggers} showSecrets={secretsVisible} /> : null}
    </>
  );
}
