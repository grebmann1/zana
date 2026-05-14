import * as fs from "fs";
import * as path from "path";

export function jsonSchema(schema) {
  return {
    id: "json-schema",
    name: "JSON Schema Validation",
    validate(output) {
      let parsed;
      const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : output.trim();

      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          pass: false,
          feedback: `Output is not valid JSON. Parse error: ${err.message}. Please output valid JSON only, without markdown fencing.`,
        };
      }

      if (schema && typeof schema.validate === "function") {
        const result = schema.validate(parsed);
        if (!result.success) {
          return {
            pass: false,
            feedback: `JSON parsed but failed schema validation:\n${JSON.stringify(result.errors, null, 2)}\n\nPlease fix the output to match the required schema.`,
          };
        }
      }

      return { pass: true, parsedOutput: parsed };
    },
  };
}

export function jsonParse() {
  return {
    id: "json-parse",
    name: "Valid JSON",
    validate(output) {
      const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : output.trim();
      try {
        const parsed = JSON.parse(raw);
        return { pass: true, parsedOutput: parsed };
      } catch (err) {
        return {
          pass: false,
          feedback: `Output is not valid JSON: ${err.message}. Return only valid JSON.`,
        };
      }
    },
  };
}

const SECRET_PATTERNS = [
  /(?:^|[^a-zA-Z0-9])(sk-[a-zA-Z0-9]{20,})/,
  /(?:^|[^a-zA-Z0-9])(ghp_[a-zA-Z0-9]{36,})/,
  /(?:^|[^a-zA-Z0-9])(gho_[a-zA-Z0-9]{36,})/,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  /(?:^|[^a-zA-Z0-9])(AKIA[0-9A-Z]{16})/,
  /(?:^|[^a-zA-Z0-9])(xox[bpras]-[a-zA-Z0-9-]+)/,
];

export function noSecrets() {
  return {
    id: "no-secrets",
    name: "No Secrets/Keys",
    validate(output) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(output)) {
          return {
            pass: false,
            feedback: "Output appears to contain secrets or API keys. Remove all credentials from your response.",
          };
        }
      }
      return { pass: true };
    },
  };
}

export function maxLength(chars) {
  return {
    id: "max-length",
    name: `Max Length (${chars})`,
    validate(output) {
      if (output.length <= chars) return { pass: true };
      return {
        pass: false,
        feedback: `Output is ${output.length} characters but maximum allowed is ${chars}. Please shorten your response.`,
      };
    },
  };
}

export function fileExists(filePath) {
  return {
    id: "file-exists",
    name: `File Exists: ${filePath}`,
    validate(_output, ctx) {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.cwd || process.cwd(), filePath);
      if (fs.existsSync(resolved)) return { pass: true };
      return {
        pass: false,
        feedback: `Expected file was not created: ${filePath}. Please ensure you create this file.`,
      };
    },
  };
}

export function containsPattern(regex, description) {
  const pattern = typeof regex === "string" ? new RegExp(regex) : regex;
  return {
    id: "contains-pattern",
    name: description || `Matches: ${pattern.source}`,
    validate(output) {
      if (pattern.test(output)) return { pass: true };
      return {
        pass: false,
        feedback: `Output does not match required pattern: ${description || pattern.source}`,
      };
    },
  };
}

export function custom(id, name, validateFn) {
  return { id, name, validate: validateFn };
}

// Default export for CJS interop (test does `(await import("...")).default`).
export default {
  jsonSchema,
  jsonParse,
  noSecrets,
  maxLength,
  fileExists,
  containsPattern,
  custom,
};

