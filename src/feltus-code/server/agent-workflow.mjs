export async function runValidatedAgent({ handlers, prompt, paths, model, task, allowApply, signal }) {
  const plan = await handlers.aiPlan({ prompt, paths, model }, { signal });
  const proposal = await handlers.aiEdit({ prompt, paths, model }, { signal });
  const value = {
    task,
    plan: plan.result,
    proposal: proposal.result,
    applied: [],
    taskRuns: [],
    validationPassed: null,
    appliedByAgent: false
  };

  if (allowApply !== true) return { ok: true, result: value };

  let validation;
  try {
    const validationResult = await handlers.validateTask({ task, files: proposal.result.files }, { signal });
    validation = validationResult.result;
  } catch (error) {
    if (error?.code !== "TASK_UNAVAILABLE") throw error;
    validation = { task, code: null, skipped: true, reason: error.message };
  }
  value.taskRuns.push(validation);
  value.validationPassed = validation?.skipped !== true && validation?.code === 0;
  if (!value.validationPassed) return { ok: true, result: value };

  const applied = await handlers.applyEdit({
    files: proposal.result.files,
    allowedPaths: proposal.result.allowedPaths
  }, { signal });
  value.applied = applied.files || [];
  value.appliedByAgent = value.applied.length > 0;
  return { ok: true, result: value };
}
