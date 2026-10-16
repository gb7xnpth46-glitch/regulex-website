// Read-only navigation to information that is already public. No forms or uploads.
(() => {
  const context = document.modelContext || navigator.modelContext;
  if (!context || typeof context.registerTool !== "function") return;
  const pages = {
    subscription: { title: "Ongoing Legal Advisory", url: "https://regulex-legal.com/legal-services-subscription" },
    structuring: { title: "Structuring & Private Clients", url: "https://regulex-legal.com/structuring-private-clients" },
    corporate: { title: "Corporate Law & M&A", url: "https://regulex-legal.com/corporate" },
  };
  try {
    Promise.resolve(context.registerTool({
      name: "find_regulex_service_page",
      description: "Find a public REGULEX page about legal subscription, structuring or corporate services. Returns links only; does not give legal advice, contact the firm or submit personal information.",
      inputSchema: { type: "object", properties: { topic: { type: "string", enum: Object.keys(pages) } }, required: ["topic"], additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async input => {
        const key = input && typeof input === "object" ? input.topic : null;
        if (typeof key !== "string" || !Object.hasOwn(pages, key)) throw new Error("Choose subscription, structuring or corporate.");
        return JSON.stringify({ ...pages[key], nextStep: "Read the service page. Scope, availability and fees must be agreed with REGULEX before work starts." });
      },
    })).catch(() => {});
  } catch { /* Unsupported experimental API must not affect the site. */ }
})();
