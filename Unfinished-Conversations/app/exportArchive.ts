// "Export my memories": one .zip holding every letter and transcript as plain
// text, every recording and photograph as its original file, and a
// memories.json with everything in a structured form. Built in the browser,
// so the archive never exists anywhere but on the person's own device.

import type { Entry } from "../shared";
import { api, mediaUrl } from "./lib";

type Export = {
	exportedAt: string;
	account: { name: string; email: string };
	lovedOnes: { name: string; entries: Entry[] }[];
	media: { id: string; kind: string; mime: string }[];
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal ZIP writer (stored, not compressed: recordings and photographs are already compressed). */
function zip(files: { path: string; bytes: Uint8Array }[]) {
	const encoder = new TextEncoder();
	const parts: BlobPart[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = encoder.encode(file.path);
		const crc = crc32(file.bytes);
		const header = new DataView(new ArrayBuffer(30));
		header.setUint32(0, 0x04034b50, true);
		header.setUint16(4, 20, true);
		header.setUint16(6, 0x0800, true); // file names are UTF-8
		header.setUint32(14, crc, true);
		header.setUint32(18, file.bytes.length, true);
		header.setUint32(22, file.bytes.length, true);
		header.setUint16(26, name.length, true);
		parts.push(header.buffer, name, file.bytes.buffer as ArrayBuffer);

		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, 20, true);
		entry.setUint16(6, 20, true);
		entry.setUint16(8, 0x0800, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, file.bytes.length, true);
		entry.setUint32(24, file.bytes.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(42, offset, true);
		directory.push(new Uint8Array(entry.buffer), name);
		offset += 30 + name.length + file.bytes.length;
	}
	const size = directory.reduce((sum, part) => sum + part.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	return new Blob([...parts, ...directory.map((d) => d.buffer as ArrayBuffer), end.buffer], { type: "application/zip" });
}

const safe = (value: string) => value.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "untitled";
const extension = (mime: string) => mime.split("/")[1].replace("x-m4a", "m4a").replace("mpeg", "mp3").replace("jpeg", "jpg");

export async function exportEverything(onProgress: (text: string) => void) {
	const data = await api<Export>("GET", "/export");
	const encoder = new TextEncoder();
	const files: { path: string; bytes: Uint8Array }[] = [{ path: "memories.json", bytes: encoder.encode(JSON.stringify(data, null, 2)) }];
	const mimes = new Map(data.media.map((m) => [m.id, m.mime]));

	const fetchMedia = async (assetId: string, path: string) => {
		const res = await fetch(mediaUrl(assetId), { credentials: "same-origin" });
		if (res.ok) files.push({ path: `${path}.${extension(mimes.get(assetId) ?? "application/octet-stream")}`, bytes: new Uint8Array(await res.arrayBuffer()) });
	};

	for (const loved of data.lovedOnes) {
		const folder = safe(loved.name);
		for (const [i, entry] of loved.entries.entries()) {
			onProgress(`Gathering ${loved.name}: ${i + 1} of ${loved.entries.length}`);
			const stem = `${folder}/${entry.createdAt.slice(0, 10)} ${safe(entry.title || entry.type)} ${entry.id.slice(0, 6)}`;
			const words = [entry.title, entry.content, entry.transcript && `Transcript:\n${entry.transcript}`].filter(Boolean).join("\n\n");
			if (words) files.push({ path: `${stem}.txt`, bytes: encoder.encode(words) });
			if (entry.audioAssetId) await fetchMedia(entry.audioAssetId, stem);
			for (const [n, photo] of entry.photos.entries()) await fetchMedia(photo.assetId, `${stem} photo ${n + 1}`);
		}
	}

	onProgress("Preparing your archive");
	const link = document.createElement("a");
	link.href = URL.createObjectURL(zip(files));
	link.download = `unfinished-conversations-${data.exportedAt.slice(0, 10)}.zip`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
