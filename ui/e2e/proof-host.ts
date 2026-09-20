import { createCoreSpeechHost } from "./core-speech-host.ts";

const speech =
	Bun.env.RYU_VIDEO_STUDIO_PROOF_IMAGE === "1" ||
	Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO === "1" ||
	Bun.env.RYU_VIDEO_STUDIO_PROOF_MODEL === "1" ||
	Bun.env.RYU_VIDEO_STUDIO_PROOF_TTS === "1" ||
	Bun.env.RYU_VIDEO_STUDIO_PROOF_STT === "1" ||
	Bun.env.RYU_VIDEO_STUDIO_PROOF_SPACES === "1"
		? await createCoreSpeechHost({
				mediaOnly: true,
				narration: Bun.env.RYU_VIDEO_STUDIO_PROOF_TTS === "1",
				model: Bun.env.RYU_VIDEO_STUDIO_PROOF_MODEL === "1",
				image: Bun.env.RYU_VIDEO_STUDIO_PROOF_IMAGE === "1",
				video: Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO === "1",
			})
		: null;
const spaces =
	Bun.env.RYU_VIDEO_STUDIO_PROOF_SPACES === "1" && speech
		? speech.spaces
		: null;
if (spaces && speech) {
	try {
		await speech.enableSpaces();
	} catch (error) {
		speech.stop();
		throw error;
	}
}
if (speech && Bun.env.RYU_VIDEO_STUDIO_PROOF_MODEL === "1") {
	try {
		await speech.enableModel();
	} catch (error) {
		speech.stop();
		throw error;
	}
}
if (
	speech &&
	(Bun.env.RYU_VIDEO_STUDIO_PROOF_IMAGE === "1" ||
		Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO === "1")
) {
	try {
		await speech.enableMedia();
	} catch (error) {
		speech.stop();
		throw error;
	}
}
const token = Bun.env.RYU_VIDEO_STUDIO_PROOF_TOKEN ?? crypto.randomUUID();
const sidecar = Bun.spawn(
	[new URL("../../sidecar/dist/ryu-video-studio", import.meta.url).pathname],
	{
		env: {
			...process.env,
			RYU_EXT_TOKEN: token,
			RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
			RYU_CORE_PORT: "27980",
			RYU_PROFILE: "dev",
			RYU_KEYCHAIN: "off",
			RYU_DIR: "/tmp/ryu-video-studio-proof",
			RYU_VIDEO_STUDIO_PORT: "18041",
		},
		stdout: "inherit",
		stderr: "inherit",
	}
);
let healthy = false;
for (let attempt = 0; attempt < 50; attempt++) {
	if (sidecar.exitCode !== null) {
		speech?.stop();
		throw new Error("The proof sidecar exited during startup.");
	}
	healthy = await fetch("http://127.0.0.1:18041/api/video-studio/projects", {
		headers: { authorization: `Bearer ${token}` },
	}).then(
		(response) => response.ok,
		() => false
	);
	if (healthy) {
		break;
	}
	await Bun.sleep(100);
}
if (!healthy) {
	sidecar.kill();
	speech?.stop();
	throw new Error("The authenticated proof sidecar did not become ready.");
}
const bridge = `<script>window.ryu={app:{request:async(input)=>{const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Request failed');return result;}}};</script>`;
const speechBridge = speech
	? `<script>window.ryu.media={transcribe:async(input)=>{const response=await fetch("/__transcribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message);return input.detailed?result:result.text;}};</script>`
	: "";
const narrationBridge =
	speech && Bun.env.RYU_VIDEO_STUDIO_PROOF_TTS === "1"
		? `<script>window.ryu.media.tts=async input=>{const response=await fetch('/__narration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message);return result.audio;};</script>`
		: "";
const spacesBridge = spaces
	? `<script>window.ryu.spaces=Object.fromEntries(["ensureSpace","createDoc","getDoc","updateDoc","deleteDoc","search"].map(method=>[method,async args=>{const response=await fetch('/__spaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});const result=await response.json();if(!response.ok)throw new Error(result.message);return result;}]))</script>`
	: "";
const modelBridge =
	speech && Bun.env.RYU_VIDEO_STUDIO_PROOF_MODEL === "1"
		? `<script>window.ryu.model={complete:async input=>{const response=await fetch('/__model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message);return result.text;}};</script>`
		: "";
const imageBridge =
	speech && Bun.env.RYU_VIDEO_STUDIO_PROOF_IMAGE === "1"
		? `<script>window.ryu.media.image=async input=>{const response=await fetch('/__image',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message);return result.images;};</script>`
		: "";
const videoBridge =
	speech && Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO === "1"
		? `<script>window.ryu.media.video=async input=>{const response=await fetch('/__video',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message);return result.videos;};</script>`
		: "";
