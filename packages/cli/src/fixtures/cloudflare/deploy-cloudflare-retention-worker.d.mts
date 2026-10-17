// Types for the committed retention Worker golden, which `render/cloudflare.test.ts` imports.
declare const worker: {
  scheduled(this: void, controller: unknown, env: Record<string, string>): Promise<void>;
};
export default worker;
