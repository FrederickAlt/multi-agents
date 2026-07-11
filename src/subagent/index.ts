/**
 * Persistent Task subagents for Pi.
 *
 * This extension intentionally exposes one model-facing tool, Task. Each Task
 * creates or resumes a real Pi AgentSession stored in normal session storage.
 */

import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	loadProjectContextFiles,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, AgentRegistry, discoverAgents, formatAgentList } from "./agents.js";
import { AsyncAgentNotifier } from "./async-agent-notifier.js";
import type { DebugLogger } from "./debug-logger.js";
import { makeNoopDebugLogger, makeSessionDebugLogger } from "./debug-logger.js";
import { defaultRootPolicy, selectedRootPolicy } from "./depth-policy.js";
import { resolveExtensionsForAgent } from "./extension-filter.js";
import { createTrustAwareSettings, resolveConfiguredExtensionCandidates } from "./extension-resolution.js";
import {
	ensureMultiAgentsLauncherContext,
	MULTI_AGENTS_BOOTSTRAP_RESUME_ENV,
	MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV,
	MULTI_AGENTS_PROJECT_TRUST_CWD_ENV,
	MULTI_AGENTS_PROJECT_TRUST_ENV,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "./launcher-contract.js";
import { MetadataStore } from "./metadata.js";
import {
	FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS,
	FINAL_RESPONSE_REQUIRED_MESSAGE,
	needsFinalResponsePrompt,
} from "./output-extraction.js";
import {
	buildPromptPartsFromOptions,
	type PromptParts,
	type RenderContext,
	renderComposedAgentSystemPrompt,
} from "./prompt-composition.js";
import { discoverPromptParts } from "./prompt-parts.js";
import {
	DEFAULT_ROOT_AGENT_NAME,
	getSelectedRootAgentFromSessionEntries,
	resolveRootAgent,
	SELECTED_ROOT_AGENT_ENTRY_KEY,
	SELECTED_ROOT_AGENT_ENTRY_TYPE,
} from "./root-agent.js";
import { seedAgentConfig } from "./seeding.js";
import {
	PiAgentSessionFactory,
	PiModelResolver,
	PiSessionManagerProvider,
	SubagentSessionManager,
} from "./session-manager.js";
import {
	type AgentDiscoveryAdapter,
	type RuntimeContext,
	TaskController,
	type TaskExecuteContext,
	type TaskResult,
} from "./task-controller.js";
import { configureTaskToolForRuntime, deactivateTaskTool } from "./task-tool-registration.js";

export type { PromptParts, RenderContext, SystemPromptCompositionOptions } from "./prompt-composition.js";
export {
	buildTemplateValues,
	renderComposedAgentSystemPrompt,
	renderPromptTemplate,
	renderSubagentSystemPrompt,
	renderTemplateString,
} from "./prompt-composition.js";

function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

interface RestartRequestPayload {
	version: 1;
	requestedRootAgent: string;
	type?: "agent";
}
interface ResumeRestartRequestPayload {
	version: 1;
	type: "resume-session";
	sessionPath: string;
}
interface TrustRestartRequestPayload {
	version: 1;
	type: "trust";
	sessionPath?: string;
	sessionId: string;
	projectTrusted: boolean;
}

function writeRestartRequest(path: string, requestedRootAgent: string): void {
	const payload: RestartRequestPayload = {
		version: 1,
		requestedRootAgent,
	};
	writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
}

function writeResumeSessionRestartRequest(path: string, sessionPath: string): void {
	const payload: ResumeRestartRequestPayload = {
		version: 1,
		type: "resume-session",
		sessionPath,
	};
	writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
}

function writeTrustRestartRequest(
	path: string,
	sessionPath: string | undefined,
	sessionId: string,
	projectTrusted: boolean,
): void {
	const payload: TrustRestartRequestPayload = {
		version: 1,
		type: "trust",
		...(sessionPath ? { sessionPath } : {}),
		sessionId,
		projectTrusted,
	};
	writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
}

function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function isSameOrDescendantCwd(rootCwd: string, candidateCwd: string): boolean {
	const relative = path.relative(canonicalCwd(rootCwd), canonicalCwd(candidateCwd));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasCloserSavedTrustDecision(rootCwd: string, candidateCwd: string, agentDir: string): boolean {
	if (canonicalCwd(rootCwd) === canonicalCwd(candidateCwd)) return false;
	const entry = new ProjectTrustStore(agentDir).getEntry(candidateCwd);
	return (
		entry !== null && canonicalCwd(entry.path) !== canonicalCwd(rootCwd) && isSameOrDescendantCwd(rootCwd, entry.path)
	);
}

function readLauncherProjectTrust(): { cwd: string; projectTrusted: boolean } | undefined {
	const rawTrust = process.env[MULTI_AGENTS_PROJECT_TRUST_ENV];
	const rawCwd = process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
	if ((rawTrust !== "1" && rawTrust !== "0") || !rawCwd?.trim()) return undefined;
	return { cwd: canonicalCwd(rawCwd), projectTrusted: rawTrust === "1" };
}

function clearRestartRequest(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Ignored: best effort cleanup for cancel/failure paths.
	}
}

function requestPiShutdown(
	ctx: { shutdown?: () => void },
	restartRequestFile?: string,
	options: { onFailure?: () => void } = {},
): boolean {
	try {
		if (typeof ctx.shutdown === "function") {
			ctx.shutdown();
			return true;
		}
		process.exit(0);
		return true;
	} catch {
		if (restartRequestFile) {
			clearRestartRequest(restartRequestFile);
		}
		options.onFailure?.();
		return false;
	}
}

// Module-level session manager singleton so both Task and wait_for_agent
// share the same tracked sessions.
let _sessionManager: SubagentSessionManager | undefined;

// Module-level notifier singleton — injected at safe run boundaries or batched into user input.
const _asyncAgentNotifier = new AsyncAgentNotifier();

function getOrCreateSessionManager(logger?: DebugLogger): SubagentSessionManager {
	if (!_sessionManager) {
		_sessionManager = new SubagentSessionManager(new PiSessionManagerProvider(), new PiAgentSessionFactory(), logger);
		_sessionManager.setOnAsyncResultReady((id) => {
			_asyncAgentNotifier.markCompleted(id);
		});
	}
	return _sessionManager;
}

let seeded = false;
export default function (pi: ExtensionAPI) {
	ensureMultiAgentsLauncherContext();
	if (!seeded) {
		seedAgentConfig();
		seeded = true;
	}

	let store: MetadataStore | undefined;
	let dumpNextProviderRequest = false;
	let lastProviderSystemPrompt: string | undefined;
	let lastRootPromptParts: PromptParts | undefined;
	let rootFinalResponseGuardActive = false;
	let rootFinalResponseGuardAttempts = 0;
	const mainRuntime: RuntimeContext = {
		treeDepth: 0,
		depthPolicy: defaultRootPolicy(),
	};

	const showMessage = (
		ctx: { ui: { notify(message: string, type?: string): void } },
		content: string,
		type: string = "info",
	) => {
		ctx.ui.notify(content, type);
	};

	const configuredDefaultRootAgent = (): string => {
		const flag = pi.getFlag("defaultRootAgent");
		return typeof flag === "string" && flag.trim() ? flag.trim() : DEFAULT_ROOT_AGENT_NAME;
	};

	const configuredLauncherRootAgent = (): string | undefined => {
		const raw = process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
		return typeof raw === "string" ? raw.trim() || undefined : undefined;
	};

	const getLatestSelectedRootAgentForSession = (ctx: {
		sessionManager: { getEntries: () => Array<{ type: string; customType?: string; data?: unknown }> };
	}): string | undefined => {
		try {
			return getSelectedRootAgentFromSessionEntries(ctx.sessionManager.getEntries());
		} catch {
			return undefined;
		}
	};

	const resolveRootAgentForSession = (selectedAgent?: string, fallbackRootAgent?: string): AgentConfig => {
		const discovery = discoverAgents();
		return resolveRootAgent({
			agents: discovery.agents,
			selectedAgent,
			defaultRootAgent: fallbackRootAgent || configuredDefaultRootAgent(),
		}).agent;
	};

	const resolveRootAgentForCurrentSession = (ctx: {
		sessionManager: { getEntries: () => Array<{ type: string; customType?: string; data?: unknown }> };
	}): AgentConfig => {
		const selectedFromSession = getLatestSelectedRootAgentForSession(ctx);
		if (selectedFromSession) {
			return resolveRootAgentForSession(selectedFromSession);
		}

		const flagAgent = pi.getFlag("agent");
		if (typeof flagAgent === "string" && flagAgent.trim()) {
			return resolveRootAgentForSession(flagAgent.trim());
		}

		return resolveRootAgentForSession(undefined, configuredLauncherRootAgent());
	};

	const appendSelectedRootAgentEntry = (agentName: string): void => {
		pi.appendEntry(SELECTED_ROOT_AGENT_ENTRY_TYPE, {
			[SELECTED_ROOT_AGENT_ENTRY_KEY]: agentName,
		});
	};

	const formatRootAgentResolutionError = (error: unknown): string => {
		const message = error instanceof Error ? error.message : String(error);
		return `Multi-agents configuration error: ${message}`;
	};

	const activeToolDefinitions = () => {
		const activeToolNames = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => activeToolNames.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}));
	};

	const renderDump = (title: string, systemPrompt: string, note?: string) =>
		[
			`=== ${title} ===`,
			"",
			systemPrompt,
			...(note ? ["", "=== NOTE ===", "", note] : []),
			"",
			"=== TOOLS ===",
			"",
			JSON.stringify(activeToolDefinitions(), null, 2),
		].join("\n");

	const buildFallbackPromptPartsForCurrentRoot = (ctx: { cwd: string }): PromptParts => {
		let activeTools: string[] = [];
		let allTools: Array<{ name: string; description?: string }> = [];
		try {
			activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
			allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
		} catch {
			// During early startup the ExtensionAPI may not be bound yet. The exact
			// provider-bound prompt will still be captured by /dump-prompt next.
		}
		return {
			selectedTools: activeTools,
			toolSnippets: Object.fromEntries(allTools.map((tool) => [tool.name, tool.description ?? ""])),
			promptGuidelines: [],
			contextFiles: loadProjectContextFiles({ cwd: ctx.cwd, agentDir: getAgentDir() }),
			skills: [],
			cwd: ctx.cwd,
		};
	};

	const buildPromptPartsForCurrentRoot = (ctx: { cwd: string }): PromptParts => {
		if (lastRootPromptParts?.cwd === ctx.cwd) return lastRootPromptParts;
		return buildFallbackPromptPartsForCurrentRoot(ctx);
	};

	const renderCurrentRootPromptForDump = (ctx: { cwd: string; sessionManager: any }): string => {
		const logger = makeSessionDebugLogger(ctx.sessionManager);
		const activeStore = MetadataStore.fromSessionManager(ctx.sessionManager, logger);
		activeStore.load();
		const agent = resolveRootAgentForCurrentSession(ctx);
		return renderComposedAgentSystemPrompt(
			{
				agent,
				parts: buildPromptPartsForCurrentRoot(ctx),
			},
			discoverPromptParts().parts,
		);
	};

	const makeAgentRuntimeFactory = (
		agent: AgentConfig,
		runtime: RuntimeContext,
		_effectiveCwd: string,
		contextFiles?: Array<{ path: string; content: string }>,
	): ExtensionFactory => {
		return (subPi) => {
			registerTaskTool(subPi, runtime);

			// Discover prompt parts for this sub-agent's effective working directory.
			const promptPartDefs = discoverPromptParts().parts;

			subPi.on("before_agent_start", async (event) => {
				const parts = buildPromptPartsFromOptions(event.systemPromptOptions);
				if (contextFiles) parts.contextFiles = contextFiles;
				const context: RenderContext = {
					agent,
					parts,
				};
				const prompt = renderComposedAgentSystemPrompt(context, promptPartDefs, {
					baseSystemPrompt: event.systemPrompt,
					appendSystemPrompt: event.systemPromptOptions.appendSystemPrompt,
					includeSubagentReportingNotice: true,
				});
				return { systemPrompt: prompt };
			});
		};
	};

	const controller = new TaskController();

	const runTask = async (
		params: { description: string; prompt: string; subagent_type: string; resume?: string; cwd?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: TaskResult) => void) | undefined,
		ctx: any,
		runtime: RuntimeContext,
	): Promise<TaskResult> => {
		const activeStore = runtime.store ?? MetadataStore.fromSessionManager(ctx.sessionManager, runtime.logger);
		const sm = getOrCreateSessionManager(runtime.logger);

		// Build adapter objects from concrete classes.
		// MetadataStore / SubagentSessionManager already satisfy their
		// respective adapter interfaces.
		const agentDiscoveryAdapter: AgentDiscoveryAdapter = {
			discover() {
				const registry = new AgentRegistry();
				registry.discover();
				return {
					agents: registry.agents,
					diagnostics: registry.diagnostics,
				};
			},
		};

		const executeContext: TaskExecuteContext = {
			cwd: ctx.cwd,
			signal,
			runtime,
			agentDiscovery: agentDiscoveryAdapter,
			metadataStore: activeStore,
			sessionManager: sm,
			modelResolver: new PiModelResolver(ctx.modelRegistry),
			fallbackModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			createResourceLoaderFactory: async (agent, childRuntime, effectiveCwd, onWarnings) => {
				const agentDir = getAgentDir();
				const contextFiles = loadProjectContextFiles({ cwd: effectiveCwd, agentDir });
				const inheritsRootTrust = isSameOrDescendantCwd(ctx.cwd, effectiveCwd);
				const hasCloserTrustDecision =
					inheritsRootTrust && hasCloserSavedTrustDecision(ctx.cwd, effectiveCwd, agentDir);
				const liveRootProjectTrust =
					inheritsRootTrust && typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
				const rootProjectTrust =
					liveRootProjectTrust !== undefined && (!liveRootProjectTrust || !hasCloserTrustDecision)
						? liveRootProjectTrust
						: undefined;
				const { settingsManager } = createTrustAwareSettings({
					cwd: effectiveCwd,
					agentDir,
					...(rootProjectTrust === undefined ? {} : { projectTrustOverride: rootProjectTrust }),
				});
				const extensionCandidates = await resolveConfiguredExtensionCandidates({
					cwd: effectiveCwd,
					agentDir,
					settingsManager,
				});
				const extensionSelection = resolveExtensionsForAgent(agent, extensionCandidates);
				if (extensionSelection.warnings.length > 0) {
					runtime.logger?.warn("task_extension_filter", {
						agent: agent.name,
						warnings: extensionSelection.warnings,
					});
					onWarnings?.(extensionSelection.warnings);
				}
				// The inline factory below provides the sub-agent-specific multi-agents
				// runtime. Do not also load this root extension path into the child:
				// its session_shutdown handler disposes the shared session manager and
				// can deadlock while the parent is already disposing this child session.
				const additionalExtensionPaths = [...new Set(extensionSelection.paths)];
				const loader = new DefaultResourceLoader({
					cwd: effectiveCwd,
					agentDir,
					settingsManager,
					noContextFiles: true,
					noExtensions: true,
					additionalExtensionPaths,
					appendSystemPromptOverride: () => [],
					extensionFactories: [makeAgentRuntimeFactory(agent, childRuntime, effectiveCwd, contextFiles)],
					systemPromptOverride: () => agent.systemPrompt,
				});
				await loader.reload();
				return { resourceLoader: loader, settingsManager };
			},
			onUpdate,
		};

		return controller.execute(params, executeContext);
	};

	function registerTaskTool(targetPi: ExtensionAPI, runtime: RuntimeContext): void {
		configureTaskToolForRuntime(targetPi, runtime, runTask, {
			getSessionManager: getOrCreateSessionManager,
			consumeWaitForAgentIds: (ids) => _asyncAgentNotifier.consume(ids),
		});
	}

	pi.registerFlag("agent", {
		description: "Start with a configured agent persona",
		type: "string",
		default: "",
	});

	pi.registerFlag("defaultRootAgent", {
		description: "Default Root agent definition to use when no session-local /agent selection exists",
		type: "string",
		default: DEFAULT_ROOT_AGENT_NAME,
	});

	pi.on("input", async (event, ctx) => {
		try {
			resolveRootAgentForCurrentSession(ctx);
		} catch (error) {
			showMessage(ctx, formatRootAgentResolutionError(error), "error");
			return { action: "handled" as const };
		}

		if (event.source !== "extension") {
			rootFinalResponseGuardActive = false;
			rootFinalResponseGuardAttempts = 0;
		}

		if (event.source !== "extension") {
			const notification = _asyncAgentNotifier.takeDueNotification("input");
			if (notification) {
				return {
					action: "transform" as const,
					text: `${notification}\n\n${event.text}`,
					images: event.images,
				};
			}
		}

		return { action: "continue" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		dumpNextProviderRequest = false;
		lastProviderSystemPrompt = undefined;
		lastRootPromptParts = undefined;
		const rootLogger = makeSessionDebugLogger(ctx.sessionManager);
		const activeStore = MetadataStore.fromSessionManager(ctx.sessionManager, rootLogger);
		mainRuntime.logger = rootLogger;
		mainRuntime.store = activeStore;
		store = activeStore;
		rootLogger.info("root_session_start", { sessionDir: ctx.sessionManager.getSessionDir() });
		activeStore.load();

		const launcherTrust = readLauncherProjectTrust();
		if (launcherTrust && typeof ctx.isProjectTrusted === "function") {
			const actualProjectTrusted = ctx.isProjectTrusted();
			const actualCwd = canonicalCwd(ctx.cwd);
			if (launcherTrust.projectTrusted !== actualProjectTrusted || launcherTrust.cwd !== actualCwd) {
				const requestFile = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
				const selectedSessionPath = ctx.sessionManager.getSessionFile();
				const selectedSessionId = ctx.sessionManager.getSessionId();
				if (!requestFile?.trim() || !selectedSessionId) {
					showMessage(
						ctx,
						"Project trust changed after launcher resource resolution, but the current session cannot be restarted automatically.",
						"warning",
					);
				} else {
					let restartPrepared = true;
					try {
						writeTrustRestartRequest(requestFile, selectedSessionPath, selectedSessionId, actualProjectTrusted);
					} catch {
						restartPrepared = false;
						clearRestartRequest(requestFile);
						showMessage(ctx, "Failed to save the project-trust restart request.", "error");
					}

					if (restartPrepared) {
						showMessage(ctx, "Restarting Pi so agent extensions match the selected project trust.", "info");
					}
					if (
						restartPrepared &&
						requestPiShutdown(ctx, requestFile, {
							onFailure: () => {
								showMessage(
									ctx,
									"Failed to restart after the project-trust change. Staying in the current session.",
									"error",
								);
							},
						})
					) {
						return;
					}
				}
			}
		}

		if (process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] === "1") {
			const requestFile = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
			if (requestFile?.trim()) {
				let selectedSessionPath: string | undefined;
				try {
					selectedSessionPath = ctx.sessionManager.getSessionFile();
					if (!selectedSessionPath) {
						throw new Error("No selected session found.");
					}
					writeResumeSessionRestartRequest(requestFile, selectedSessionPath);
				} catch {
					clearRestartRequest(requestFile);
					showMessage(
						ctx,
						"Failed to save the selected session resume request. Staying in the current session.",
						"error",
					);
					return;
				}

				showMessage(ctx, "Restarting Pi with selected session in a fresh process.", "info");
				requestPiShutdown(ctx, requestFile, {
					onFailure: () => {
						showMessage(
							ctx,
							`Failed to prepare resume-session restart for "${selectedSessionPath}". Staying in the current session.`,
							"error",
						);
					},
				});
			}
			return;
		}

		const hasSessionSelection = Boolean(getLatestSelectedRootAgentForSession(ctx));
		let rootAgent: AgentConfig;
		try {
			rootAgent = resolveRootAgentForCurrentSession(ctx);
		} catch (error) {
			showMessage(ctx, formatRootAgentResolutionError(error), "error");
			deactivateTaskTool(pi);
			return;
		}
		if (!hasSessionSelection || getLatestSelectedRootAgentForSession(ctx) !== rootAgent.name) {
			appendSelectedRootAgentEntry(rootAgent.name);
		}
		mainRuntime.treeDepth = 0;
		mainRuntime.depthPolicy = selectedRootPolicy(rootAgent);

		// Reconcile Task with the resolved Root policy so DepthPolicy
		// informs both the schema enum and active-tool availability.
		registerTaskTool(pi, mainRuntime);
	});

	const sendFinalResponseGuard = (options: { delayed?: boolean } = {}) => {
		rootFinalResponseGuardActive = true;
		rootFinalResponseGuardAttempts++;
		const send = () => {
			pi.sendMessage(
				{
					customType: "system",
					content: FINAL_RESPONSE_REQUIRED_MESSAGE,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};
		if (options.delayed) setTimeout(send, 0);
		else send();
	};

	pi.on("agent_start", () => {
		rootFinalResponseGuardActive = false;
	});

	const sendAsyncAgentNotification = (options: { delayed?: boolean } = {}) => {
		const send = () => {
			const notification = _asyncAgentNotifier.takeDueNotification("turn_end");
			if (!notification) return;
			pi.sendMessage(
				{
					customType: "system",
					content: notification,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};
		if (options.delayed) setTimeout(send, 0);
		else send();
	};

	pi.on("agent_end", (event: any) => {
		if (
			!rootFinalResponseGuardActive &&
			rootFinalResponseGuardAttempts < FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS &&
			needsFinalResponsePrompt(event?.messages ?? [])
		) {
			sendFinalResponseGuard({ delayed: true });
		}
		sendAsyncAgentNotification({ delayed: true });
	});

	// Inject async-agent completion notifications at run boundaries and input
	// batching points. Revalidate after agent_end instead of queuing static
	// follow-up text from turn_end; the root agent may consume the result before
	// the queued follow-up would be delivered.
	pi.on("turn_end", (event: any) => {
		const message = event?.message;
		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCall = content.some((part: any) => part?.type === "toolCall");
		if (
			message?.role === "assistant" &&
			!rootFinalResponseGuardActive &&
			rootFinalResponseGuardAttempts < FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS &&
			!hasToolCall &&
			needsFinalResponsePrompt([message])
		) {
			sendFinalResponseGuard();
		}
	});

	pi.on("session_shutdown", async (event, _ctx) => {
		mainRuntime.logger?.info?.("root_session_shutdown", {
			reason: event.reason,
			hasStore: Boolean(store),
		});
		_sessionManager?.setOnAsyncResultReady(undefined);
		await _sessionManager?.disposeAll();
		_sessionManager = undefined;
		_asyncAgentNotifier.clear();
		if (event.reason === "new") {
			mainRuntime.logger?.info?.("root_session_cleanup_start");
			store?.cleanup();
			store = undefined;
			mainRuntime.logger?.info?.("root_session_cleanup_done");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store) {
			const logger = mainRuntime.logger ?? makeNoopDebugLogger();
			store = MetadataStore.fromSessionManager(ctx.sessionManager, logger);
		}
		const agent = resolveRootAgentForCurrentSession(ctx);
		mainRuntime.store = store;
		mainRuntime.treeDepth = 0;
		mainRuntime.depthPolicy = selectedRootPolicy(agent);

		// Reconcile Task with the current Root policy (before_agent_start
		// acts as a safety net when session_start was skipped or
		// the policy changed between events).
		registerTaskTool(pi, mainRuntime);

		const pParts = buildPromptPartsFromOptions(event.systemPromptOptions);
		lastRootPromptParts = pParts;
		const promptPartDefs = discoverPromptParts().parts;
		const prompt = renderComposedAgentSystemPrompt(
			{
				agent,
				parts: pParts,
			},
			promptPartDefs,
			{
				baseSystemPrompt: event.systemPrompt,
				appendSystemPrompt: event.systemPromptOptions.appendSystemPrompt,
			},
		);
		return { systemPrompt: prompt };
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		lastProviderSystemPrompt = prompt;
		if (!dumpNextProviderRequest) return;

		dumpNextProviderRequest = false;
		showMessage(ctx, renderDump("SYSTEM PROMPT SENT TO PROVIDER", prompt), "info");
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (event.type !== "session_before_switch" || event.reason !== "resume" || !event.targetSessionFile) {
			return;
		}

		const requestFile = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
		if (!requestFile?.trim()) {
			return;
		}
		try {
			writeResumeSessionRestartRequest(requestFile, event.targetSessionFile);
		} catch {
			clearRestartRequest(requestFile);
			showMessage(
				ctx,
				`Failed to save the requested resume-session restart for "${event.targetSessionFile}". Staying in the current session.`,
				"error",
			);
			return { cancel: true };
		}
		showMessage(ctx, `Restarting Pi with selected session in a fresh process.`, "info");
		requestPiShutdown(ctx, requestFile, {
			onFailure: () => {
				showMessage(
					ctx,
					`Failed to prepare resume-session restart for "${event.targetSessionFile}". Staying in the current session.`,
					"error",
				);
			},
		});
		return { cancel: true };
	});

	pi.registerCommand("dump-prompt", {
		description: "Dump system prompt + all tool definitions (including those without promptSnippet)",
		handler: async (args, ctx) => {
			const mode = args.trim();

			if (mode === "next") {
				dumpNextProviderRequest = true;
				showMessage(
					ctx,
					"Will dump the final system prompt on the next provider request. Send a normal prompt to trigger it.",
					"info",
				);
				return;
			}

			const prompt = lastProviderSystemPrompt ?? renderCurrentRootPromptForDump(ctx);
			const title = lastProviderSystemPrompt
				? "LAST SYSTEM PROMPT SENT TO PROVIDER"
				: "CURRENT MULTI-AGENTS SYSTEM PROMPT";
			const note = lastProviderSystemPrompt
				? undefined
				: "This is the current multi-agents prompt for the selected agent. Per-turn hooks may still change the final provider prompt. Use `/dump-prompt next`, then send a normal prompt, to dump the exact provider-bound prompt.";

			showMessage(ctx, renderDump(title, prompt, note), "info");
		},
	});

	pi.registerCommand("agent", {
		description: "Select or show the current Root agent persona",
		getArgumentCompletions(prefix) {
			const discovery = discoverAgents();
			return discovery.agents
				.filter((agent) => agent.name.startsWith(prefix))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			const discovery = discoverAgents();
			if (!name) {
				const available = formatAgentList(discovery.agents, 30).text;
				const current = resolveRootAgentForCurrentSession(ctx).name;
				showMessage(ctx, `Current agent: ${current}\n\nAvailable: ${available}`, "info");
				return;
			}
			const agent = findAgent(discovery.agents, name);
			if (!agent) {
				const available = formatAgentList(discovery.agents, 30).text;
				showMessage(ctx, `Unknown agent "${name}".\n\nAvailable: ${available}`, "warning");
				return;
			}
			const requestFile = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
			if (!requestFile?.trim()) {
				showMessage(
					ctx,
					"Cannot restart with a different Root agent: launcher restart file is missing. Start Pi with pi-agents.",
					"error",
				);
				return;
			}
			try {
				writeRestartRequest(requestFile, agent.name);
			} catch {
				showMessage(ctx, "Failed to save the requested Root-agent restart request.", "error");
				return;
			}
			showMessage(ctx, `Restarting Pi with Root agent "${agent.name}" in a fresh session.`, "info");
			requestPiShutdown(ctx, requestFile, {
				onFailure: () => {
					showMessage(
						ctx,
						`Failed to prepare Root-agent session restart for "${agent.name}". Staying in the current session.`,
						"error",
					);
				},
			});
		},
	});
}

export const waitForAgent: TaskController["waitForAgent"] = async (agentIds, opts, context) => {
	const result = await new TaskController().waitForAgent(agentIds, opts, {
		...context,
		consumeWaitForAgentIds: (ids) => _asyncAgentNotifier.consume(ids),
	});
	return result;
};

export type {
	RuntimeContext,
	TaskDetails,
	TaskExecuteContext,
	TaskExecuteParams,
	TaskResult,
} from "./task-controller.js";
