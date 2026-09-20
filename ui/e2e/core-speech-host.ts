import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { transcribeAudioDetailed } from "../../../../packages/core-client/src/voice.ts";

export async function createCoreSpeechHost(
	options: {
		narration?: boolean;
		model?: boolean;
		image?: boolean;
		video?: boolean;
		mediaOnly?: boolean;
	} = {}
) {
	const root = new URL("../../../../", import.meta.url).pathname;
	const directory = "/tmp/ryu-video-studio-core-proof";
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const preferences = new Database(`${directory}/preferences.db`, {
		create: true,
	});
	preferences.exec(
		"CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)"
	);
	preferences
		.query("INSERT OR REPLACE INTO preferences VALUES (?,?,?)")
		.run("skills.sync-system", "false", Date.now());
	preferences.close();
	const model = `${directory}/models/ggml-tiny.en.bin`;
	if (!(await Bun.file(model).exists())) {
		throw new Error("Prepare the local Whisper tiny.en proof model first.");
	}
	const profile = `${directory}/loopback-only.sb`;
	await Bun.write(
		profile,
		'(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n'
	);
	const log = createWriteStream(`${directory}/speech-proof.log`, {
		flags: "a",
		mode: 0o600,
	});
	const modelCache = options.narration
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const name = new URL(request.url).pathname;
					const path =
						name === "/kokoro"
							? `${directory}/models/kokoro-v1.0.onnx`
							: name === "/voices"
								? `${directory}/models/kokoro-voices-v1.0.bin`
								: null;
					return path
						? new Response(Bun.file(path))
						: new Response("Not found", { status: 404 });
				},
			})
		: null;
	const ttsSource = `${directory}/tts-sidecar`;
	const ttsEngine = Bun.env.RYU_VIDEO_STUDIO_PROOF_TTS_ENGINE ?? "kokoro";
	if (modelCache && !(await Bun.file(`${ttsSource}/pyproject.toml`).exists())) {
		const copy = Bun.spawn({
			cmd: ["cp", "-R", `${root}apps-store/voice/sidecar`, ttsSource],
			stdout: "ignore",
			stderr: "pipe",
		});
		if ((await copy.exited) !== 0) {
			throw new Error(
				`Could not prepare the local voice sidecar: ${await new Response(copy.stderr).text()}`
			);
		}
	}
	if (modelCache && ttsEngine === "outetts") {
		const binary = `${directory}/bin/llamacpp/llama-tts`;
		if (!(await Bun.file(binary).exists())) {
			await mkdir(`${directory}/bin`, { recursive: true, mode: 0o700 });
			const copy = Bun.spawn({
				cmd: [
					"cp",
					"-R",
					`${homedir()}/.ryu-dev/bin/llamacpp`,
					`${directory}/bin/llamacpp`,
				],
				stdout: "ignore",
				stderr: "pipe",
			});
			if ((await copy.exited) !== 0) {
				throw new Error(
					`Could not prepare the local OuteTTS binary: ${await new Response(copy.stderr).text()}`
				);
			}
		}
	}
	const children: ChildProcess[] = [];
	let stopped = false;
	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		modelCache?.stop();
		for (const child of children) {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill();
				}
			}
		}
		for (const child of children) {
			child.stdout?.unpipe(log);
			child.stderr?.unpipe(log);
		}
		log.end();
	};
	const token = crypto.randomUUID();
	try {
		const gatewayKey = async (name: string, prefix: string) => {
			const path = `${directory}/${name}`;
			if (!(await Bun.file(path).exists())) {
				await Bun.write(
					path,
					`${prefix}${crypto.randomUUID().replaceAll("-", "")}`
				);
				await chmod(path, 0o600);
			}
			return (await Bun.file(path).text()).trim();
		};
		const gateway = spawn(
			Bun.env.RYU_VIDEO_STUDIO_PROOF_GATEWAY_BIN ??
				`${root}target/debug/ryu-gateway`,
			["--bind=127.0.0.1:28981"],
			{
				cwd: root,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					GATEWAY_ADMIN_KEY: await gatewayKey("gateway-admin.key", "gwadm_"),
					GATEWAY_CONFIG: `${directory}/gateway.toml`,
					GATEWAY_CORE_RELAY_KEY: await gatewayKey(
						"gateway-core-relay.key",
						"gwcore_"
					),
					GATEWAY_RELAY_KEY: await gatewayKey("gateway-relay.key", "gwrelay_"),
					RYU_DIR: directory,
					RYU_GATEWAY_MANAGED: "1",
					RYU_GATEWAY_REMOTE: "0",
					RYU_KEYCHAIN: "off",
					LOCAL_LLM_URL: "http://127.0.0.1:28080/v1",
					RYU_MANAGED_NODE: "0",
					RYU_PROFILE: "dev",
					RYU_PORT_OFFSET: "20000",
				},
			}
		);
		children.push(gateway);
		gateway.stdout?.pipe(log, { end: false });
		gateway.stderr?.pipe(log, { end: false });
		let gatewayReady = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			gatewayReady = await fetch("http://127.0.0.1:28981/health").then(
				(response) => response.ok,
				() => false
			);
			if (gatewayReady) {
				break;
			}
			if (gateway.exitCode !== null) {
				throw new Error("The local proof Gateway exited during startup.");
			}
			await Bun.sleep(250);
		}
		if (!gatewayReady) {
			throw new Error("The local proof Gateway did not become ready.");
		}
		const language = options.model
			? spawn(
					Bun.env.RYU_VIDEO_STUDIO_PROOF_LLAMA_BIN ?? "llama-server",
					[
						"-m",
						`${directory}/models/Qwen3-4B-Q4_K_M.gguf`,
						"--host",
						"127.0.0.1",
						"--port",
						"28080",
						"--alias",
						"video-studio-qwen3-4b-proof",
						"--ctx-size",
						"8192",
						"--reasoning",
						"on",
						"--reasoning-budget",
						"512",
					],
					{ detached: true, stdio: ["ignore", "pipe", "pipe"] }
				)
			: null;
		if (language) {
			children.push(language);
			language.stdout?.pipe(log, { end: false });
			language.stderr?.pipe(log, { end: false });
			let ready = false;
			for (let attempt = 0; attempt < 240; attempt++) {
				ready = await fetch("http://127.0.0.1:28080/health").then(
					(response) => response.ok,
					() => false
				);
				if (ready) {
					break;
				}
				if (language.exitCode !== null) {
					throw new Error("The local language model exited during startup.");
				}
				await Bun.sleep(250);
			}
			if (!ready) {
				throw new Error("The local language model did not become ready.");
			}
		}
		const adoptDiffusion =
			(options.image || options.video) &&
			Bun.env.RYU_VIDEO_STUDIO_PROOF_ADOPT_SD === "1";
		const proofModelPath = async (name: string) => {
			const configuredRoot = Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO_MODEL_DIR;
			const candidates = [
				...(configuredRoot ? [`${configuredRoot}/${name}`] : []),
				`${directory}/models/${name}`,
				`${homedir()}/.ryu-dev/models/${name}`,
			];
			for (const candidate of candidates) {
				if (await Bun.file(candidate).exists()) {
					return candidate;
				}
			}
			throw new Error(
				`The local video proof model is missing: ${name}. Set RYU_VIDEO_STUDIO_PROOF_VIDEO_MODEL_DIR or install the model under ~/.ryu-dev/models.`
			);
		};
		const videoModels = options.video
			? {
					diffusion: await proofModelPath("wan2.1_t2v_1.3b-q8_0.gguf"),
					t5xxl: await proofModelPath("umt5-xxl-encoder-Q5_K_M.gguf"),
					vae: await proofModelPath("wan_2.1_vae.safetensors"),
				}
			: null;
		const diffusion =
			(options.image || options.video) && !adoptDiffusion
				? spawn(
						Bun.env.RYU_VIDEO_STUDIO_PROOF_SD_BIN ??
							`${homedir()}/.ryu-dev/bin/sd-server`,
						[
							...(options.video
								? [
										"--diffusion-model",
										videoModels?.diffusion ?? "",
										"--t5xxl",
										videoModels?.t5xxl ?? "",
										"--vae",
										videoModels?.vae ?? "",
										"--vae-tiling",
									]
								: [
										"-m",
										Bun.env.RYU_VIDEO_STUDIO_PROOF_SD_MODEL ??
											`${homedir()}/.ryu-dev/models/stable-diffusion-v1-4-Q8_0.gguf`,
									]),
							"--listen-ip",
							"127.0.0.1",
							"--listen-port",
							"28083",
							...(options.video ? ["--backend", "diffusion=cpu,vae=cpu"] : []),
							"--steps",
							"20",
						],
						{
							cwd: directory,
							detached: true,
							stdio: ["ignore", "pipe", "pipe"],
						}
					)
				: null;
		if (diffusion) {
			children.push(diffusion);
			diffusion.stdout?.pipe(log, { end: false });
			diffusion.stderr?.pipe(log, { end: false });
			let ready = false;
			for (let attempt = 0; attempt < 480; attempt++) {
				ready = await fetch("http://127.0.0.1:28083/").then(
					(response) => response.status !== 503,
					() => false
				);
				if (ready) {
					break;
				}
				if (diffusion.exitCode !== null) {
					throw new Error("The image model exited during startup.");
				}
				await Bun.sleep(250);
			}
			if (!ready) {
				throw new Error("The local image model did not become ready.");
			}
		}

		children.push(
			spawn(
				"/opt/homebrew/opt/whisper-cpp/bin/whisper-server",
				["-m", model, "--host", "127.0.0.1", "--port", "28090", "-t", "2"],
				{ detached: true, stdio: ["ignore", "pipe", "pipe"] }
			)
		);
		children.push(
			spawn(
				"/usr/bin/sandbox-exec",
				["-f", profile, `${root}target/debug/ryu-core`],
				{
					cwd: root,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						RYU_PROFILE: "dev",
						RYU_KEYCHAIN: "off",
						RYU_DIR: directory,
						RYU_BIND: "127.0.0.1:27980",
						RYU_PORT_OFFSET: "20000",
						RYU_TOKEN: token,
						RYU_MESH_ENABLED: "0",
						RYU_RTK_BIN: `${directory}/disabled-rtk`,
						RYU_STT_ENGINE: "whisper",
						RYU_WHISPER_MODEL: model,
						...(modelCache
							? {
									RYU_KOKORO_MODEL_URL: `http://127.0.0.1:${modelCache.port}/kokoro`,
									RYU_KOKORO_VOICES_URL: `http://127.0.0.1:${modelCache.port}/voices`,
									RYU_TTS_DIR: ttsSource,
									RYU_TTS_PYTHON: `${homedir()}/.local/bin/python3.14`,
									...(ttsEngine === "outetts"
										? {
												RYU_OUTETTS_MODEL: `${homedir()}/.ryu-dev/models/OuteTTS-0.2-500M-Q4_K_M.gguf`,
												RYU_OUTETTS_VOCODER: `${homedir()}/.ryu-dev/models/WavTokenizer-Large-75-F16.gguf`,
											}
										: {}),
								}
							: {}),
						RYU_GATEWAY_URL: "http://localhost:28981",
						RYU_GATEWAY_MANAGED: "1",
						RYU_GATEWAY_REMOTE: "0",
						RYU_MANAGED_NODE: "0",
						RYU_GATEWAY_BIN: `${root}target/debug/ryu-gateway`,
						GATEWAY_CONFIG: `${directory}/gateway.toml`,
					},
				}
			)
		);
		for (const child of children) {
			if (child === language || child === diffusion) {
				continue;
			}
			child.stdout?.pipe(log, { end: false });
			child.stderr?.pipe(log, { end: false });
		}
		let ready = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			const states = await Promise.all([
				fetch("http://127.0.0.1:27980/api/health").then(
					(r) => r.ok,
					() => false
				),
				fetch("http://127.0.0.1:28090/health").then(
					(r) => r.ok,
					() => false
				),
			]);
			ready = states.every(Boolean);
			if (ready) {
				break;
			}
			if (children.some((child) => child.exitCode !== null)) {
				throw new Error("A speech proof process exited during startup.");
			}
			await Bun.sleep(250);
		}
		if (!ready) {
			throw new Error("Speech proof services did not become ready.");
		}
		const call = async (path: string, method = "GET", body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:27980${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(
					path.includes("/images/") || path.includes("/video/")
						? 660_000
						: path.endsWith("/host")
							? 120_000
							: 30_000
				),
			});
			const value = await response.json();
			if (!response.ok) {
				throw new Error(
					`${response.status}: ${JSON.stringify(value).slice(0, 800)}`
				);
			}
			return value;
		};
		const host = async (method: string, args: unknown) => {
			const value = await call(
				"/api/plugins/%40ryu%2Fvideo-studio/host",
				"POST",
				{ method, args }
			);
			return value.result;
		};
		const enableHost = async (extraGrants: string[] = []) => {
			let gatewayReady = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				gatewayReady = await fetch(
					"http://127.0.0.1:28981/v1/auth/readiness?nonce=" +
						crypto.randomUUID().replaceAll("-", "").repeat(2)
				).then(
					(response) => response.ok,
					() => false
				);
				if (gatewayReady) {
					break;
				}
				await Bun.sleep(200);
			}
			if (!gatewayReady) {
				throw new Error(
					"Managed Gateway did not become ready for grant verification."
				);
			}
			await Bun.sleep(500);
			const listing = await call("/api/plugins");
			const records = Array.isArray(listing)
				? listing
				: (listing.apps ?? listing.plugins ?? []);
			const exists = records.some(
				(entry: { id?: string }) => entry.id === "@ryu/video-studio"
			);
			const bundle = await Bun.file(
				`${root}apps-store/video-studio/dist/plugin.bundle.json`
			).json();
			const proofBundle = options.mediaOnly
				? {
						...bundle,
						permission_grants: (bundle.permission_grants as string[]).filter(
							(grant) => grant !== "sidecar:process"
						),
					}
				: bundle;
			await call("/api/plugins/install-bundle", "POST", {
				...proofBundle,
				...(exists ? { update: true } : {}),
			});
			await call("/api/plugins/%40ryu%2Fvideo-studio/enable", "POST", {});
			const finalListing = await call("/api/plugins");
			const finalRecords = Array.isArray(finalListing)
				? finalListing
				: (finalListing.apps ?? finalListing.plugins ?? []);
			const record = finalRecords.find(
				(entry: { id?: string }) => entry.id === "@ryu/video-studio"
			);
			if (!record?.enabled) {
				throw new Error(
					"The isolated Video Studio record is not enabled; no grant policy will be bypassed."
				);
			}
			const approved = await call(
				"/api/plugins/%40ryu%2Fvideo-studio/grants",
				"POST",
				{
					grants: [
						"app:http",
						"spaces:docs",
						"media:transcribe",
						...extraGrants,
					],
				}
			);
			return approved;
		};
		return {
			stop,
			enableSpaces: () => enableHost(),
			enableModel: () => enableHost(["hook:side-model"]),
			enableMedia: () => enableHost(["media:generate"]),
			enableBudget: () => enableHost(["usage:read"]),
			budget: () => host("gateway.budgetSpend", {}),
			audit: () => host("gateway.audit", { limit: 20 }),
			video: (
				input:
					| string
					| {
							prompt: string;
							request_id?: string;
							provider?: string;
							model?: string;
					  }
			) => {
				const normalized =
					typeof input === "string" ? { prompt: input } : input;
				if (
					(normalized.provider && normalized.provider !== "local") ||
					normalized.model
				) {
					throw new Error(
						"This proof host uses only its fixed local video model."
					);
				}
				return call("/api/video/generate", "POST", {
					prompt: normalized.prompt,
					width: 128,
					height: 128,
					video_frames: 5,
					fps: 5,
					sample_params: { sample_steps: 1 },
					output_format: "webm",
					...(normalized.request_id
						? { request_id: normalized.request_id }
						: {}),
				});
			},

			image: async (input: {
				prompt: string;
				count?: number;
				size?: string;
				provider?: string;
				model?: string;
				request_id?: string;
			}) => {
				if ((input.provider && input.provider !== "local") || input.model) {
					throw new Error(
						"This proof host uses only its fixed local image model."
					);
				}
				const result = await call("/api/images/generate", "POST", {
					prompt: input.prompt,
					n: input.count ?? 1,
					...(input.size ? { size: input.size } : {}),
					...(input.request_id ? { request_id: input.request_id } : {}),
				});
				if (!(Array.isArray(result.data) && result.data.length)) {
					throw new Error("Core returned no generated image data.");
				}
				return result.data.map((item: { b64_json?: unknown }) => {
					if (typeof item.b64_json !== "string") {
						throw new Error("The local image engine did not return PNG data.");
					}
					return `data:image/png;base64,${item.b64_json}`;
				});
			},
			model: (input: { prompt: string; system?: string }) =>
				host("model.complete", {
					...input,
					provider: "local",
					model: "video-studio-qwen3-4b-proof",
				}),

			spaces: {
				ensureSpace: (input: unknown) => host("spaces.ensureSpace", input),
				createDoc: (input: unknown) => host("spaces.createDoc", input),
				getDoc: (input: unknown) => host("spaces.getDoc", input),
				updateDoc: (input: unknown) => host("spaces.updateDoc", input),
				deleteDoc: (input: unknown) => host("spaces.deleteDoc", input),
				search: async (input: unknown) => {
					const value = await host("spaces.search", input);
					return value.matches ?? [];
				},
			},
			speak: async (input: {
				text: string;
				request_id?: string;
				voice?: string;
				language?: string;
				speed?: number;
			}) => {
				if (ttsEngine === "outetts") {
					const response = await fetch(
						"http://127.0.0.1:27980/api/voice/speak",
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${token}`,
								"content-type": "application/json",
							},
							body: JSON.stringify({ ...input, engine: "outetts" }),
							signal: AbortSignal.timeout(180_000),
						}
					);
					if (!response.ok) {
						throw new Error(
							`Core OuteTTS failed (${response.status}): ${(await response.text()).slice(0, 500)}`
						);
					}
					return response.blob();
				}
				const snapshot = await call("/api/downloads");
				for (const task of snapshot.downloads ?? snapshot.tasks ?? []) {
					if (
						task.state === "paused" &&
						[
							`${directory}/models/kokoro-v1.0.onnx`,
							`${directory}/models/kokoro-voices-v1.0.bin`,
						].includes(task.dest_path)
					) {
						await call(
							`/api/downloads/${encodeURIComponent(task.id)}/cancel`,
							"POST",
							{}
						);
						await call(
							`/api/downloads/${encodeURIComponent(task.id)}`,
							"DELETE"
						);
					}
				}
				const install = await call("/api/setup/ryutts/install", "POST", {});
				if (!install.success) {
					throw new Error(`Narration installation refused: ${install.error}`);
				}
				for (let attempt = 0; attempt < 450; attempt++) {
					const state = await call("/api/setup/status/ryutts");
					if (state.status?.state === "installed") {
						break;
					}
					if (state.status?.state === "failed") {
						throw new Error(
							`Narration setup failed: ${JSON.stringify(state.status)}`
						);
					}
					if (attempt === 449) {
						throw new Error(
							`Narration installation did not finish: ${JSON.stringify(state)}`
						);
					}
					await Bun.sleep(200);
				}
				const started = await call("/api/sidecar/ryutts/start", "POST", {});
				if (!started.success) {
					throw new Error(`Narration startup failed: ${started.error}`);
				}
				let ready = false;
				for (let attempt = 0; attempt < 450; attempt++) {
					ready = await fetch("http://127.0.0.1:28085/health").then(
						(response) => response.ok,
						() => false
					);
					if (ready) {
						break;
					}
					await Bun.sleep(200);
				}
				if (!ready) {
					throw new Error(
						"The isolated Kokoro runtime did not become ready on its profile port."
					);
				}
				const response = await fetch("http://127.0.0.1:27980/api/voice/speak", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ ...input, engine: "kokoro" }),
					signal: AbortSignal.timeout(120_000),
				});
				if (!response.ok) {
					throw new Error(
						`Core narration failed (${response.status}): ${(await response.text()).slice(0, 500)}`
					);
				}
				return response.blob();
			},
			ttsEngines: () => call("/api/voice/tts-engines"),
			ttsInstallation: () => call("/api/setup/check/ryutts"),
			transcribe: (audio: Blob) =>
				transcribeAudioDetailed(
					{ url: "http://127.0.0.1:27980", token },
					audio,
					"proof.wav",
					"whisper"
				),
		};
	} catch (error) {
		stop();
		throw error;
	}
}
