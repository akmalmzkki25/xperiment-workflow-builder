'use client';

import dynamic from 'next/dynamic';

const Editor = dynamic(() => import('../../../../components/editor/Editor').then((m) => m.Editor), {
  ssr: false,
  loading: () => <p style={{ color: 'var(--text-muted)' }}>Loading editor…</p>,
});

export default function WorkflowEditorPage({ params }: { params: { id: string } }) {
  return <Editor key={params.id} workflowId={params.id} />;
}
