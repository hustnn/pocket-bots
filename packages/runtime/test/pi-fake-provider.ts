// Test-only Pi extension: a "fake" provider pointing at the scripted OpenAI server in BOTS_FAKE_URL.
// Loaded by Pi itself; typed loosely so this repo needn't depend on Pi.
export default function (pi: { registerProvider(name: string, config: unknown): void }) {
  pi.registerProvider("fake", {
    baseUrl: process.env.BOTS_FAKE_URL!,
    apiKey: "fake",
    api: "openai-completions",
    models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
}
