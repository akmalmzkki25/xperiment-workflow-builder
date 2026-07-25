'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '../../../lib/api';
import type { TemplateSummary } from '../../../lib/api';

const CATEGORY_LABEL: Record<string, string> = { sales: 'Sales', cs: 'Customer service', ops: 'Operations' };

function TemplateCard({ template }: { template: TemplateSummary }) {
  const router = useRouter();
  const clone = useMutation({
    mutationFn: () => getBrowserClient().cloneTemplate(template.id),
    onSuccess: ({ id }) => router.push(`/workflows/${id}`),
  });
  return (
    <div
      data-testid={`template-${template.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        padding: 'var(--space-4)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-node)',
      }}
    >
      <div style={{ fontSize: 'var(--text-body)', fontWeight: 600 }}>{template.name}</div>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{template.description}</p>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-small)', margin: 0 }}>{template.useCase}</p>
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-small)' }}>Needs:</span>
        {template.requiredConnectors.map((c) => (
          <span key={c} className="q-chip">{c}</span>
        ))}
      </div>
      <button
        className="q-btn q-btn--primary q-btn--sm"
        style={{ alignSelf: 'flex-start', marginTop: 'var(--space-1)' }}
        disabled={clone.isPending}
        onClick={() => clone.mutate()}
        data-testid={`use-${template.id}`}
      >
        Use this template
      </button>
    </div>
  );
}

export default function TemplatesPage() {
  const q = useQuery({ queryKey: ['templates'], queryFn: () => getBrowserClient().listTemplates() });

  if (q.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading templates…</p>;
  if (q.isError || !q.data) return <div className="q-banner">Could not load templates.</div>;

  const items = q.data.items;
  const categories = [...new Set(items.map((t) => t.category))];

  return (
    <div data-testid="templates-page">
      <div className="q-page-head">
        <h1>Templates</h1>
      </div>
      {items.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No templates available.</p>
      ) : (
        categories.map((cat) => (
          <section key={cat} style={{ marginBottom: 'var(--space-6)' }}>
            <h2 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-3)' }}>{CATEGORY_LABEL[cat] ?? cat}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--space-3)' }}>
              {items.filter((t) => t.category === cat).map((t) => (
                <TemplateCard key={t.id} template={t} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
