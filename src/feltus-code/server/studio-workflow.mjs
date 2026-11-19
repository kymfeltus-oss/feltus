export const DEFAULT_REPAIR_LIMIT = 2;

function failedValidation(result) {
  return result && result.code !== 0;
}

export async function runStudioAgent({
  prompt,
  context,
  model,
  task,
  plan,
  architect,
  propose,
  validate,
  signal,
  repairLimit = DEFAULT_REPAIR_LIMIT
}) {
  if (typeof architect !== "function" || typeof propose !== "function" || typeof validate !== "function") {
    throw new TypeError("Studio agent requires architect, propose, and validate functions.");
  }
  if (!Number.isInteger(repairLimit) || repairLimit < 0 || repairLimit > 3) {
    throw Object.assign(new Error("Repair limit must be between zero and three."), { code: "INVALID_REPAIR_LIMIT" });
  }
  const implementationPlan = plan || await architect({ prompt, context, model, signal });
  let changeSet = await propose({ prompt, context, plan: implementationPlan, model, signal, mode: "build" });
  const attempts = [];

  for (let attempt = 0; attempt <= repairLimit; attempt += 1) {
    if (signal?.aborted) throw Object.assign(new Error("Studio agent was cancelled."), { code: "REQUEST_CANCELLED" });
    let validation;
    try {
      validation = await validate({ task, changeSet, signal });
    } catch (error) {
      if (error?.code === "TASK_UNAVAILABLE") {
        return {
          plan: implementationPlan,
          changeSet,
          validation: { task, skipped: true, reason: error.message },
          attempts,
          repair_limit: repairLimit,
          ready_for_review: true
        };
      }
      throw error;
    }
    attempts.push({
      attempt: attempt + 1,
      task,
      code: validation.code,
      stdout: validation.stdout,
      stderr: validation.stderr
    });
    if (!failedValidation(validation)) {
      return {
        plan: implementationPlan,
        changeSet,
        validation,
        attempts,
        repair_limit: repairLimit,
        ready_for_review: true
      };
    }
    if (attempt === repairLimit) {
      return {
        plan: implementationPlan,
        changeSet,
        validation,
        attempts,
        repair_limit: repairLimit,
        ready_for_review: true,
        blocker: "Validation still fails after the allowed repair attempts. Review the proposed changes and exact task output."
      };
    }
    changeSet = await propose({
      prompt:
        `${prompt}\n\nRepair the proposed change set for this validation failure. ` +
        `Do not broaden the requested feature.\nTask: ${task}\nExit: ${validation.code}\n` +
        `stdout:\n${String(validation.stdout || "").slice(-12000)}\n` +
        `stderr:\n${String(validation.stderr || "").slice(-12000)}`,
      context,
      plan: implementationPlan,
      previousChangeSet: changeSet,
      model,
      signal,
      mode: "fix"
    });
  }
  throw new Error("Studio agent ended unexpectedly.");
}
