/**
 * Voice Input Extension
 *
 * Records audio until 2 seconds of silence is detected, then transcribes using faster-whisper.
 * Usage: type "/voice" and speak — stops recording after 2s of silence (max 60s).
 * The transcribed text replaces the command and becomes your prompt — no paste needed.
 *
 * Config: set WHISPER_URL and MIC_DEVICE in .env file next to this extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Detect available microphones via FFmpeg DirectShow, return first real hardware mic */
function detectDefaultMic(): string | null {
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("ffmpeg -list_devices true -f dshow -i dummy 2>&1", { encoding: "utf8" });
    const virtualNames = ["steam", "nvidia", "virtual", "obs", "broadcast", "blackshark"];
    for (const line of output.split("\n")) {
      if (!line.includes("(audio)")) continue;
      const match = line.match(/"([^"]+)"/);
      if (match) {
        const name = match[1];
        const lower = name.toLowerCase();
        if (!virtualNames.some(v => lower.includes(v))) return name;
      }
    }
    // Fallback: return first audio device
    for (const line of output.split("\n")) {
      if (!line.includes("(audio)")) continue;
      const match = line.match(/"([^"]+)"/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

/** Load .env file next to this extension (simple KEY=VALUE parser) */
function loadEnvFile(envPath: string): Record<string, string> {
  try {
    const content = readFileSync(envPath, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function getConfig(): { whisperUrl: string; micDevice: string; silenceDuration: number } {
  const envFile = join(__dirname, ".env");
  const envVars = loadEnvFile(envFile);

  const whisperUrl = process.env.WHISPER_URL || envVars.WHISPER_URL || "https://whisper.local.johnyan.net";
  let micDevice = process.env.MIC_DEVICE || envVars.MIC_DEVICE || "";
  // Auto-detect first real hardware mic if not configured
  if (!micDevice) {
    micDevice = detectDefaultMic() || "Microphone (HyperX SoloCast)";
  }
  const silenceDuration = parseInt(process.env.SILENCE_DURATION || envVars.SILENCE_DURATION || "2", 10);

  return { whisperUrl, micDevice, silenceDuration: isNaN(silenceDuration) ? 2 : Math.max(1, silenceDuration) };
}

/** Write raw PCM buffer as WAV file. */
async function pcmToWav(pcmBuffer: Buffer, outputPath: string): Promise<void> {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8; // 32000
  const blockAlign = numChannels * bitsPerSample / 8; // 2
  const dataSize = pcmBuffer.length;
  const bufferSize = dataSize + 36;

  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset); offset += 4;
  header.writeInt32LE(bufferSize, offset); offset += 4;
  header.write("WAVE", offset); offset += 4;

  // fmt chunk
  header.write("fmt ", offset); offset += 4;
  header.writeInt32LE(16, offset); offset += 4; // chunk size
  header.writeInt16LE(1, offset); offset += 2; // PCM
  header.writeInt16LE(numChannels, offset); offset += 2;
  header.writeInt32LE(sampleRate, offset); offset += 4;
  header.writeInt32LE(byteRate, offset); offset += 4;
  header.writeInt16LE(blockAlign, offset); offset += 2;
  header.writeInt16LE(bitsPerSample, offset); offset += 2;

  // data chunk
  header.write("data", offset); offset += 4;
  header.writeInt32LE(dataSize, offset); offset += 4;

  await writeFile(outputPath, Buffer.concat([header, pcmBuffer]));
}

/** Record mic → raw PCM to stdout, analyze amplitude real-time, write WAV on stop. */
function recordAudio(durationSeconds: number, micDevice: string, silenceDuration: number): Promise<{ filePath: string; silenceEnd?: number }> {
  return new Promise((resolve, reject) => {
    const tempFile = join(tmpdir(), `voice-${Date.now()}.wav`);

    // DirectShow with detected mic device
    const proc = spawn("ffmpeg", [
      "-nostdin",
      "-y",
      "-f", "dshow",
      "-i", `audio=${micDevice}`,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      "pipe:1",
    ]);

    let settled = false;
    const pcmChunks: Buffer[] = [];
    // Track silence in ~500ms windows (16000 * 0.5 * 2 = 16000 bytes per window)
    const WINDOW_BYTES = 16000;
    let currentWindow = Buffer.alloc(0);
    let silentWindows = 0;
    const SILENT_WINDOWS_NEEDED = silenceDuration * 2; // windows per second (2 * 500ms each)
    const SILENCE_THRESHOLD = 800; // avg amplitude below this = silent

    const settle = async (silenceEnd?: number) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}

      // Assemble WAV from collected PCM
      try {
        const pcmData = Buffer.concat(pcmChunks);
        await pcmToWav(pcmData, tempFile);
        resolve({ filePath: tempFile, silenceEnd });
      } catch (e) {
        reject(e);
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      pcmChunks.push(chunk);

      // Append to remainder buffer
      const remainder = Buffer.concat([currentWindow, chunk]);
      let offset = 0;

      // Process complete windows from remainder
      while (offset + WINDOW_BYTES <= remainder.length) {
        // Calculate avg amplitude for this window
        let sum = 0;
        const samples = WINDOW_BYTES / 2;
        for (let i = offset; i < offset + WINDOW_BYTES; i += 2) {
          sum += Math.abs(remainder.readInt16LE(i));
        }
        const avg = sum / samples;

        if (avg < SILENCE_THRESHOLD) {
          silentWindows++;
          if (silentWindows >= SILENT_WINDOWS_NEEDED) {
            settle();
            return;
          }
        } else {
          silentWindows = 0;
        }
        offset += WINDOW_BYTES;
      }

      // Keep unprocessed remainder
      const remaining = remainder.length - offset;
      currentWindow = remaining > 0 ? Buffer.from(remainder.subarray(offset)) : Buffer.alloc(0);
    });

    proc.on("close", () => {
      if (!settled) settle();
    });

    setTimeout(() => settle(), (durationSeconds + 3) * 1000);
    proc.on("error", reject);
  });
}

