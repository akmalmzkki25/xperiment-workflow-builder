import { Alert, AlertDescription } from '@/components/ui/alert';

/** Shown in place of a list when the API refuses the read for lack of a permission. */
export function PermissionNotice({ detail }: { detail: string }) {
  return (
    <Alert data-testid="permission-notice">
      <AlertDescription>{detail}. Ask a workspace admin to change your role.</AlertDescription>
    </Alert>
  );
}
