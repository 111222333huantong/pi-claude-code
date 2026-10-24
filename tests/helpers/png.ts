import { deflateSync } from "node:zlib";

/** CRC32（PNG chunk 校验）。 */
function crc32(buffer: Buffer): number {
	const table: number[] = [];
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	let crc = 0xffffffff;
	for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * 生成单色 PNG 的 base64（工具结果里的内联图片测试用）。
 * 宽高比决定内联图片在终端里占多少行，测试要的只是「不止 1 行」。
 */
export function solidPngBase64(width = 400, height = 300): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolor
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width * 3 + 1);
		raw[rowStart] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const offset = rowStart + 1 + x * 3;
			raw[offset] = 40;
			raw[offset + 1] = 90;
			raw[offset + 2] = 60;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}
