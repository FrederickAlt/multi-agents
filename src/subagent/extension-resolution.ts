import {
	DefaultPackageManager,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ExtensionResolutionContext {
	cwd: string;
	agentDir: string;
	/** One-launch trust override, such as Pi's --approve/--no-approve flags. */
	projectTrustOverride?: boolean;
}

export interface TrustAwareSettings {
	settingsManager: SettingsManager;
	projectTrusted: boolean;
}

/**
 * Build Pi settings without implicitly trusting a project.
 *
 * Pi's SettingsManager defaults to `projectTrusted: true` for SDK callers. A
 * launcher or Task wrapper must make that decision explicitly or it can load
 * project-local packages before Pi's trust gate. Saved decisions and the
 * global `defaultProjectTrust: "always"` policy are honored. Like Pi's own
 * trust resolver, a directory with no trust-requiring project resources is
 * trusted automatically; an undecided project with gated resources fails
 * closed until Pi records a decision.
 */
export function createTrustAwareSettings(options: ExtensionResolutionContext): TrustAwareSettings {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	let projectTrusted: boolean;
	if (options.projectTrustOverride !== undefined) {
		projectTrusted = options.projectTrustOverride;
	} else if (!hasTrustRequiringProjectResources(options.cwd)) {
		projectTrusted = true;
	} else {
		const savedDecision = new ProjectTrustStore(options.agentDir).get(options.cwd);
		projectTrusted = savedDecision ?? settingsManager.getDefaultProjectTrust() === "always";
	}

	if (projectTrusted) settingsManager.setProjectTrusted(true);
	return { settingsManager, projectTrusted };
}

/** Resolve configured extension paths without importing or executing them. */
export async function resolveConfiguredExtensionCandidates(
	options: ExtensionResolutionContext & { settingsManager?: SettingsManager },
): Promise<ResolvedResource[]> {
	const settingsManager = options.settingsManager ?? createTrustAwareSettings(options).settingsManager;
	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
	const resolved = await packageManager.resolve(async () => "skip");
	return resolved.extensions.filter((resource) => resource.enabled !== false);
}
