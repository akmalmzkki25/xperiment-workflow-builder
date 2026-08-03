'use client';

import { useEffect, useState } from 'react';

/**
 * Renders the enrolment URI as a QR the user scans. The library is imported dynamically so
 * it never reaches the initial bundle, and the encoding happens in the browser — the secret
 * is not handed to any third-party service to draw.
 */
export function QrCode({ value, size = 192 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void import('qrcode')
      .then((m) => m.toDataURL(value, { width: size, margin: 1 }))
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (failed) return <p data-testid="qr-failed">Could not draw the code — use the key below instead.</p>;
  if (!dataUrl) return <div style={{ width: size, height: size }} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a data: URI, nothing to optimise
    <img src={dataUrl} width={size} height={size} alt="Scan this with your authenticator app" data-testid="mfa-qr" />
  );
}
