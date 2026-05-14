import * as builtins from "./builtins.js";

const DEFAULT_MAX_RETRIES = 2;

export function waitForAgent(agentManager, agentId) {
  return new Promise((resolve) => {
    const check = () => {
      const agent = agentManager.getAgent(agentId);
      if (!agent) {
        resolve({ success: false, output: null, exitCode: -1 });
        return;
      }
      if (agent.state === "terminated" || agent.state === "errored") {
        resolve({
          success: agent.state === "terminated",
          output: agent.result || "",
          exitCode: agent.state === "terminated" ? 0 : 1,
        });
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function buildRetryPrompt(originalPrompt, feedback, attempt) {
  return [
    originalPrompt,
    "",
    `--- VALIDATION FAILED (attempt ${attempt}) ---`,
    feedback,
    "---",
    "Please fix your output to satisfy the above validation requirement and try again.",
  ].join("\n");
}

export function resolveGuardrails(guardrailConfigs) {
  if (!guardrailConfigs || guardrailConfigs.length === 0) return [];

  return guardrailConfigs.map((config) => {
    if (typeof config === "object" && typeof config.validate === "function") {
      return config;
    }

    if (typeof config === "object" && config.type) {
      switch (config.type) {
        case "json-schema":
          return builtins.jsonSchema(config.schema || null);
        case "json-parse":
          return builtins.jsonParse();
        case "no-secrets":
          return builtins.noSecrets();
        case "max-length":
          return builtins.maxLength(config.maxChars || 10000);
        case "file-exists":
          return builtins.fileExists(config.path);
        case "contains-pattern":
          return builtins.containsPattern(config.pattern, config.description);
        default:
          console.warn(`[guardrails] unknown guardrail type: ${config.type}`);
          return null;
      }
    }

    return null;
  }).filter(Boolean);
}

export async function spawnValidatedAgent(agentManager, profile, options, guardrailConfigs) {
  const guardrails = resolveGuardrails(guardrailConfigs);

  if (guardrails.length === 0) {
    const { agentId } = agentManager.spawnHeadlessAgent(profile, options);
    const result = await waitForAgent(agentManager, agentId);
    return { ...result, agentId, attempts: 1, guardrailsPassed: true };
  }

  const maxRetries = Math.max(
    ...guardrails.map((g) => g.maxRetries ?? DEFAULT_MAX_RETRIES),
    DEFAULT_MAX_RETRIES
  );
  const originalPrompt = options.prompt;
  const ctx = {
    profileId: profile.id,
    cwd: options.cwd || process.env.HOME,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentPrompt = attempt === 0
      ? originalPrompt
      : options.prompt;

    const spawnOpts = { ...options, prompt: currentPrompt };
    const { agentId } = agentManager.spawnHeadlessAgent(profile, spawnOpts);
    const result = await waitForAgent(agentManager, agentId);

    if (!result.success) {
      return {
        ...result,
        agentId,
        attempts: attempt + 1,
        guardrailsPassed: false,
        failedGuardrail: null,
        error: "Agent errored before guardrail check",
      };
    }

    let allPassed = true;
    let failedGuard = null;
    let feedback = null;
    let parsedOutput = undefined;

    for (const guard of guardrails) {
      const check = guard.validate(result.output, { ...ctx, attempt });
      if (!check.pass) {
        allPassed = false;
        failedGuard = guard;
        feedback = check.feedback || check.error || "Validation failed";
        break;
      }
      if (check.parsedOutput !== undefined) {
        parsedOutput = check.parsedOutput;
      }
    }

    if (allPassed) {
      return {
        ...result,
        agentId,
        attempts: attempt + 1,
        guardrailsPassed: true,
        parsedOutput,
      };
    }

    if (attempt < maxRetries) {
      options.prompt = buildRetryPrompt(originalPrompt, feedback, attempt + 1);
    } else {
      return {
        ...result,
        agentId,
        attempts: attempt + 1,
        guardrailsPassed: false,
        failedGuardrail: failedGuard?.id || "unknown",
        error: feedback,
      };
    }
  }
}

