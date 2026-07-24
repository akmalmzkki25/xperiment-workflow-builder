import { startStack } from './services';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  return async () => {
    await stack.stop();
  };
}