const server = Bun.serve({
	idleTimeout: 120,
	maxRequestBodySize: 2 * 1024 * 1024,
	hostname: "127.0.0.1",
	port: 5185,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__image" && request.method === "POST") {
			try {
				if (!speech || Bun.env.RYU_VIDEO_STUDIO_PROOF_IMAGE !== "1") {
					throw new Error("Image proof unavailable");
				}
				const input = (await request.json()) as {
					prompt?: unknown;
					provider?: string;
					model?: string;
					request_id?: string;
				};
				if (typeof input.prompt !== "string" || input.prompt.length > 8000) {
					throw new Error("Invalid image prompt");
				}
				return Response.json({
					images: await speech.image({
						...input,
						prompt: input.prompt,
						count: 1,
					}),
				});
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error
								? error.message
								: "Image generation failed",
					},
					{ status: 400 }
				);
			}
		}

		if (url.pathname === "/__video" && request.method === "POST") {
			try {
				if (!speech || Bun.env.RYU_VIDEO_STUDIO_PROOF_VIDEO !== "1") {
					throw new Error("Video proof unavailable");
				}
				const input = (await request.json()) as {
					prompt?: unknown;
					provider?: string;
					model?: string;
					request_id?: string;
				};
				if (typeof input.prompt !== "string" || input.prompt.length > 8000) {
					throw new Error("Invalid video prompt");
				}
				if ((input.provider && input.provider !== "local") || input.model) {
					throw new Error(
						"This proof host uses only its fixed local video model."
					);
				}
				const generated = await speech.video({
					prompt: input.prompt,
					...(input.request_id ? { request_id: input.request_id } : {}),
				});
				return Response.json({ videos: generated.data ?? [] });
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error
								? error.message
								: "Video generation failed",
					},
					{ status: 400 }
				);
			}
		}

		if (url.pathname === "/__model" && request.method === "POST") {
			try {
				if (!speech || Bun.env.RYU_VIDEO_STUDIO_PROOF_MODEL !== "1") {
					throw new Error("Model proof unavailable");
				}
				const input = (await request.json()) as {
					prompt?: unknown;
					system?: unknown;
				};
				if (
					typeof input.prompt !== "string" ||
					input.prompt.length > 32_000 ||
					(input.system !== undefined &&
						(typeof input.system !== "string" || input.system.length > 32_000))
				) {
					throw new Error("Invalid model input");
				}
				return Response.json({
					text: await speech.model({
						prompt: input.prompt,
						...(typeof input.system === "string"
							? { system: input.system }
							: {}),
					}),
				});
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error ? error.message : "Model request failed",
					},
					{ status: 400 }
				);
			}
		}

		if (url.pathname === "/__narration" && request.method === "POST") {
			try {
				if (!speech || Bun.env.RYU_VIDEO_STUDIO_PROOF_TTS !== "1") {
					throw new Error("Narration proof unavailable");
				}
				const input = (await request.json()) as {
					text?: unknown;
					request_id?: string;
					voice?: string;
					language?: string;
					speed?: number;
				};
				if (typeof input.text !== "string" || input.text.length > 8000) {
					throw new Error("Invalid narration text");
				}
				const blob = await speech.speak({ ...input, text: input.text });
				return Response.json({
					audio: `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
				});
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error ? error.message : "Narration failed",
					},
					{ status: 400 }
				);
			}
		}

		if (url.pathname === "/__spaces" && request.method === "POST") {
			try {
				const input = (await request.json()) as {
					method: string;
					args: unknown;
				};
				if (!(spaces && Object.hasOwn(spaces, input.method))) {
					throw new Error("Space method unavailable");
				}
				const method = spaces[input.method as keyof typeof spaces];
				return Response.json(await method(input.args));
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error ? error.message : "Space operation failed",
					},
					{ status: 400 }
				);
			}
		}
		if (url.pathname === "/__transcribe" && request.method === "POST") {
			if (!speech) {
				return Response.json(
					{ message: "Core speech proof is unavailable" },
					{ status: 503 }
				);
			}
			try {
				const input = (await request.json()) as { audio?: unknown };
				if (
					typeof input.audio !== "string" ||
					!input.audio.startsWith("data:audio/wav;base64,") ||
					input.audio.length > 1_500_000
				) {
					throw new Error("Invalid proof audio window");
				}
				const blob = new Blob(
					[Buffer.from(input.audio.split(",")[1] ?? "", "base64")],
					{ type: "audio/wav" }
				);
				return Response.json(await speech.transcribe(blob));
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error ? error.message : "Transcription failed",
					},
					{ status: 400 }
				);
			}
		}

		if (url.pathname.startsWith("/__studio/")) {
			return fetch(
				`http://127.0.0.1:18041/api/video-studio${url.pathname.slice("/__studio".length)}${url.search}`,
				{
					method: request.method,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					...(["GET", "HEAD"].includes(request.method)
						? {}
						: { body: await request.arrayBuffer() }),
				}
			);
		}
		const html = (
			await Bun.file(new URL("../dist/index.html", import.meta.url)).text()
		).replace(
			"<head>",
			`<head>${bridge}${speechBridge}${narrationBridge}${spacesBridge}${modelBridge}${imageBridge}${videoBridge}`
		);
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});
let stopped = false;
const stop = () => {
	if (stopped) {
		return;
	}
	stopped = true;
	speech?.stop();
	server.stop();
	sidecar.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
