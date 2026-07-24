import { expect, test, type Page } from '@playwright/test';
import { AI_FAIL_MARKER, TELEGRAM_STUB_PORT } from './services';

const runId = Date.now();
const EMAIL = `web-${runId}@xperiment.test`;
const SECOND_EMAIL = `web2-${runId}@xperiment.test`;
const PASSWORD = 'password-web-123';
const ARTIFACTS = 'e2e/artifacts';
const BOT_TOKEN = 'stub-secret-token-123';

test.describe.configure({ mode: 'serial' });

let token = '';
let webhookUrl = '';

async function loginWithToken(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate((t) => localStorage.setItem('xperiment.token', t), token);
  await page.goto('/workflows');
  await expect(page.getByTestId('nav-workflows')).toBeVisible();
}

test('registers and lands on an empty workflows list', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('auth-email').fill(EMAIL);
  await page.getByTestId('auth-password').fill(PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expect(page).toHaveURL(/\/workflows/);
  await expect(page.getByText('No workflows yet')).toBeVisible();
  token = await page.evaluate(() => localStorage.getItem('xperiment.token') ?? '');
  expect(token).not.toBe('');
  await page.screenshot({ path: `${ARTIFACTS}/01-workflows-empty.png` });
});

test('builds, publishes and activates a webhook workflow on the canvas', async ({ page }) => {
  await loginWithToken(page);
  await page.getByTestId('wf-create').click();
  await page.getByTestId('wf-name-input').fill('Lead intake');
  await page.getByTestId('wf-create-submit').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);

  await page.getByTestId('lib-item-webhook.trigger').click();
  await page.getByTestId('lib-item-core.transform').click();
  await expect(page.getByTestId('node-webhook_trigger')).toBeVisible();
  await expect(page.getByTestId('node-core_transform')).toBeVisible();

  // Draw the edge: drag from the trigger's source handle to the transform's target handle.
  const source = page.locator('[data-testid="node-webhook_trigger"] .react-flow__handle-right');
  const target = page.locator('[data-testid="node-core_transform"] .react-flow__handle-left');
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('connection handles not visible');
  const sx = sourceBox.x + sourceBox.width / 2;
  const sy = sourceBox.y + sourceBox.height / 2;
  const tx = targetBox.x + targetBox.width / 2;
  const ty = targetBox.y + targetBox.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 24, sy + 8, { steps: 4 }); // leave the handle so the connection line starts
  await page.mouse.move(tx, ty, { steps: 20 });
  await page.mouse.move(tx, ty);
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // Rename the transform via the inspector; the edge must survive the rename.
  await page.getByTestId('node-core_transform').click();
  await page.getByTestId('node-id-input').fill('shape_lead');
  await page.getByTestId('node-rename').click();
  await expect(page.getByTestId('node-shape_lead')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await page.getByTestId('action-save').click();
  await expect(page.getByTestId('editor-banner')).toContainText('Draft saved');
  await page.getByTestId('action-validate').click();
  await expect(page.getByTestId('editor-banner')).toContainText('Draft is valid');
  await page.getByTestId('action-publish').click();
  await expect(page.getByTestId('editor-banner')).toContainText('Published v1');
  await page.getByTestId('action-activate').click();
  await expect(page.getByTestId('trigger-panel')).toBeVisible();
  const url = await page.getByTestId('trigger-url').textContent();
  expect(url).toContain('/t/');
  webhookUrl = url ?? '';

  await page.screenshot({ path: `${ARTIFACTS}/02-editor-1440.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${ARTIFACTS}/02-editor-1280.png` });
});

test('a webhook fire appears in executions with a green timeline', async ({ page, request }) => {
  expect(webhookUrl).not.toBe('');
  const fired = await request.post(webhookUrl, { data: { name: 'Budi', total: 150 } });
  expect(fired.status()).toBeLessThan(300);

  await loginWithToken(page);
  await page.getByTestId('nav-executions').click();
  await expect(page).toHaveURL(/\/executions$/);
  await expect(page.locator('.q-table tbody tr')).toHaveCount(1, { timeout: 30_000 });
  await page.locator('.q-table tbody tr td a').first().click();
  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('exec-status')).toContainText('Succeeded', { timeout: 45_000 });
  await expect(page.getByTestId('timeline-node-webhook_trigger')).toContainText('Succeeded');
  await expect(page.getByTestId('timeline-node-shape_lead')).toContainText('Succeeded');
  await page.screenshot({ path: `${ARTIFACTS}/03-execution-detail.png` });
});

test('creates and tests a telegram connection without leaking the secret', async ({ page }) => {
  await loginWithToken(page);
  await page.getByTestId('nav-connections').click();
  await page.getByTestId('conn-create').click();
  await page.getByTestId('conn-connector-select').selectOption('telegram');
  await page.getByTestId('conn-name').fill('Stub bot');
  await page.getByTestId('conn-field-botToken').fill(BOT_TOKEN);
  await page.getByTestId('conn-field-baseUrl').fill(`http://127.0.0.1:${TELEGRAM_STUB_PORT}`);
  await page.getByTestId('conn-submit').click();
  await expect(page.getByTestId('conn-row-Stub bot')).toBeVisible();

  await page.getByTestId('conn-test-Stub bot').click();
  await expect(page.getByTestId('conn-status-Stub bot')).toContainText('ok', { timeout: 20_000 });

  await page.reload();
  await expect(page.getByTestId('conn-row-Stub bot')).toBeVisible();
  expect(await page.content()).not.toContain(BOT_TOKEN);
  await page.screenshot({ path: `${ARTIFACTS}/04-connections.png` });
});

test('a second user sees an empty workspace', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('auth-email').fill(SECOND_EMAIL);
  await page.getByTestId('auth-password').fill(PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expect(page).toHaveURL(/\/workflows/);
  await expect(page.getByText('No workflows yet')).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/05-isolation.png` });
});

test('the AI dock generates a workflow onto the canvas', async ({ page }) => {
  await loginWithToken(page);
  await page.getByTestId('wf-create').click();
  await page.getByTestId('wf-name-input').fill('AI intake');
  await page.getByTestId('wf-create-submit').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);

  await page.getByTestId('ai-open').click();
  await expect(page.getByTestId('ai-dock')).toBeVisible();
  await page.getByTestId('ai-prompt').fill('When a webhook arrives, transform the payload.');
  await page.getByTestId('ai-generate').click();

  // The stub returns a webhook trigger + transform; both should land on the canvas.
  await expect(page.getByTestId('node-ai_hook')).toBeVisible();
  await expect(page.getByTestId('node-ai_shape')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // The AI applies a draft the user reviews; save it, then it validates clean.
  await page.getByTestId('action-save').click();
  await expect(page.getByTestId('editor-banner')).toContainText('Draft saved');
  await page.getByTestId('action-validate').click();
  await expect(page.getByTestId('editor-banner')).toContainText('Draft is valid');
  await page.screenshot({ path: `${ARTIFACTS}/06-ai-generated.png` });

  // When the model can't produce a valid workflow, the dock surfaces the error.
  await page.getByTestId('ai-open').click();
  await page.getByTestId('ai-prompt').fill(`please ${AI_FAIL_MARKER}`);
  await page.getByTestId('ai-generate').click();
  await expect(page.getByTestId('ai-error')).toBeVisible();
});
