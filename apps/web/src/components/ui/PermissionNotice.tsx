/** Shown in place of a list when the API refuses the read for lack of a permission. */
export function PermissionNotice({ detail }: { detail: string }) {
  return (
    <p style={{ color: 'var(--text-muted)' }} data-testid="permission-notice">
      {detail}. Ask a workspace admin to change your role.
    </p>
  );
}