/** Trim audio to the silence end point */
async function trimAudio(inputPath: string, outputPath: string, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "ffmpeg",
      [
        "-y",
        "-i", inputPath,
        "-t", String(duration),
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        outputPath,
      ],
      { timeout: 10000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/** Send audio file to whisper server for transcription */
async function transcribe(whisperUrl: string, filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append("file", new File([buffer], "audio.wav", { type: "audio/wav" }));
  form.append("response_format", "json");

  const res = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text || "";
}

/** Parse optional max duration from "/voice" or "/voice 30" */
function parseMaxDuration(text: string): number {
  const parts = text.split(/\s+/);
  if (parts.length >= 2) {
    const n = parseInt(parts[1], 10);
    if (!isNaN(n) && n > 2 && n <= 120) return Math.min(n, 60);
  }
  return 20;
}

/** Convert spoken "slash <command>" to "/<command>" so voice can trigger slash commands */
function voiceTextToInput(text: string): string {
  const t = text.trim();
  if (!/^slash\s+/i.test(t)) return t;
  let out = "/" + t.replace(/^slash\s+/i, "");
  // Whisper often appends a trailing "." — harmless in /look prompts but breaks bare command lookup
  if (/^\/\S+\.$/.test(out)) out = out.slice(0, -1);
  return out;
}

export default function (pi: ExtensionAPI) {
  let config: { whisperUrl: string; micDevice: string; silenceDuration: number } = {
    whisperUrl: "",
    micDevice: "",
    silenceDuration: 2,
  };

  pi.on("session_start", async (_event, ctx) => {
    config = getConfig();
    ctx.ui.setStatus("voice", "ready");
    ctx.ui.notify(`Voice input: ready (/voice or Alt+Q — stops after ${config.silenceDuration}s silence, mic: ${config.micDevice})`, "info");
  });

  // Keyboard shortcut to trigger voice input
  pi.registerShortcut("alt+q", {
    description: "Start voice input (record until silence)",
    handler: async (ctx) => {
      ctx.ui.notify(`🎙 Listening... (speak now, stops after ${config.silenceDuration}s silence)`, "info");

      try {
        const maxDuration = 20;
        const { filePath: tempFile } = await recordAudio(maxDuration, config.micDevice, config.silenceDuration);
        let filesToDelete = [tempFile];

        const text = await transcribe(config.whisperUrl, tempFile);
        for (const f of filesToDelete) await unlink(f).catch(() => {});

        if (text.trim()) {
          // expandPromptTemplates dispatches slash commands spoken as "slash <cmd>"
          pi.sendUserMessage(voiceTextToInput(text), { expandPromptTemplates: true });
        } else {
          ctx.ui.notify("Voice: no speech detected", "warning");
        }
      } catch (err) {
        const msg = typeof err === "object" && err !== null && "message" in err
          ? (err as { message: string }).message
          : String(err);
        ctx.ui.notify(`Voice error: ${msg}`, "error");
      }
    },
  });

  // Intercept /voice command and transform into transcribed text
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("/voice")) return;

    const maxDuration = parseMaxDuration(event.text);
    ctx.ui.notify(`🎙 Listening... (speak now, stops after ${config.silenceDuration}s silence)`, "info");

    try {
      // Record with real-time silence detection
      const { filePath: tempFile, silenceEnd } = await recordAudio(maxDuration, config.micDevice, config.silenceDuration);
      let filesToDelete = [tempFile];

      // Trim to silence end if detected
      let audioFile = tempFile;
      if (silenceEnd !== undefined) {
        const trimmedFile = join(tmpdir(), `voice-trimmed-${Date.now()}.wav`);
        await trimAudio(tempFile, trimmedFile, silenceEnd);
        filesToDelete.push(trimmedFile);
        audioFile = trimmedFile;
      }

      // Transcribe
      const text = await transcribe(config.whisperUrl, audioFile);
      for (const f of filesToDelete) await unlink(f).catch(() => {});

      if (text.trim()) {
        const input = voiceTextToInput(text);
        if (input.startsWith("/")) {
          // Transform output is not re-checked for extension commands, so dispatch directly
          ctx.ui.notify(`Voice → ${input}`, "info");
          pi.sendUserMessage(input, { expandPromptTemplates: true });
          return { action: "handled" };
        }
        return { action: "transform", text: input };
      }

      ctx.ui.notify("Voice: no speech detected", "warning");
      return { action: "handled" };
    } catch (err) {
      // Clean up any temp files on error
      if (typeof filesToDelete !== "undefined") {
        for (const f of filesToDelete) await unlink(f).catch(() => {});
      }
      const msg = typeof err === "object" && err !== null && "message" in err
        ? (err as { message: string }).message
        : String(err);
      ctx.ui.notify(`Voice error: ${msg}`, "error");
      return { action: "handled" };
    }
  });
}
