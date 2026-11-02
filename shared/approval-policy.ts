import { z } from "zod";
import type { Project } from "./project.ts";

export const approvalPolicyRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		requireApproval: z.boolean(),
	})
	.strict();

/** Apply authoritative policy metadata without replacing an editorial draft. */
export function mergeApprovalPolicy(
	current: Project,
	policy: Pick<Project, "id" | "revision" | "updatedAt" | "requireApproval">
): Project {
	return current.id === policy.id && current.revision <= policy.revision
		? {
				...current,
				requireApproval: policy.requireApproval,
				revision: policy.revision,
				updatedAt: policy.updatedAt,
			}
		: current;
}
