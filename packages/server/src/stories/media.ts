import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { StoryError } from "./errors.js";

const execFileAsync = promisify(execFile);
// Instagramの上限の断定ではなく、このrelayの保守的な受け入れ制限。
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_MAX_SECONDS = 60;

export type StoryMedia = {
	assetPath: string;
	mimeType: "image/jpeg" | "image/png" | "video/mp4";
	size: number;
	sha256: string;
	width: number;
	height: number;
	durationSeconds: number | null;
};

const probeSchema = z.object({
	streams: z.array(
		z.object({
			codec_type: z.string(),
			codec_name: z.string(),
			width: z.number().optional(),
			height: z.number().optional(),
			duration: z.string().optional(),
		}),
	),
	format: z.object({ format_name: z.string(), duration: z.string().optional() }),
});

export const inspectProbe = (
	raw: unknown,
	mimeType: StoryMedia["mimeType"],
): Pick<StoryMedia, "width" | "height" | "durationSeconds"> => {
	const probe = probeSchema.safeParse(raw);
	if (!probe.success) throw new StoryError("MEDIA_INVALID", "素材の情報を読み取れません");
	const streams = probe.data.streams;
	const videos = streams.filter((stream) => stream.codec_type === "video");
	const video = videos[0];
	if (videos.length !== 1 || !video || !video.width || !video.height || video.width > 4096 || video.height > 4096) {
		throw new StoryError("MEDIA_INVALID", "素材の寸法または映像トラックが対応範囲外です");
	}
	if (mimeType !== "video/mp4") {
		if (streams.length !== 1 || video.codec_name !== (mimeType === "image/png" ? "png" : "mjpeg")) {
			throw new StoryError("MEDIA_INVALID", "画像の実体形式が一致しません");
		}
		return { width: video.width, height: video.height, durationSeconds: null };
	}
	const duration = Number(probe.data.format.duration ?? video.duration);
	const audio = streams.filter((stream) => stream.codec_type === "audio");
	if (
		!probe.data.format.format_name.split(",").includes("mp4") ||
		video.codec_name !== "h264" ||
		audio.length > 1 ||
		audio.some((stream) => stream.codec_name !== "aac") ||
		streams.length !== 1 + audio.length ||
		!Number.isFinite(duration) ||
		duration < 1 ||
		duration > VIDEO_MAX_SECONDS
	) {
		throw new StoryError("MEDIA_INVALID", "MP4はH.264映像・任意のAAC音声、1〜60秒で指定してください");
	}
	return { width: video.width, height: video.height, durationSeconds: duration };
};

export const probeMedia = async (assetPath: string, ffprobePath: string): Promise<unknown> => {
	try {
		const { stdout } = await execFileAsync(
			ffprobePath,
			["-v", "error", "-show_streams", "-show_format", "-of", "json", assetPath],
			{ timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
		);
		return JSON.parse(stdout);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new StoryError("MEDIA_PROBE_UNAVAILABLE", "ffprobeが見つかりません。stories.ffprobePathを設定してください");
		}
		throw new StoryError("MEDIA_INVALID", "素材を解析できません");
	}
};

const isWithin = (root: string, file: string): boolean => {
	const relative = path.relative(root, file);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const detectMime = (bytes: Buffer): StoryMedia["mimeType"] => {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
	throw new StoryError("MEDIA_INVALID", "JPEG・PNG・MP4の実体形式が必要です");
};

export const prepareMedia = async (
	filePath: string,
	roots: string[],
	assetDirectory: string,
	id: string,
	ffprobePath: string,
	probe: typeof probeMedia = probeMedia,
): Promise<StoryMedia> => {
	if (!path.isAbsolute(filePath)) throw new StoryError("INVALID_INPUT", "filePathは絶対パスで指定してください");
	let realFile: string;
	try {
		realFile = await fs.realpath(filePath);
	} catch {
		throw new StoryError("MEDIA_INVALID", "素材ファイルが見つかりません");
	}
	const realRoots = await Promise.all(
		roots.map(async (root) => {
			try {
				return await fs.realpath(root);
			} catch {
				throw new StoryError("MEDIA_NOT_ALLOWED", "許可ディレクトリが見つかりません");
			}
		}),
	);
	if (!realRoots.some((root) => isWithin(root, realFile)))
		throw new StoryError("MEDIA_NOT_ALLOWED", "素材が許可ディレクトリの範囲外です");
	const original = await fs.lstat(realFile);
	if (original.isSymbolicLink()) throw new StoryError("MEDIA_NOT_ALLOWED", "素材の参照先が変更されました");
	const handle = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
		throw new StoryError("MEDIA_INVALID", "素材を開けません");
	});
	let bytes: Buffer;
	try {
		const stat = await handle.stat();
		if (stat.dev !== original.dev || stat.ino !== original.ino)
			throw new StoryError("MEDIA_NOT_ALLOWED", "素材の参照先が変更されました");
		if (!stat.isFile() || stat.size === 0) throw new StoryError("MEDIA_INVALID", "空でない通常ファイルが必要です");
		if (stat.size > VIDEO_MAX_BYTES) throw new StoryError("MEDIA_TOO_LARGE", "素材の容量が上限を超えています");
		bytes = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
			throw new StoryError("MEDIA_INVALID", "読み取り中に素材が変更されました");
		bytes = bytes.subarray(0, offset);
		// リンク差し替えが起きた場合は受け入れず、以降は専用のコピーだけを使う。
		if ((await fs.realpath(filePath)) !== realFile)
			throw new StoryError("MEDIA_NOT_ALLOWED", "素材の参照先が変更されました");
	} finally {
		await handle.close();
	}
	const mimeType = detectMime(bytes);
	const extension = mimeType === "video/mp4" ? ".mp4" : mimeType === "image/png" ? ".png" : ".jpg";
	if (![extension, ...(extension === ".jpg" ? [".jpeg"] : [])].includes(path.extname(realFile).toLowerCase())) {
		throw new StoryError("MEDIA_INVALID", "拡張子と実体形式が一致しません");
	}
	if (mimeType !== "video/mp4" && bytes.length > IMAGE_MAX_BYTES)
		throw new StoryError("MEDIA_TOO_LARGE", "画像の上限は8MiBです");
	const assetPath = path.join(assetDirectory, `${id}${extension}`);
	await fs.mkdir(assetDirectory, { recursive: true });
	await fs.writeFile(assetPath, bytes, { flag: "wx" });
	try {
		const metadata = inspectProbe(await probe(assetPath, ffprobePath), mimeType);
		return {
			assetPath,
			mimeType,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			...metadata,
		};
	} catch (error) {
		await fs.unlink(assetPath).catch(() => undefined);
		throw error;
	}
};
