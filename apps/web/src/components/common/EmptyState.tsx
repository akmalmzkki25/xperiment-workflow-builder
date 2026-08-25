import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <Card className="border-dashed bg-secondary/40 shadow-none">
      <CardContent className="flex flex-col items-start gap-2 py-10">
        <p className="text-[length:var(--text-h2)] font-semibold">{title}</p>
        <p className="max-w-prose text-muted-foreground">{hint}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}
